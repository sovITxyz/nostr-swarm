/**
 * Per-event engagement stats synthesized from relay queries.
 *
 * One batched REQ hydrates every uncached id on a page (kinds 1/6/7/9735
 * referencing the ids via #e), classified in memory — never one query per
 * event. Counts saturate at the relay's per-query limit (default 500 combined
 * interactions per page); accepted for MVP.
 */

import type { NostrEvent } from '../util/types.js'
import { LruCache } from './lru.js'
import { type EventStats, emptyStats } from './synth.js'
import type { RelayClient } from './upstream.js'

/** Sats carried by a zap receipt, from the amount tag of the embedded zap request */
export function zapAmountSats(zapReceipt: NostrEvent): number {
	try {
		const description = zapReceipt.tags.find((t) => t[0] === 'description')?.[1]
		if (!description) return 0
		const request = JSON.parse(description) as { tags?: string[][] }
		const amount = request.tags?.find((t) => t[0] === 'amount')?.[1]
		const msats = Number.parseInt(amount ?? '', 10)
		return Number.isNaN(msats) || msats < 0 ? 0 : Math.floor(msats / 1000)
	} catch {
		return 0
	}
}

/** All event ids an interaction event references via e-tags */
function referencedIds(event: NostrEvent): string[] {
	const ids: string[] = []
	for (const tag of event.tags) {
		if (tag[0] === 'e' && typeof tag[1] === 'string' && tag[1].length === 64) {
			ids.push(tag[1])
		}
	}
	return ids
}

/** Classify one interaction event into the stats of every id it references */
export function tallyInteraction(event: NostrEvent, stats: Map<string, EventStats>): void {
	const sats = event.kind === 9735 ? zapAmountSats(event) : 0
	for (const id of new Set(referencedIds(event))) {
		const entry = stats.get(id)
		if (!entry) continue
		switch (event.kind) {
			case 1:
				entry.replies++
				break
			case 6:
				entry.reposts++
				break
			case 7:
				entry.likes++
				break
			case 9735:
				entry.zaps++
				entry.satszapped += sats
				break
		}
		entry.score = entry.likes + entry.reposts + 2 * entry.replies + 2 * entry.zaps
		entry.score24h = entry.score
	}
}

export class StatsService {
	private readonly cache: LruCache<string, EventStats>

	constructor(
		private readonly relay: RelayClient,
		opts: { ttlMs: number; maxEntries: number },
	) {
		this.cache = new LruCache(opts.maxEntries, opts.ttlMs)
	}

	async getStats(eventIds: string[]): Promise<Map<string, EventStats>> {
		const result = new Map<string, EventStats>()
		const uncached: string[] = []
		for (const id of new Set(eventIds)) {
			const cached = this.cache.get(id)
			if (cached) result.set(id, cached)
			else uncached.push(id)
		}
		if (uncached.length === 0) return result

		const fresh = new Map<string, EventStats>()
		for (const id of uncached) fresh.set(id, emptyStats(id))

		const interactions = await this.relay.fetch([
			{ kinds: [1, 6, 7, 9735], '#e': uncached, limit: 500 },
		])
		for (const event of interactions) {
			tallyInteraction(event, fresh)
		}
		for (const [id, stats] of fresh) {
			this.cache.set(id, stats)
			result.set(id, stats)
		}
		return result
	}
}
