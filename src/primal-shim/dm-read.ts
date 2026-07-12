/**
 * DM read-watermark persistence.
 *
 * Unread counts can't be derived from relay events alone — they need a
 * per-(user, sender) "last read" timestamp that the reset verbs advance. Kept
 * shim-local (JSON file, atomic replace) for the same reason as the
 * notifications seen-state: writing it to the relay would need a shim identity
 * and break on read-only replicas.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../util/logger.js'

/** Sentinel sender key for a "mark all as read" watermark */
export const DM_ALL_SENDERS = '*'

export interface DmReadStore {
	/** Watermark (unix seconds) for messages from `sender` to `user`; 0 if never */
	get(user: string, sender: string): number
	/** Advance the watermark for one sender (or DM_ALL_SENDERS for mark-all) */
	set(user: string, sender: string, ts: number): Promise<void>
}

export class JsonDmReadStore implements DmReadStore {
	private readonly file: string
	private readonly marks = new Map<string, number>()
	private writeQueue: Promise<void> = Promise.resolve()

	constructor(dataDir: string) {
		mkdirSync(dataDir, { recursive: true })
		this.file = join(dataDir, 'dm-read.json')
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'))
			if (parsed && typeof parsed === 'object') {
				for (const [key, ts] of Object.entries(parsed)) {
					if (typeof ts === 'number' && Number.isFinite(ts)) this.marks.set(key, ts)
				}
			}
		} catch {
			// first run or unreadable file — start empty
		}
	}

	private key(user: string, sender: string): string {
		return `${user}:${sender}`
	}

	get(user: string, sender: string): number {
		// A message is "read" if it predates either the per-sender or the mark-all watermark
		const perSender = this.marks.get(this.key(user, sender)) ?? 0
		const all = this.marks.get(this.key(user, DM_ALL_SENDERS)) ?? 0
		return Math.max(perSender, all)
	}

	async set(user: string, sender: string, ts: number): Promise<void> {
		if (!Number.isFinite(ts)) return
		const key = this.key(user, sender)
		if (ts <= (this.marks.get(key) ?? 0)) return
		this.marks.set(key, ts)
		this.writeQueue = this.writeQueue.then(async () => {
			const tmp = `${this.file}.tmp`
			try {
				await writeFile(tmp, JSON.stringify(Object.fromEntries(this.marks)), 'utf-8')
				await rename(tmp, this.file)
			} catch (err) {
				logger.warn('Failed to persist DM read-state', { error: String(err) })
			}
		})
		await this.writeQueue
	}
}
