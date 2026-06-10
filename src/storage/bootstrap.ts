/**
 * Bootstrap-key persistence guard (docs/design/multiwriter-sync.md §3.1).
 *
 * `<storagePath>/bootstrap-key` records which Autobase this storage directory
 * belongs to. Once recorded, a conflicting configured key is a fatal startup
 * error — accidental re-founding (and the resulting permanent split-brain)
 * becomes impossible after first start.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeInvite, parseBootstrap } from '../util/invite.js'

const BOOTSTRAP_FILE = 'bootstrap-key'
const KEYS_FILE = 'keys.json'
const HEX64 = /^[0-9a-f]{64}$/

function bootstrapFilePath(storagePath: string): string {
	return join(storagePath, BOOTSTRAP_FILE)
}

/** Read the persisted base key, or null if this storage dir has never started */
function readPersistedKey(storagePath: string): Buffer | null {
	const file = bootstrapFilePath(storagePath)
	if (!existsSync(file)) return null
	const raw = readFileSync(file, 'utf8').trim().toLowerCase()
	if (!HEX64.test(raw)) {
		throw new Error(`corrupted bootstrap-key file at ${file}: expected 64 hex chars`)
	}
	return Buffer.from(raw, 'hex')
}

/**
 * Resolve the Autobase bootstrap key for a storage directory.
 *
 * - persisted key exists && configured key differs -> throw (fatal, explicit)
 * - persisted key exists                           -> return persisted key
 * - configured only                                -> persist it, return it
 * - neither                                        -> null (founder; caller
 *   persists base.key via persistBootstrapKey once the base is ready)
 *
 * `configured` is the raw RelayConfig.bootstrap value: '' | 'nsw1…' | 64-hex.
 * Invalid values throw via parseBootstrap.
 */
export function resolveBootstrap(storagePath: string, configured: string): Buffer | null {
	const configuredKey = parseBootstrap(configured)
	const persisted = readPersistedKey(storagePath)
	if (persisted) {
		if (configuredKey && !configuredKey.equals(persisted)) {
			throw new Error(
				`bootstrap key mismatch: ${bootstrapFilePath(storagePath)} records base ${persisted.toString('hex')} but the configured bootstrap resolves to ${configuredKey.toString('hex')}. This storage directory belongs to the recorded base; refusing to start. To join a different base, use a fresh storage path (migrate data with export/import).`,
			)
		}
		return persisted
	}
	if (configuredKey) {
		persistBootstrapKey(storagePath, configuredKey)
		return configuredKey
	}
	return null
}

/** Record the base key this storage directory belongs to (idempotent) */
export function persistBootstrapKey(storagePath: string, key: Buffer): void {
	mkdirSync(storagePath, { recursive: true })
	writeFileSync(bootstrapFilePath(storagePath), `${key.toString('hex')}\n`)
}

/**
 * Write `<storagePath>/keys.json` with the node's shareable identity:
 * { baseKey: hex, invite: 'nsw1…', writerKey: hex }
 * (surfaced by Start9 properties; writerKey is what an operator sends
 * out-of-band to get admitted as a writer).
 */
export function writeKeysFile(storagePath: string, baseKey: Buffer, writerKey: Buffer): void {
	mkdirSync(storagePath, { recursive: true })
	const keys = {
		baseKey: baseKey.toString('hex'),
		invite: encodeInvite(baseKey),
		writerKey: writerKey.toString('hex'),
	}
	writeFileSync(join(storagePath, KEYS_FILE), `${JSON.stringify(keys, null, '\t')}\n`)
}
