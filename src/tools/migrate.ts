/**
 * Export/import merge tooling (docs/design/multiwriter-sync.md §3.5).
 *
 * Merging two already-populated bases is an explicit operator action:
 * `runExport` dumps every event from an old storage directory as JSONL
 * (from a read-only view open — nothing is appended, no keys are written),
 * and `runImport` replays a JSONL dump through the normal validated WS path
 * of a node admitted to the canonical base. Events are self-certifying and
 * id-deduped in applyPut, so replay is idempotent.
 */

import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'
import { validateEventStructure, verifyEventSignature } from '../nostr/events.js'
import { resolveBootstrap } from '../storage/bootstrap.js'
import { EventStore } from '../storage/store.js'
import type { NostrEvent } from '../util/types.js'

export interface ExportResult {
	/** Events written to the output as JSONL lines */
	exported: number
	/** Records in the events sub that failed validation and were dropped */
	skipped: number
}

export interface ImportResult {
	/** Events the relay acknowledged with OK true */
	imported: number
	/** Events the relay reported as already stored ('duplicate:' prefix — success) */
	duplicates: number
	/** Malformed lines plus events the relay refused */
	rejected: number
}

/** How long to wait for the OK reply to a single EVENT */
const OK_TIMEOUT_MS = 30_000
/** Backoff between resends when the relay replies 'rate-limited:' */
const RATE_LIMIT_RETRY_MS = 1_000
/** Give up on a single event after this many rate-limited resends */
const MAX_RATE_LIMIT_RETRIES = 60

/**
 * Stream every valid event from a storage directory's events sub as JSONL.
 *
 * The view open is read-only in effect: no event ops are appended, and
 * resolveBootstrap with an empty configured value never creates files —
 * a legacy (pre-multiwriter) dir reopens its own founded base, a
 * post-upgrade dir reopens the base recorded in its bootstrap-key file.
 *
 * Records failing validateEventStructure/verifyEventSignature are skipped:
 * legacy stores predate apply-side validation and may hold invalid records
 * (e.g. forged unsigned prune ops from old light-client code).
 */
export async function runExport(
	storageDir: string,
	out: NodeJS.WritableStream = process.stdout,
): Promise<ExportResult> {
	if (!existsSync(storageDir)) {
		throw new Error(`storage directory not found: ${storageDir}`)
	}
	const store = new EventStore(storageDir, resolveBootstrap(storageDir, ''))
	try {
		await store.ready()
		// Drain any un-indexed local tail into the view before reading it
		await store.update()

		let exported = 0
		let skipped = 0
		for await (const entry of store.indexes.events.createReadStream()) {
			const event = entry.value as NostrEvent
			if (!validateEventStructure(event) || !verifyEventSignature(event)) {
				skipped++
				continue
			}
			if (!out.write(`${JSON.stringify(event)}\n`)) {
				await new Promise<void>((resolve) => out.once('drain', () => resolve()))
			}
			exported++
		}
		return { exported, skipped }
	} finally {
		await store.close()
	}
}

/**
 * Read JSONL events and publish each one as a NIP-01 EVENT over a relay's
 * WebSocket endpoint, awaiting the OK reply before sending the next.
 *
 * Throws on connection failure (the CLI maps that to a non-zero exit).
 * Per-event refusals never abort the run: 'duplicate:' OKs count as success
 * (idempotent replay), 'rate-limited:' OKs trigger a backoff-and-resend, and
 * anything else is counted as rejected and reported on stderr.
 */
export async function runImport(
	url: string,
	input: NodeJS.ReadableStream = process.stdin,
): Promise<ImportResult> {
	const ws = new WebSocket(url)
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve())
		ws.once('error', reject)
	})
	// Errors mid-run surface through the per-OK waiters; never crash on 'error'
	ws.on('error', () => {})

	const result: ImportResult = { imported: 0, duplicates: 0, rejected: 0 }
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
	try {
		for await (const line of lines) {
			const trimmed = line.trim()
			if (trimmed.length === 0) continue

			let event: NostrEvent | null = null
			try {
				const parsed: unknown = JSON.parse(trimmed)
				if (validateEventStructure(parsed)) event = parsed
			} catch {
				// fall through to the rejection below
			}
			if (!event) {
				result.rejected++
				process.stderr.write('import: skipping malformed JSONL line\n')
				continue
			}

			let retries = 0
			for (;;) {
				ws.send(JSON.stringify(['EVENT', event]))
				const { accepted, reason } = await waitForOk(ws, event.id)
				if (accepted || reason.startsWith('duplicate:')) {
					if (reason.startsWith('duplicate:')) result.duplicates++
					else result.imported++
					break
				}
				if (reason.startsWith('rate-limited:') && retries < MAX_RATE_LIMIT_RETRIES) {
					retries++
					await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS))
					continue
				}
				result.rejected++
				process.stderr.write(`import: event ${event.id} rejected: ${reason}\n`)
				break
			}
		}
		return result
	} finally {
		lines.close()
		ws.close()
	}
}

/** Wait for the OK reply matching one event id, ignoring AUTH/NOTICE/other frames */
function waitForOk(ws: WebSocket, eventId: string): Promise<{ accepted: boolean; reason: string }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error(`timed out waiting for OK for event ${eventId}`))
		}, OK_TIMEOUT_MS)

		function onMessage(data: WebSocket.RawData): void {
			let msg: unknown
			try {
				msg = JSON.parse(data.toString())
			} catch {
				return
			}
			if (!Array.isArray(msg) || msg[0] !== 'OK' || msg[1] !== eventId) return
			cleanup()
			resolve({
				accepted: msg[2] === true,
				reason: typeof msg[3] === 'string' ? msg[3] : '',
			})
		}
		function onClose(): void {
			cleanup()
			reject(new Error('connection closed while awaiting OK'))
		}
		function onError(err: Error): void {
			cleanup()
			reject(err)
		}
		function cleanup(): void {
			clearTimeout(timer)
			ws.off('message', onMessage)
			ws.off('close', onClose)
			ws.off('error', onError)
		}

		ws.on('message', onMessage)
		ws.once('close', onClose)
		ws.once('error', onError)
	})
}
