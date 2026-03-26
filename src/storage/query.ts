import { matchFilter } from '../nostr/filters.js'
import {
	authorKindKey,
	authorKey,
	createdAtKey,
	encodeKind,
	eventKey,
	invertTimestamp,
	kindKey,
	prefixRange,
	tagKey,
} from '../util/keys.js'
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

	// Strategy: choose the most selective index, scan, post-filter the rest

	if (filter.ids && filter.ids.length > 0) {
		// Direct ID lookup — O(1) per ID
		for (const id of filter.ids) {
			if (events.length >= limit) break
			const entry = await subs.events.get(eventKey(id))
			if (entry && !seen.has(id)) {
				const event = entry.value as NostrEvent
				if (matchFilter(filter, event)) {
					events.push(event)
					seen.add(id)
				}
			}
		}
		return { events, count: events.length }
	}

	if (filter.authors && filter.authors.length > 0 && filter.kinds && filter.kinds.length > 0) {
		// author+kind index — most selective compound index
		for (const author of filter.authors) {
			for (const kind of filter.kinds) {
				if (events.length >= limit) break
				const prefix = `${author}!${encodeKind(kind)}`
				const range = timeRangeForPrefix(prefix, filter.since, filter.until)
				await scanIndex(subs.authorKind, range, subs.events, filter, events, seen, limit)
			}
		}
		return { events, count: events.length }
	}

	if (filter.authors && filter.authors.length > 0) {
		// author index
		for (const author of filter.authors) {
			if (events.length >= limit) break
			const range = timeRangeForPrefix(author, filter.since, filter.until)
			await scanIndex(subs.author, range, subs.events, filter, events, seen, limit)
		}
		return { events, count: events.length }
	}

	if (filter.kinds && filter.kinds.length > 0) {
		// kind index
		for (const kind of filter.kinds) {
			if (events.length >= limit) break
			const prefix = encodeKind(kind)
			const range = timeRangeForPrefix(prefix, filter.since, filter.until)
			await scanIndex(subs.kind, range, subs.events, filter, events, seen, limit)
		}
		return { events, count: events.length }
	}

	// Check for tag filters
	const tagFilters = getTagFilters(filter)
	if (tagFilters.length > 0) {
		// Use the first tag filter as the primary index scan
		const [tagName, tagValues] = tagFilters[0]!
		for (const tagValue of tagValues) {
			if (events.length >= limit) break
			const prefix = `${tagName}!${tagValue}`
			const range = timeRangeForPrefix(prefix, filter.since, filter.until)
			await scanIndex(subs.tag, range, subs.events, filter, events, seen, limit)
		}
		return { events, count: events.length }
	}

	// Fallback: created_at index (global time scan)
	const range = timeRangeForCreatedAt(filter.since, filter.until)
	await scanIndex(subs.createdAt, range, subs.events, filter, events, seen, limit)
	return { events, count: events.length }
}

/** Execute multiple filters (OR logic) and deduplicate */
export async function queryFilters(
	subs: IndexSubs,
	filters: NostrFilter[],
): Promise<NostrEvent[]> {
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
	allEvents.sort((a, b) => {
		if (a.created_at !== b.created_at) return b.created_at - a.created_at
		return a.id < b.id ? -1 : 1
	})

	return allEvents
}

/** Count matching events for multiple filters */
export async function countFilters(
	subs: IndexSubs,
	filters: NostrFilter[],
): Promise<number> {
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

/** Scan an index sub-db, resolve event IDs, post-filter, collect results */
async function scanIndex(
	indexSub: any,
	range: Record<string, string>,
	eventsSub: any,
	filter: NostrFilter,
	results: NostrEvent[],
	seen: Set<string>,
	limit: number,
): Promise<void> {
	const stream = indexSub.createReadStream(range)

	for await (const entry of stream) {
		if (results.length >= limit) break
		const eventId = entry.value as string
		if (seen.has(eventId)) continue

		const eventEntry = await eventsSub.get(eventKey(eventId))
		if (!eventEntry) continue

		const event = eventEntry.value as NostrEvent
		if (matchFilter(filter, event)) {
			results.push(event)
			seen.add(eventId)
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
