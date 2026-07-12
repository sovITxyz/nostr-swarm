/**
 * Direct-message verbs (NIP-04, kind 4). The relay stores kind-4 events with
 * the sender in cleartext (event.pubkey) and the recipient in a cleartext #p
 * tag, so conversations, contact lists and unread counts are all servable from
 * NIP-01 without any keys — the client does all encryption/decryption.
 *
 * Unread counts need a per-(user, sender) read watermark that the reset verbs
 * advance; that small state lives in the shim's DmReadStore.
 */

import type { NostrEvent } from '../../util/types.js'
import { DM_ALL_SENDERS } from '../dm-read.js'
import type { LiveVerbHandler, VerbContext, VerbHandler } from '../handler.js'
import { clampLimit, optionalUnixTime, requireHex64, requireUserEvent } from '../handler.js'
import {
	type SenderMessageCount,
	encodeDirectMsgCount,
	encodeFeedRange,
	encodePerSenderStats,
} from '../synth.js'

const HEX64 = /^[0-9a-f]{64}$/

/** The #p recipient of a kind-4 DM (first valid p-tag) */
function recipientOf(event: NostrEvent): string | null {
	const tag = event.tags.find((t) => t[0] === 'p' && typeof t[1] === 'string' && HEX64.test(t[1]))
	return tag?.[1] ?? null
}

/** get_directmsgs: both directions of one A<->B conversation as raw kind-4 events. */
export const getDirectMsgs: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const receiver = requireHex64(record.receiver, 'receiver')
	const sender = requireHex64(record.sender, 'sender')
	const limit = clampLimit(record.limit, 20, 100)
	const until = optionalUnixTime(record.until)
	const since = optionalUnixTime(record.since)

	// The OR-filter also returns A<->C traffic; keep only the A<->B pair.
	const all = await ctx.relay.fetch([
		{ kinds: [4], authors: [receiver, sender], '#p': [receiver, sender], limit: 500 },
	])
	let msgs = all.filter((e) => {
		const to = recipientOf(e)
		return (e.pubkey === receiver && to === sender) || (e.pubkey === sender && to === receiver)
	})
	if (since !== undefined) msgs = msgs.filter((e) => e.created_at >= since)
	if (until !== undefined) msgs = msgs.filter((e) => e.created_at < until)
	msgs.sort((a, b) => b.created_at - a.created_at)
	const page = msgs.slice(0, limit)

	for (const msg of page) yield msg
	yield encodeFeedRange(page)
}

/** Enumerate the user's DM correspondents from inbound + outbound kind-4 events */
async function conversations(
	user: string,
	ctx: VerbContext,
): Promise<Map<string, { latestAt: number; latestId: string; unread: number }>> {
	const [inbound, outbound] = await Promise.all([
		ctx.relay.fetch([{ kinds: [4], '#p': [user], limit: 500 }]),
		ctx.relay.fetch([{ kinds: [4], authors: [user], limit: 500 }]),
	])
	const byCounterparty = new Map<string, { latestAt: number; latestId: string; unread: number }>()

	const touch = (counterparty: string, event: NostrEvent) => {
		const entry = byCounterparty.get(counterparty) ?? { latestAt: 0, latestId: '', unread: 0 }
		if (event.created_at > entry.latestAt) {
			entry.latestAt = event.created_at
			entry.latestId = event.id
		}
		byCounterparty.set(counterparty, entry)
	}

	for (const event of inbound) {
		if (event.pubkey === user) continue // our own message that also p-tags us
		touch(event.pubkey, event)
		const watermark = ctx.dmRead.get(user, event.pubkey)
		if (event.created_at > watermark) {
			const entry = byCounterparty.get(event.pubkey)
			if (entry) entry.unread++
		}
	}
	for (const event of outbound) {
		const to = recipientOf(event)
		if (to && to !== user) touch(to, event)
	}
	return byCounterparty
}

