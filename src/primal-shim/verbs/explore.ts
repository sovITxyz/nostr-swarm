/**
 * Explore + trending verbs. The relay can reproduce "latest", "zapped", and
 * "topics" faithfully; true Primal trending/follower-growth ranking is
 * proprietary and network-weighted, so those are approximated from engagement
 * counts computed by the shim's StatsService.
 */

import type { NostrEvent } from '../../util/types.js'
import type { VerbContext, VerbHandler } from '../handler.js'
import { clampLimit, optionalHex64, optionalUnixTime } from '../handler.js'
import { hydrateNotes } from '../hydrate.js'
import { zapSenderPubkey } from '../stats.js'
import {
	type EventStats,
	encodeCustomFeedRange,
	encodeFollowerCounts,
	encodeFollowerIncrease,
	encodeTopicStats,
	encodeUserScores,
} from '../synth.js'
import { hasMediaUrl } from './feeds.js'

const HOUR = 3600
const DAY = 86400

/** Parse a trending selector like "trending_4h" / "mostzapped_24h" */
function parseSelector(selector: unknown): { mode: 'trending' | 'mostzapped'; windowS: number } {
	const s = typeof selector === 'string' ? selector : 'trending_4h'
	const mode = s.startsWith('mostzapped') ? 'mostzapped' : 'trending'
	const win = s.endsWith('_1h')
		? HOUR
		: s.endsWith('_12h')
			? 12 * HOUR
			: s.endsWith('_24h')
				? DAY
				: 4 * HOUR
	return { mode, windowS: win }
}

function engagementScore(stats: EventStats | undefined): number {
	if (!stats) return 0
	return stats.likes + stats.reposts + 2 * stats.replies + 2 * stats.zaps
}

function isReply(event: NostrEvent): boolean {
	return event.tags.some((t) => t[0] === 'e')
}

/**
 * Rank candidate notes by engagement (or zap sats) and return the top N.
 * One batched StatsService call covers the whole candidate set.
 */
async function rankNotes(
	candidates: NostrEvent[],
	mode: 'trending' | 'mostzapped',
	limit: number,
	ctx: VerbContext,
): Promise<NostrEvent[]> {
	if (candidates.length === 0) return []
	const stats = await ctx.stats.getStats(candidates.map((n) => n.id))
	const scored = candidates.map((note) => ({
		note,
		rank:
			mode === 'mostzapped'
				? (stats.get(note.id)?.satszapped ?? 0)
				: engagementScore(stats.get(note.id)),
	}))
	scored.sort((a, b) => b.rank - a.rank || b.note.created_at - a.note.created_at)
	return scored.slice(0, limit).map((s) => s.note)
}

/** scored: home-sidebar trending notes. Streamed in ranked order (no RANGE needed). */
export const scored: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const { mode, windowS } = parseSelector(record.selector)
	const now = Math.floor(Date.now() / 1000)
	const candidates = (
		await ctx.relay.fetch([{ kinds: [1], since: now - windowS, until: now, limit: 500 }])
	).filter((e) => !isReply(e))
	const top = await rankNotes(candidates, mode, 20, ctx)
	yield* hydrateNotes(top, ctx, { userPubkey: optionalHex64(record.user_pubkey) })
}

/** scored_users_24h: explore-sidebar trending users (kind-0s + one UserScore dict). */
export const scoredUsers24h: VerbHandler = async function* (_payload, ctx) {
	const now = Math.floor(Date.now() / 1000)
	const recent = await ctx.relay.fetch([{ kinds: [1], since: now - DAY, until: now, limit: 1000 }])
	const noteCount = new Map<string, number>()
	for (const note of recent) noteCount.set(note.pubkey, (noteCount.get(note.pubkey) ?? 0) + 1)
	const ranked = [...noteCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
	if (ranked.length === 0) return
	const pubkeys = ranked.map(([pk]) => pk)
	const profiles = await ctx.relay.fetch([{ kinds: [0], authors: pubkeys, limit: pubkeys.length }])
	for (const profile of profiles) yield profile
	yield encodeUserScores(Object.fromEntries(ranked))
}

/** Shared paging window for the explore tabs (until/offset over a fetched batch) */
function pageWindow(record: Record<string, unknown>, fallbackLimit: number) {
	return {
		limit: clampLimit(record.limit, fallbackLimit, 100),
		until: optionalUnixTime(record.until),
		since: optionalUnixTime(record.since),
		offset: (() => {
			const o = record.offset
			return typeof o === 'number' && Number.isFinite(o) && o > 0 ? Math.min(500, Math.floor(o)) : 0
		})(),
		userPubkey: optionalHex64(record.user_pubkey),
	}
}

/** explore_media: latest notes containing media, resolved by RANGE elements. */
export const exploreMedia: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const p = pageWindow(record, 20)
	const now = Math.floor(Date.now() / 1000)
	const fetchLimit = Math.min(500, (p.limit + p.offset) * 4 + 50)
	const filter: { kinds: number[]; until?: number; since?: number; limit: number } = {
		kinds: [1],
		limit: fetchLimit,
	}
	if (p.until !== undefined) filter.until = p.until
	else filter.until = now
	if (p.since !== undefined) filter.since = p.since
	const media = (await ctx.relay.fetch([filter]))
		.filter((e) => hasMediaUrl(e.content))
		.sort((a, b) => b.created_at - a.created_at)
	const page = media.slice(p.offset, p.offset + p.limit)
	yield* hydrateNotes(page, ctx, { userPubkey: p.userPubkey })
	const last = page.at(-1)
	yield encodeCustomFeedRange({
		elements: page.map((e) => e.id),
		since: last ? last.created_at : 0,
		until: page[0]?.created_at ?? 0,
		orderBy: 'created_at',
	})
}

