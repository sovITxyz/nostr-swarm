/**
 * Notification verbs: history (get_notifications), seen-state, and the
 * long-lived badge counter (notification_counts).
 *
 * Notifications are synthesized from relay queries: kinds 1/6/7/9735 that
 * p-tag the user, classified against the user's own recent notes.
 */

import type { NostrEvent, NostrFilter } from '../../util/types.js'
import type { LiveVerbHandler, VerbContext, VerbHandler } from '../handler.js'
import { clampLimit, optionalUnixTime, requireHex64, requireUserEvent } from '../handler.js'
import { hydrateNotes } from '../hydrate.js'
import { zapAmountSats, zapSenderPubkey } from '../stats.js'
import {
	encodeNotification,
	encodeNotificationSummary,
	encodeSeenUntil,
	encodeUserStats,
} from '../synth.js'

/** Client NotificationType enum values (primal-web-app src/constants.ts:205-232) */
const NOTIFICATION_TYPE = {
	yourPostWasZapped: 3,
	yourPostWasLiked: 4,
	yourPostWasReposted: 5,
	yourPostWasRepliedTo: 6,
	youWereMentioned: 7,
} as const

const TYPE_GROUPS: Record<string, number[]> = {
	zaps: [NOTIFICATION_TYPE.yourPostWasZapped],
	replies: [NOTIFICATION_TYPE.yourPostWasRepliedTo],
	mentions: [NOTIFICATION_TYPE.youWereMentioned],
	reposts: [NOTIFICATION_TYPE.yourPostWasReposted],
}

/** Bound how far back notification scans reach when the user has no seen-state */
const DEFAULT_LOOKBACK_S = 30 * 24 * 60 * 60

interface Classified {
	type: number
	createdAt: number
	sourceId: string
	/** The acting user shown in the notification row */
	actor: string
	args: Record<string, unknown>
	/** Event ids the notification page needs rendered (posts, replies) */
	refIds: string[]
	refEvents: NostrEvent[]
}

function firstETag(event: NostrEvent): string | null {
	const tag = event.tags.find((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length === 64)
	return tag?.[1] ?? null
}

/** Classify one interaction event into a notification for `pubkey`, or null */
export function classifyInteraction(
	event: NostrEvent,
	pubkey: string,
	ownIds: Set<string>,
): Classified | null {
	switch (event.kind) {
		case 1: {
			if (event.pubkey === pubkey) return null
			const referenced = event.tags
				.filter((t) => t[0] === 'e' && typeof t[1] === 'string')
				.map((t) => t[1] as string)
			const repliedTo = referenced.find((id) => ownIds.has(id))
			if (repliedTo) {
				return {
					type: NOTIFICATION_TYPE.yourPostWasRepliedTo,
					createdAt: event.created_at,
					sourceId: event.id,
					actor: event.pubkey,
					args: { your_post: repliedTo, who_replied_to_it: event.pubkey, reply: event.id },
					refIds: [repliedTo],
					refEvents: [event],
				}
			}
			return {
				type: NOTIFICATION_TYPE.youWereMentioned,
				createdAt: event.created_at,
				sourceId: event.id,
				actor: event.pubkey,
				args: { you_were_mentioned_in: event.id, you_were_mentioned_by: event.pubkey },
				refIds: [],
				refEvents: [event],
			}
		}
		case 6: {
			if (event.pubkey === pubkey) return null
			const reposted = firstETag(event)
			if (!reposted || !ownIds.has(reposted)) return null
			return {
				type: NOTIFICATION_TYPE.yourPostWasReposted,
				createdAt: event.created_at,
				sourceId: event.id,
				actor: event.pubkey,
				args: { your_post: reposted, who_reposted_it: event.pubkey },
				refIds: [reposted],
				refEvents: [],
			}
		}
		case 7: {
			if (event.pubkey === pubkey) return null
			const liked = firstETag(event)
			if (!liked || !ownIds.has(liked)) return null
			return {
				type: NOTIFICATION_TYPE.yourPostWasLiked,
				createdAt: event.created_at,
				sourceId: event.id,
				actor: event.pubkey,
				args: { your_post: liked, who_liked_it: event.pubkey, reaction: event.content },
				refIds: [liked],
				refEvents: [],
			}
		}
		case 9735: {
			const sender = zapSenderPubkey(event)
			if (!sender || sender === pubkey) return null
			const zapped = firstETag(event)
			if (!zapped || !ownIds.has(zapped)) return null
			return {
				type: NOTIFICATION_TYPE.yourPostWasZapped,
				createdAt: event.created_at,
				sourceId: event.id,
				actor: sender,
				args: {
					your_post: zapped,
					who_zapped_it: sender,
					satszapped: zapAmountSats(event),
				},
				refIds: [zapped],
				refEvents: [],
			}
		}
		default:
			return null
	}
}

async function collectNotifications(
	pubkey: string,
	ctx: VerbContext,
	window: { since?: number | undefined; until?: number | undefined; limit: number },
): Promise<Classified[]> {
	const interactionsFilter: NostrFilter = {
		'#p': [pubkey],
		kinds: [1, 6, 7, 9735],
		limit: Math.min(500, window.limit * 3 + 50),
	}
	if (window.since !== undefined) interactionsFilter.since = window.since
	if (window.until !== undefined) interactionsFilter.until = window.until
	const [ownNotes, interactions] = await Promise.all([
		ctx.relay.fetch([{ authors: [pubkey], kinds: [1, 30023], limit: 500 }]),
		ctx.relay.fetch([interactionsFilter]),
	])
	const ownIds = new Set(ownNotes.map((n) => n.id))
	const classified: Classified[] = []
	for (const event of interactions) {
		const notification = classifyInteraction(event, pubkey, ownIds)
		if (notification) classified.push(notification)
	}
	classified.sort((a, b) => b.createdAt - a.createdAt)
	return classified
}

export const getNotifications: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const pubkey = requireHex64(record.pubkey, 'pubkey')
	const limit = clampLimit(record.limit, 100, 200)
	const since = optionalUnixTime(record.since)
	const until = optionalUnixTime(record.until)

	let classified = await collectNotifications(pubkey, ctx, { since, until, limit })

	const typeGroup = typeof record.type_group === 'string' ? record.type_group : 'all'
	const allowed = TYPE_GROUPS[typeGroup]
	if (allowed) classified = classified.filter((n) => allowed.includes(n.type))
	classified = classified.slice(0, limit)

	const actors = new Set<string>()
	const refIds = new Set<string>()
	const refEvents = new Map<string, NostrEvent>()
	for (const n of classified) {
		actors.add(n.actor)
		for (const id of n.refIds) refIds.add(id)
		for (const event of n.refEvents) refEvents.set(event.id, event)
		yield encodeNotification({
			id: n.sourceId,
			pubkey,
			created_at: n.createdAt,
			type: n.type,
			...n.args,
		})
	}

	// Actor profiles + the reduced user-stats the notification rows read
	if (actors.size > 0) {
		const profiles = await ctx.relay.fetch([
			{ kinds: [0], authors: [...actors], limit: actors.size },
		])
		for (const profile of profiles) yield profile
		for (const actor of actors) yield encodeUserStats(actor, {})
	}

	// Full enrichment for every referenced event the page renders
	const missingRefIds = [...refIds].filter((id) => !refEvents.has(id))
	if (missingRefIds.length > 0) {
		const fetched = await ctx.relay.fetch([{ ids: missingRefIds, limit: missingRefIds.length }])
		for (const event of fetched) refEvents.set(event.id, event)
	}
	if (refEvents.size > 0) {
		yield* hydrateNotes([...refEvents.values()], ctx, { userPubkey: pubkey })
	}
}

