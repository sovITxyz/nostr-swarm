/**
 * Notifications "seen until" persistence.
 *
 * Kept shim-local (not in the relay) because writing it as events would
 * require the shim to hold a Nostr identity and silently break on read-only
 * replica nodes. A tiny JSON file with atomic replace is durable enough.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../util/logger.js'

export interface SeenStore {
	/** Unix seconds the user last marked notifications seen; 0 if never */
	get(pubkey: string): number
	set(pubkey: string, ts: number): Promise<void>
}

export class JsonSeenStore implements SeenStore {
	private readonly file: string
	private readonly seen = new Map<string, number>()
	private writeQueue: Promise<void> = Promise.resolve()

	constructor(dataDir: string) {
		mkdirSync(dataDir, { recursive: true })
		this.file = join(dataDir, 'last-seen.json')
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'))
			if (parsed && typeof parsed === 'object') {
				for (const [pubkey, ts] of Object.entries(parsed)) {
					if (typeof ts === 'number' && Number.isFinite(ts)) this.seen.set(pubkey, ts)
				}
			}
		} catch {
			// first run or unreadable file — start empty
		}
	}

	get(pubkey: string): number {
		return this.seen.get(pubkey) ?? 0
	}

	async set(pubkey: string, ts: number): Promise<void> {
		if (!Number.isFinite(ts) || ts <= this.get(pubkey)) return
		this.seen.set(pubkey, ts)
		// Serialize writes: last snapshot wins, tmp+rename keeps the file whole
		this.writeQueue = this.writeQueue.then(async () => {
			const tmp = `${this.file}.tmp`
			try {
				await writeFile(tmp, JSON.stringify(Object.fromEntries(this.seen)), 'utf-8')
				await rename(tmp, this.file)
			} catch (err) {
				logger.warn('Failed to persist notifications seen-state', { error: String(err) })
			}
		})
		await this.writeQueue
	}
}
