/**
 * Feed verbs: mega_feed_directive / multi_kind_mega_feed_directive /
 * long_form_content_feed. The spec strings honored here form a closed loop
 * with the catalog advertised by get_home_feeds/get_reads_feeds (synth.ts),
 * plus the profile feed specs the client hardcodes.
 */

import type { NostrEvent, NostrFilter } from '../../util/types.js'
import type { VerbContext, VerbHandler } from '../handler.js'
import { clampLimit, optionalHex64, optionalUnixTime } from '../handler.js'
import { hydrateNotes } from '../hydrate.js'
import { encodeFeedRange } from '../synth.js'

const MEDIA_URL_REGEX = /https?:\/\/\S+\.(?:png|jpe?g|webp|gif|mp4|mov|webm)/i

interface FeedSpec {
	id?: string
	kind?: string
	notes?: string
	pubkey?: string
}

interface FeedRequest {
	spec: FeedSpec
	limit: number
	until?: number | undefined
	since?: number | undefined
	offset: number
	userPubkey?: string | undefined
	kinds: number[]
}

function parseFeedRequest(payload: unknown): FeedRequest {
	const record = (payload ?? {}) as Record<string, unknown>
	let spec: FeedSpec = {}
	if (typeof record.spec === 'string') {
		try {
			const parsed: unknown = JSON.parse(record.spec)
			if (parsed && typeof parsed === 'object') spec = parsed as FeedSpec
		} catch {
			// unknown spec → empty feed below
		}
	}
	const rawKinds = Array.isArray(record.kinds)
		? record.kinds.filter((k): k is number => typeof k === 'number')
		: []
	return {
		spec,
		limit: clampLimit(record.limit, 20, 100),
		until: optionalUnixTime(record.until),
		since: optionalUnixTime(record.since),
		offset: clampOffset(record.offset),
		userPubkey: optionalHex64(record.user_pubkey),
		kinds: rawKinds.length > 0 ? rawKinds.slice(0, 10) : [1, 6],
	}
}

/** Boundary-tie skip count; unlike limits it may legitimately be 0 */
function clampOffset(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
	return Math.min(500, Math.floor(value))
}

/** The user's follow list from their kind-3 contact event */
export async function fetchFollows(pubkey: string, ctx: VerbContext): Promise<string[]> {
	const contacts = await ctx.relay.fetch([{ kinds: [3], authors: [pubkey], limit: 1 }])
	const follows = new Set<string>()
	for (const tag of contacts[0]?.tags ?? []) {
		if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1].length === 64) follows.add(tag[1])
	}
	return [...follows].slice(0, 1000)
}

function isReply(event: NostrEvent): boolean {
	return event.kind === 1 && event.tags.some((t) => t[0] === 'e')
}

/**
 * Resolve the primary events for a feed request. Returns null when the spec
 * is unknown — the caller then serves an empty page rather than erroring.
 */
async function selectFeedEvents(req: FeedRequest, ctx: VerbContext): Promise<NostrEvent[] | null> {
	const { spec } = req
	const window: Pick<NostrFilter, 'since' | 'until'> = {}
	if (req.until !== undefined) window.until = req.until
	if (req.since !== undefined) window.since = req.since
	// Over-fetch to survive boundary-offset skipping and reply filtering
	const fetchLimit = Math.min(500, (req.limit + req.offset) * 3 + 20)

	const noteKinds = req.kinds.filter((k) => k === 1 || k === 6)

	if (spec.kind === 'reads' || spec.id === 'all-reads') {
		const filter: NostrFilter = { kinds: [30023], ...window, limit: fetchLimit }
		if (spec.pubkey) filter.authors = [spec.pubkey]
		return ctx.relay.fetch([filter])
	}

	if (spec.id === 'latest') {
		if (req.userPubkey) {
			const follows = await fetchFollows(req.userPubkey, ctx)
			if (follows.length > 0) {
				return ctx.relay.fetch([
					{ kinds: noteKinds, authors: follows, ...window, limit: fetchLimit },
				])
			}
		}
		// Guest or empty follow list: fall through to the global firehose
		return ctx.relay.fetch([{ kinds: noteKinds, ...window, limit: fetchLimit }])
	}

	if (spec.id === 'all-notes') {
		return ctx.relay.fetch([{ kinds: noteKinds, ...window, limit: fetchLimit }])
	}

	if (spec.id === 'feed' && spec.pubkey && spec.pubkey.length === 64) {
		const notesMode = spec.notes ?? 'authored'
		if (notesMode === 'bookmarks') {
			const lists = await ctx.relay.fetch([{ kinds: [10003], authors: [spec.pubkey], limit: 1 }])
			const ids = (lists[0]?.tags ?? [])
				.filter((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length === 64)
				.map((t) => t[1] as string)
				.slice(0, 200)
			if (ids.length === 0) return []
			return ctx.relay.fetch([{ ids, limit: ids.length }])
		}
		const authored = await ctx.relay.fetch([
			{ kinds: noteKinds, authors: [spec.pubkey], ...window, limit: fetchLimit },
		])
		switch (notesMode) {
			case 'authored':
				return authored.filter((e) => !isReply(e))
			case 'replies':
				return authored.filter((e) => isReply(e))
			case 'user_media_thumbnails':
				return authored.filter((e) => MEDIA_URL_REGEX.test(e.content))
			default:
				return authored
		}
	}

	return null
}

/**
 * Boundary-offset pagination (Primal semantics): the next page repeats the
 * previous RANGE.since as `until` (or, for the new-notes poll, the previous
 * `until` as `since`) and skips `offset` already-rendered events sitting
 * exactly on that boundary timestamp. The desc/id-asc sort keeps tie order
 * deterministic across requests, so "first `offset` ties" matches what the
 * client already rendered.
 */
export function applyPage(events: NostrEvent[], req: FeedRequest): NostrEvent[] {
	// Enforce the window here too: some sources (e.g. bookmarks by id) can't
	// push since/until into the relay query
	const windowed = events.filter(
		(e) =>
			(req.until === undefined || e.created_at <= req.until) &&
			(req.since === undefined || e.created_at >= req.since),
	)
	const sorted = windowed.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
	const boundary = req.until !== undefined ? req.until : req.since
	let skipped = 0
	const page: NostrEvent[] = []
	for (const event of sorted) {
		if (boundary !== undefined && event.created_at === boundary && skipped < req.offset) {
			skipped++
			continue
		}
		page.push(event)
		if (page.length >= req.limit) break
	}
	return page
}

export const feedDirective: VerbHandler = async function* (payload, ctx) {
	const req = parseFeedRequest(payload)
	const selected = await selectFeedEvents(req, ctx)
	if (selected === null) {
		// Unknown spec: an empty page with a RANGE keeps the client's pager sane
		yield encodeFeedRange([])
		return
	}
	const page = applyPage(selected, req)
	yield* hydrateNotes(page, ctx, { userPubkey: req.userPubkey, includeRange: true })
}

/** long_form_content_feed: reads feed with a flatter payload (pubkey/notes at top level) */
export const longFormContentFeed: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const spec: FeedSpec = { kind: 'reads' }
	const pubkey = optionalHex64(record.pubkey)
	if (pubkey) spec.pubkey = pubkey
	const req = parseFeedRequest(payload)
	req.spec = spec
	const selected = await selectFeedEvents(req, ctx)
	const page = applyPage(selected ?? [], req)
	yield* hydrateNotes(page, ctx, { userPubkey: req.userPubkey, includeRange: true })
}