/** explore_topics: a single hashtag-frequency dictionary (kind 10000160). */
export const exploreTopics: VerbHandler = async function* (_payload, ctx) {
	const now = Math.floor(Date.now() / 1000)
	const recent = await ctx.relay.fetch([{ kinds: [1], since: now - DAY, until: now, limit: 1000 }])
	const counts: Record<string, number> = {}
	for (const note of recent) {
		for (const tag of note.tags) {
			if (
				tag[0] === 't' &&
				typeof tag[1] === 'string' &&
				tag[1].length > 0 &&
				tag[1].length <= 64
			) {
				const topic = tag[1].toLowerCase()
				counts[topic] = (counts[topic] ?? 0) + 1
			}
		}
	}
	yield encodeTopicStats(counts)
}

/** explore_people: active authors (approximation of Primal's follower-growth ranking). */
export const explorePeople: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const limit = clampLimit(record.limit, 20, 60)
	const now = Math.floor(Date.now() / 1000)
	const recent = await ctx.relay.fetch([{ kinds: [1], since: now - DAY, until: now, limit: 1000 }])
	const noteCount = new Map<string, number>()
	for (const note of recent) noteCount.set(note.pubkey, (noteCount.get(note.pubkey) ?? 0) + 1)
	const ranked = [...noteCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
	if (ranked.length === 0) {
		yield encodeCustomFeedRange({ elements: [], since: 0, until: 0, orderBy: 'followers_increase' })
		return
	}
	const pubkeys = ranked.map(([pk]) => pk)
	const [profiles, followerCounts] = await Promise.all([
		ctx.relay.fetch([{ kinds: [0], authors: pubkeys, limit: pubkeys.length }]),
		Promise.all(pubkeys.map((pk) => ctx.relay.count([{ kinds: [3], '#p': [pk] }]))),
	])
	for (const profile of profiles) yield profile
	const counts: Record<string, number> = {}
	const increases: Record<string, { increase: number; ratio: number; count: number }> = {}
	ranked.forEach(([pk, activity], i) => {
		const followers = followerCounts[i] ?? 0
		counts[pk] = followers
		increases[pk] = { increase: activity, ratio: 0, count: followers }
	})
	yield encodeFollowerCounts(counts)
	yield encodeFollowerIncrease(increases)
	const lastActivity = ranked.at(-1)?.[1] ?? 0
	yield encodeCustomFeedRange({
		elements: pubkeys,
		since: lastActivity,
		until: ranked[0]?.[1] ?? 0,
		orderBy: 'followers_increase',
	})
}

/** explore_zaps: recent zap receipts plus their zapped targets, resolved by RANGE. */
export const exploreZaps: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const p = pageWindow(record, 20)
	const now = Math.floor(Date.now() / 1000)
	const filter: { kinds: number[]; until?: number; since: number; limit: number } = {
		kinds: [9735],
		since: now - DAY,
		limit: Math.min(300, (p.limit + p.offset) * 4 + 50),
	}
	if (p.until !== undefined) filter.until = p.until
	const receipts = (await ctx.relay.fetch([filter])).sort((a, b) => b.created_at - a.created_at)
	const page = receipts.slice(p.offset, p.offset + p.limit)
	if (page.length === 0) {
		yield encodeCustomFeedRange({ elements: [], since: 0, until: 0, orderBy: 'created_at' })
		return
	}

	// Resolve each receipt's zapped target (first e-tag) — the client drops zaps
	// whose target isn't delivered.
	const targetIds = new Set<string>()
	for (const receipt of page) {
		const eTag = receipt.tags.find(
			(t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length === 64,
		)
		if (eTag) targetIds.add(eTag[1] as string)
	}
	const targets =
		targetIds.size > 0
			? await ctx.relay.fetch([{ ids: [...targetIds], limit: targetIds.size }])
			: []

	// Every author involved: zap senders + zapped-note authors
	const pubkeys = new Set<string>()
	for (const receipt of page) {
		const sender = zapSenderPubkey(receipt)
		if (sender) pubkeys.add(sender)
	}
	for (const target of targets) pubkeys.add(target.pubkey)
	const profiles =
		pubkeys.size > 0
			? await ctx.relay.fetch([{ kinds: [0], authors: [...pubkeys], limit: pubkeys.size }])
			: []

	for (const receipt of page) yield receipt
	for (const target of targets) yield target
	for (const profile of profiles) yield profile
	const last = page.at(-1)
	yield encodeCustomFeedRange({
		elements: page.map((e) => e.id),
		since: last ? last.created_at : 0,
		until: page[0]?.created_at ?? 0,
		orderBy: 'created_at',
	})
}