/** get_directmsg_contacts: conversation list with per-sender unread + latest message. */
export const getDirectmsgContacts: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const user = requireHex64(record.user_pubkey, 'user_pubkey')
	const relation = typeof record.relation === 'string' ? record.relation : 'any'
	const limit = clampLimit(record.limit, 100, 500)

	const convos = await conversations(user, ctx)

	// relation filter needs the user's follow set
	let allowed: Set<string> | null = null
	if (relation === 'follows' || relation === 'other') {
		const contacts = await ctx.relay.fetch([{ kinds: [3], authors: [user], limit: 1 }])
		const follows = new Set(
			(contacts[0]?.tags ?? [])
				.filter((t) => t[0] === 'p' && typeof t[1] === 'string')
				.map((t) => t[1] as string),
		)
		allowed = follows
	}

	let entries = [...convos.entries()]
	if (allowed) {
		entries = entries.filter(([pk]) =>
			relation === 'follows' ? allowed.has(pk) : !allowed.has(pk),
		)
	}
	entries.sort((a, b) => b[1].latestAt - a[1].latestAt)
	entries = entries.slice(0, limit)

	const stats: Record<string, SenderMessageCount> = {}
	for (const [pk, info] of entries) {
		stats[pk] = { cnt: info.unread, latest_at: info.latestAt, latest_event_id: info.latestId }
	}
	yield encodePerSenderStats(stats)

	const pubkeys = entries.map(([pk]) => pk)
	if (pubkeys.length > 0) {
		const profiles = await ctx.relay.fetch([
			{ kinds: [0], authors: pubkeys, limit: pubkeys.length },
		])
		for (const profile of profiles) yield profile
	}
	yield encodeFeedRange(
		entries.map(([, info]) => ({ id: info.latestId, created_at: info.latestAt })),
	)
}

/** reset_directmsg_count: mark one conversation read (advance its watermark). */
// biome-ignore lint/correctness/useYield: ack is EOSE-only
export const resetDirectmsgCount: VerbHandler = async function* (payload, ctx) {
	const record = (payload ?? {}) as Record<string, unknown>
	const user = requireUserEvent(payload)
	const sender = requireHex64(record.sender, 'sender')
	await ctx.dmRead.set(user.pubkey, sender, Math.floor(Date.now() / 1000))
}

/** reset_directmsg_counts: mark ALL conversations read (advance the mark-all watermark). */
// biome-ignore lint/correctness/useYield: ack is EOSE-only
export const resetDirectmsgCounts: VerbHandler = async function* (payload, ctx) {
	const user = requireUserEvent(payload)
	await ctx.dmRead.set(user.pubkey, DM_ALL_SENDERS, Math.floor(Date.now() / 1000))
}

/** Total unread across all conversations, from the read watermarks */
async function totalUnread(user: string, ctx: VerbContext): Promise<number> {
	const convos = await conversations(user, ctx)
	let total = 0
	for (const info of convos.values()) total += info.unread
	return total
}

/**
 * directmsg_count: long-lived total-unread badge. Immediate EOSE, then push a
 * kind-10000117 whenever a new inbound DM arrives (or a reset changes the count).
 */
export const directmsgCount: LiveVerbHandler = async (payload, ctx, session, subId) => {
	const user = requireHex64((payload as Record<string, unknown>)?.pubkey, 'pubkey')
	session.sendEose(subId)

	let last = -1
	let computing = false
	const push = async () => {
		if (computing) return
		computing = true
		try {
			const total = await totalUnread(user, ctx)
			if (total !== last) {
				last = total
				session.sendEvent(subId, encodeDirectMsgCount(total))
			}
		} catch {
			// upstream hiccup — next trigger retries
		} finally {
			computing = false
		}
	}

	const now = Math.floor(Date.now() / 1000)
	const unsubscribe = ctx.relay.subscribeLive(
		[{ kinds: [4], '#p': [user], since: now }],
		() => void push(),
	)
	const timer = setInterval(() => void push(), 15_000)
	timer.unref()
	const registered = session.registerLiveSub(subId, () => {
		clearInterval(timer)
		unsubscribe()
	})
	if (!registered) {
		clearInterval(timer)
		unsubscribe()
		return
	}
	void push()
}
