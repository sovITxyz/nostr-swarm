import type Hyperbee from 'hyperbee'
import { isExpired } from '../nostr/events.js'
import { matchFilter } from '../nostr/filters.js'
import { encodeKind, eventKey, invertTimestamp } from '../util/keys.js'
import type { NostrEvent, NostrFilter } from '../util/types.js'
import type { IndexSubs } from './indexes.js'

interface QueryResult {
	events: NostrEvent[]
	count: number
}

/** Execute a single filter against the indexed store */
export async function queryFilter(
	subs: IndexSubs,
	filter: NostrFilter,
	limitOverride?: number,
): Promise<QueryResult> {
	const limit = limitOverride ?? filter.limit ?? 500
	const events: NostrEvent[] = []
	const seen = new Set<string>()

	// Strategy: choose the most selective index, scan every value with a
	// per-value match cap, then merge-sort newest-first and slice to the limit.
	// Work is bounded by values × limit.

	if (filter.ids && filter.ids.length > 0 && filter.ids.every((id) => id.length === 64)) {
		// Direct ID lookup — O(1) per full-length ID. Prefix or mixed-length id
		// filters fall through to the scans below, where matchFilter's
		// startsWith comparison handles them.
		for (const id of filter.ids) {
			if (seen.has(id)) continue
			const entry = await subs.events.get(eventKey(id))
			if (!entry) continue
			const event = entry.value as NostrEvent
			if (isExpired(event)) continue
			if (matchFilter(filter, event)) {
				events.push(event)
				seen.add(id)
			}
		}
		return finalize(events, limit)
	}

	if (filter.authors && filter.authors.length > 0 && filter.kinds && filter.kinds.length > 0) {
		// author+kind index — most selective compound index
		for (const author of filter.authors) {
			for (const kind of filter.kinds) {
				const prefix = `${author}!${encodeKind(kind)}`
				const range = timeRangeForPrefix(prefix, filter.since, filter.until)
				await scanIndex(subs.authorKind, range, subs.events, filter, events, seen, limit)
			}
		}
		return finalize(events, limit)
	}

	if (filter.authors && filter.authors.length > 0) {
		// author index
		for (const author of filter.authors) {
			const range = timeRangeForPrefix(author, filter.since, filter.until)
			await scanIndex(subs.author, range, subs.events, filter, events, seen, limit)
		}
		return finalize(events, limit)
	}

	if (filter.kinds && filter.kinds.length > 0) {
		// kind index
		for (const kind of filter.kinds) {
			const prefix = encodeKind(kind)
			const range = timeRangeForPrefix(prefix, filter.since, filter.until)
			await scanIndex(subs.kind, range, subs.events, filter, events, seen, limit)
		}
		return finalize(events, limit)
	}

	// Check for tag filters
	const tagFilters = getTagFilters(filter)
	if (tagFilters.length > 0) {
		// Use the first tag filter as the primary index scan
		const [tagName, tagValues] = tagFilters[0]!
		for (const tagValue of tagValues) {
			const prefix = `${tagName}!${tagValue}`
			const range = timeRangeForPrefix(prefix, filter.since, filter.until)
			await scanIndex(subs.tag, range, subs.events, filter, events, seen, limit)
		}
		return finalize(events, limit)
	}

	// Fallback: created_at index (global time scan)
	const range = timeRangeForCreatedAt(filter.since, filter.until)
	await scanIndex(subs.createdAt, range, subs.events, filter, events, seen, limit)
	return finalize(events, limit)
}

/** Execute multiple filters (OR logic) and deduplicate */
export async function queryFilters(subs: IndexSubs, filters: NostrFilter[]): Promise<NostrEvent[]> {
	const allEvents: NostrEvent[] = []
	const seen = new Set<string>()

	for (const filter of filters) {
		const result = await queryFilter(subs, filter)
		for (const event of result.events) {
			if (!seen.has(event.id)) {
				allEvents.push(event)
				seen.add(event.id)
			}
		}
	}

	// Sort newest-first, then by ID for ties
	allEvents.sort(compareNewestFirst)

	return allEvents
}

