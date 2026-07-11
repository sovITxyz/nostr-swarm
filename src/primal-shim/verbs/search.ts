/** Content search via the relay's NIP-50 substring matching. */

import type { NostrFilter } from '../../util/types.js'
import type { VerbHandler } from '../handler.js'
import { clampLimit, optionalHex64, optionalUnixTime } from '../handler.js'
import { hydrateNotes } from '../hydrate.js'
import { encodeFeedRange } from '../synth.js'

export const search: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const query = typeof record.query === 'string' ? record.query.trim() : ''
	if (query.length === 0) {
		yield encodeFeedRange([])
		return
	}
	const filter: NostrFilter = {
		kinds: [1],
		search: query,
		limit: clampLimit(record.limit, 20, 100),
	}
	const until = optionalUnixTime(record.until)
	const since = optionalUnixTime(record.since)
	if (until !== undefined) filter.until = until
	if (since !== undefined) filter.since = since

	const found = await ctx.relay.fetch([filter])
	found.sort((a, b) => b.created_at - a.created_at)
	yield* hydrateNotes(found, ctx, {
		userPubkey: optionalHex64(record.user_pubkey),
		includeRange: true,
	})
}

/**
 * advanced_feed with an advanced_search specification: degrade by running the
 * bare words of the query through NIP-50. Payload: {specification, limit, ...}.
 */
export const advancedFeed: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const spec = record.specification
	let query = ''
	if (Array.isArray(spec) && spec[0] === 'advanced_search') {
		const inner = spec[1] as Record<string, unknown> | undefined
		if (typeof inner?.query === 'string') {
			// Strip search operators (from:, since:, #tag quotes...) down to bare words
			query = inner.query
				.replace(/\b\w+:[^\s]+/g, ' ')
				.replace(/["()]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
		}
	}
	if (query.length === 0) {
		yield encodeFeedRange([])
		return
	}
	yield* search({ ...record, query }, ctx)
}