export const getNotificationsSeen: VerbHandler = async function* (payload, ctx) {
	const pubkey = requireHex64((payload as Record<string, unknown>)?.pubkey, 'pubkey')
	const ts = ctx.seen.get(pubkey)
	if (ts > 0) yield encodeSeenUntil(ts)
}

// biome-ignore lint/correctness/useYield: ack is EOSE-only
export const setNotificationsSeen: VerbHandler = async function* (payload, ctx) {
	const user = requireUserEvent(payload)
	await ctx.seen.set(user.pubkey, user.created_at)
}

/** Recompute the badge counts since the user's seen-state */
async function badgeCounts(pubkey: string, ctx: VerbContext): Promise<Record<string, number>> {
	const now = Math.floor(Date.now() / 1000)
	const since = Math.max(ctx.seen.get(pubkey), now - DEFAULT_LOOKBACK_S)
	const classified = await collectNotifications(pubkey, ctx, { since, limit: 100 })
	const counts: Record<string, number> = {}
	for (const n of classified) {
		if (n.createdAt <= since) continue
		const key = String(n.type)
		counts[key] = (counts[key] ?? 0) + 1
	}
	return counts
}

/**
 * Long-lived badge counter: immediate EOSE, then kind-10000112 pushes on new
 * relay activity for the user and on a slow timer (which also picks up
 * seen-state resets). Cleanup runs on CLOSE and on disconnect.
 */
export const notificationCounts: LiveVerbHandler = async (payload, ctx, session, subId) => {
	const pubkey = requireHex64((payload as Record<string, unknown>)?.pubkey, 'pubkey')
	session.sendEose(subId)

	let lastPushed = ''
	let computing = false
	const push = async () => {
		if (computing) return
		computing = true
		try {
			const counts = await badgeCounts(pubkey, ctx)
			const encoded = JSON.stringify(counts)
			if (encoded !== lastPushed) {
				lastPushed = encoded
				session.sendEvent(subId, encodeNotificationSummary(pubkey, counts))
			}
		} catch {
			// upstream hiccup — the next trigger retries
		} finally {
			computing = false
		}
	}

	const now = Math.floor(Date.now() / 1000)
	const unsubscribe = ctx.relay.subscribeLive(
		[{ '#p': [pubkey], kinds: [1, 6, 7, 9735], since: now }],
		() => void push(),
	)
	const timer = setInterval(() => void push(), 15_000)
	timer.unref()
	const registered = session.registerLiveSub(subId, () => {
		clearInterval(timer)
		unsubscribe()
	})
	if (!registered) {
		// Per-session live-sub cap reached: don't leak the timer/upstream sub.
		// The EOSE already sent leaves the client with a static (zero) badge.
		clearInterval(timer)
		unsubscribe()
		return
	}
	void push()
}