/** Count matching events for multiple filters */
export async function countFilters(subs: IndexSubs, filters: NostrFilter[]): Promise<number> {
	const seen = new Set<string>()
	let count = 0

	for (const filter of filters) {
		// Use a high limit for counting
		const result = await queryFilter(subs, filter, 100_000)
		for (const event of result.events) {
			if (!seen.has(event.id)) {
				seen.add(event.id)
				count++
			}
		}
	}

	return count
}

// ─── Internal Helpers ────────────────────────────────────────────

/** Newest-first comparator: created_at desc, then id asc for ties */
function compareNewestFirst(a: NostrEvent, b: NostrEvent): number {
	if (a.created_at !== b.created_at) return b.created_at - a.created_at
	return a.id < b.id ? -1 : 1
}

/** Sort collected events newest-first and truncate to the filter limit */
function finalize(events: NostrEvent[], limit: number): QueryResult {
	events.sort(compareNewestFirst)
	const sliced = events.length > limit ? events.slice(0, limit) : events
	return { events: sliced, count: sliced.length }
}

/**
 * Scan an index sub-db, resolve event IDs, post-filter, collect results.
 * `matchCap` bounds the matches added by THIS invocation — each index value
 * gets its own budget so a multi-value filter never starves later values.
 * `results`/`seen` stay shared across invocations for cross-value dedup.
 */
async function scanIndex(
	indexSub: Hyperbee,
	range: Record<string, string>,
	eventsSub: Hyperbee,
	filter: NostrFilter,
	results: NostrEvent[],
	seen: Set<string>,
	matchCap: number,
): Promise<void> {
	const stream = indexSub.createReadStream(range)
	let matched = 0

	for await (const entry of stream) {
		if (matched >= matchCap) break
		const eventId = entry.value as string
		if (seen.has(eventId)) continue

		const eventEntry = await eventsSub.get(eventKey(eventId))
		if (!eventEntry) continue

		const event = eventEntry.value as NostrEvent
		// NIP-40: never serve expired-but-not-yet-reclaimed events, and don't
		// let them consume the match budget.
		if (isExpired(event)) continue
		if (matchFilter(filter, event)) {
			results.push(event)
			seen.add(eventId)
			matched++
		}
	}
}

/** Build time-bounded range for a prefix-based index */
function timeRangeForPrefix(
	prefix: string,
	since?: number,
	until?: number,
): Record<string, string> {
	const range: Record<string, string> = {}

	if (until !== undefined) {
		// until → smallest inverted time (gte bound)
		range.gte = `${prefix}!${invertTimestamp(until)}`
	} else {
		range.gte = `${prefix}!`
	}

	if (since !== undefined) {
		// since → largest inverted time (lte bound)
		range.lte = `${prefix}!${invertTimestamp(since)}~`
	} else {
		range.lt = `${prefix}~`
	}

	return range
}

/** Build time-bounded range for the global created_at index */
function timeRangeForCreatedAt(since?: number, until?: number): Record<string, string> {
	const range: Record<string, string> = {}

	if (until !== undefined) {
		range.gte = invertTimestamp(until)
	} else {
		range.gte = ''
	}

	if (since !== undefined) {
		range.lte = `${invertTimestamp(since)}~`
	} else {
		range.lt = '~'
	}

	return range
}

/** Extract tag filter entries from a NIP-01 filter */
function getTagFilters(filter: NostrFilter): Array<[string, string[]]> {
	const result: Array<[string, string[]]> = []
	for (const key of Object.keys(filter)) {
		if (key.startsWith('#') && key.length === 2) {
			const values = filter[key as `#${string}`]
			if (values && values.length > 0) {
				result.push([key[1]!, values])
			}
		}
	}
	return result
}
