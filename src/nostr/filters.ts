import type { NostrEvent, NostrFilter } from '../util/types.js'

/** Validate a filter object structure */
export function validateFilter(filter: unknown): filter is NostrFilter {
	if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return false
	const f = filter as Record<string, unknown>

	if (f.ids !== undefined && !isStringArray(f.ids)) return false
	if (f.authors !== undefined && !isStringArray(f.authors)) return false
	if (f.kinds !== undefined && !isNumberArray(f.kinds)) return false
	if (f.since !== undefined && typeof f.since !== 'number') return false
	if (f.until !== undefined && typeof f.until !== 'number') return false
	if (f.limit !== undefined && (typeof f.limit !== 'number' || f.limit < 0)) return false
	if (f.search !== undefined && typeof f.search !== 'string') return false

	// Validate tag filters (#e, #p, etc.)
	for (const key of Object.keys(f)) {
		if (key.startsWith('#')) {
			if (key.length !== 2) return false // only single-letter tag filters
			if (!isStringArray(f[key])) return false
		}
	}

	return true
}

/** Check if a single event matches a single filter (AND logic within filter) */
export function matchFilter(filter: NostrFilter, event: NostrEvent): boolean {
	if (filter.ids && !filter.ids.some((id) => event.id.startsWith(id))) return false
	if (filter.authors && !filter.authors.some((a) => event.pubkey.startsWith(a))) return false
	if (filter.kinds && !filter.kinds.includes(event.kind)) return false
	if (filter.since !== undefined && event.created_at < filter.since) return false
	if (filter.until !== undefined && event.created_at > filter.until) return false

	// Tag filters
	for (const key of Object.keys(filter)) {
		if (key.startsWith('#') && key.length === 2) {
			const tagName = key[1]!
			const filterValues = filter[key as `#${string}`]
			if (filterValues && filterValues.length > 0) {
				const eventTagValues = event.tags.filter((t) => t[0] === tagName).map((t) => t[1])
				if (!filterValues.some((v) => eventTagValues.includes(v))) return false
			}
		}
	}

	return true
}

/** Check if an event matches any of the filters (OR logic across filters) */
export function matchFilters(filters: NostrFilter[], event: NostrEvent): boolean {
	return filters.some((f) => matchFilter(f, event))
}

function isStringArray(val: unknown): val is string[] {
	return Array.isArray(val) && val.every((v) => typeof v === 'string')
}

function isNumberArray(val: unknown): val is number[] {
	return Array.isArray(val) && val.every((v) => typeof v === 'number')
}
