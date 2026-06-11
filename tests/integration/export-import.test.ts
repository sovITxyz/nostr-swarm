import { PassThrough, Readable } from 'node:stream'
import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import type { NostrSwarm } from '../../src/relay.js'
import { createSubs } from '../../src/storage/indexes.js'
import { runExport, runImport } from '../../src/tools/migrate.js'
import type { NostrEvent } from '../../src/util/types.js'
import {
	connectClient,
	createRelay,
	createSignedEvent,
	destroyTestnet,
	getTestnet,
	sendAndCollect,
	tempStorage,
} from '../helpers.js'

/** Rate limits high enough that import + polling never trip them */
const FAST_LIMITS = { eventRatePerSec: 1000, reqRatePerSec: 1000 }

let subCounter = 0

/** REQ events by id over an open client, fully draining the subscription (EOSE + CLOSED) */
async function queryIds(ws: WebSocket, ids: string[]): Promise<NostrEvent[]> {
	const subId = `ei-${subCounter++}`
	const results = await sendAndCollect(ws, ['REQ', subId, { ids }], 'EOSE')
	await sendAndCollect(ws, ['CLOSE', subId], 'CLOSED')
	return results.filter((m) => m[0] === 'EVENT').map((m) => m[2] as NostrEvent)
}

/**
 * Seed a storage directory the way pre-multiwriter releases did: an Autobase
 * whose apply wrote records into the events sub without any validation.
 * This is the only way invalid records (e.g. the legacy light-client forged
 * prune ops) ever landed in real views — the hardened EventStore apply can
 * no longer be made to store one, which is exactly what runExport's
 * validation filter exists to clean up.
 */
async function seedLegacyStore(dir: string, records: NostrEvent[]): Promise<void> {
	const corestore = new Corestore(dir)
	const base = new Autobase(corestore, null, {
		// biome-ignore lint/suspicious/noExplicitAny: untyped holepunch view store
		open: (store: any) =>
			new Hyperbee(store.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
		apply: async (nodes, view: Hyperbee) => {
			const subs = createSubs(view)
			for (const node of nodes) {
				if (node.value === null) continue
				const op = node.value as { type: string; event: NostrEvent }
				if (op.type === 'put') await subs.events.put(op.event.id, op.event)
			}
		},
		valueEncoding: 'json',
	})
	await base.ready()
	for (const event of records) {
		await base.append({ type: 'put', event })
	}
	// Let the sole indexer sign the materialized view so it persists across reopens
	await base.ack()
	await base.close()
	await corestore.close()
}

/** Run runExport against a collecting stream and return the JSONL plus counts */
async function exportToString(
	dir: string,
): Promise<{ jsonl: string; exported: number; skipped: number }> {
	const out = new PassThrough()
	const chunks: Buffer[] = []
	out.on('data', (chunk: Buffer) => chunks.push(chunk))
	const result = await runExport(dir, out)
	return { jsonl: Buffer.concat(chunks).toString('utf8'), ...result }
}

describe('export/import merge tooling (local testnet)', { timeout: 60_000 }, () => {
	let relay: NostrSwarm
	let ws: WebSocket
	let url: string
	let legacyDir: string
	let jsonl = ''
	const valid: NostrEvent[] = []
	let invalid: NostrEvent

	beforeAll(async () => {
		await getTestnet()

		// Three properly signed events plus one record whose signature no longer
		// verifies (content tampered after signing) — a stand-in for the invalid
		// records legacy non-validating stores could accumulate.
		for (let i = 0; i < 3; i++) {
			valid.push(createSignedEvent({ content: `legacy event ${i}` }).event)
		}
		const tampered = createSignedEvent({ content: 'forged' }).event
		invalid = { ...tampered, content: 'forged (tampered after signing)' }

		legacyDir = tempStorage()
		await seedLegacyStore(legacyDir, [...valid, invalid])

		relay = await createRelay({ relay: { ...FAST_LIMITS } })
		url = `ws://127.0.0.1:${relay.config.port}`
		ws = await connectClient(relay.config.port)
	}, 60_000)

	afterAll(async () => {
		ws?.close()
		await relay?.stop()
		await destroyTestnet()
	}, 60_000)

	it('exports every valid event as JSONL and drops the invalid record', async () => {
		const result = await exportToString(legacyDir)
		jsonl = result.jsonl

		const exported = jsonl
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as NostrEvent)

		expect(result.exported).toBe(valid.length)
		expect(exported).toHaveLength(valid.length)
		expect(exported.map((e) => e.id).sort()).toEqual(valid.map((e) => e.id).sort())
		expect(exported.map((e) => e.id)).not.toContain(invalid.id)

		// Events round-trip losslessly through the JSONL encoding (JSON-clone the
		// expectation: nostr-tools tags in-memory events with a verified symbol)
		const byId = new Map(exported.map((e) => [e.id, e]))
		for (const event of valid) {
			expect(byId.get(event.id)).toEqual(JSON.parse(JSON.stringify(event)))
		}
	})

	it('imports the dump through the validated WS path; bad lines are rejected, not fatal', async () => {
		// Prepend a malformed line and a structurally valid but badly signed
		// event: both must be counted rejected without aborting the run.
		const input = `not json at all\n${JSON.stringify(invalid)}\n${jsonl}`
		const result = await runImport(url, Readable.from([input]))

		expect(result.imported).toBe(valid.length)
		expect(result.duplicates).toBe(0)
		expect(result.rejected).toBe(2)

		const got = await queryIds(
			ws,
			valid.map((e) => e.id),
		)
		expect(got.map((e) => e.id).sort()).toEqual(valid.map((e) => e.id).sort())

		// The bad-signature record was refused by the relay, not stored
		expect(await queryIds(ws, [invalid.id])).toHaveLength(0)
	})

	it('re-importing the same dump is idempotent', async () => {
		const result = await runImport(url, Readable.from([jsonl]))

		// Replay succeeds end-to-end: every event is acked (OK true or a
		// 'duplicate:' OK — both count as success), nothing is rejected.
		expect(result.rejected).toBe(0)
		expect(result.imported + result.duplicates).toBe(valid.length)

		// Still exactly one copy of each event in the store
		const got = await queryIds(
			ws,
			valid.map((e) => e.id),
		)
		expect(got).toHaveLength(valid.length)
		let stored = 0
		for await (const _ of relay.store.indexes.events.createReadStream()) stored++
		expect(stored).toBe(valid.length)
	})

	it('rejects on connection failure (CLI maps this to a non-zero exit)', async () => {
		await expect(runImport('ws://127.0.0.1:1', Readable.from([jsonl]))).rejects.toThrow()
	})

	it('refuses to export a nonexistent storage directory', async () => {
		await expect(runExport(`${legacyDir}-does-not-exist`)).rejects.toThrow(
			/storage directory not found/,
		)
	})
})
