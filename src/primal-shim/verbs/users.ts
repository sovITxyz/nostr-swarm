/** Profile verbs: user_infos, user_profile, contact lists, follow checks. */

import type { VerbHandler } from '../handler.js'
import { clampLimit, requireHex64 } from '../handler.js'
import { encodeIsUserFollowing, encodeUserScores, encodeUserStats } from '../synth.js'

export const userInfos: VerbHandler = async function* (payload, ctx) {
	const raw = (payload as Record<string, unknown>)?.pubkeys
	if (!Array.isArray(raw)) throw new Error('missing pubkeys')
	const pubkeys = [...new Set(raw.map((p) => requireHex64(p, 'pubkey')))].slice(0, 500)
	if (pubkeys.length === 0) return
	const profiles = await ctx.relay.fetch([{ kinds: [0], authors: pubkeys, limit: pubkeys.length }])
	for (const profile of profiles) yield profile
	// Scores feed sort order in user search/suggestions; zeros keep sorting sane
	yield encodeUserScores(Object.fromEntries(pubkeys.map((p) => [p, 0])))
}

export const userProfile: VerbHandler = async function* (payload, ctx) {
	const pubkey = requireHex64((payload as Record<string, unknown>)?.pubkey, 'pubkey')
	const [profiles, contacts, followersCount, noteCount] = await Promise.all([
		ctx.relay.fetch([{ kinds: [0], authors: [pubkey], limit: 1 }]),
		ctx.relay.fetch([{ kinds: [3], authors: [pubkey], limit: 1 }]),
		ctx.relay.count([{ kinds: [3], '#p': [pubkey] }]),
		ctx.relay.count([{ kinds: [1], authors: [pubkey] }]),
	])
	if (profiles.length > 0) yield profiles[0]
	const followsCount = new Set(
		(contacts[0]?.tags ?? []).filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]),
	).size
	yield encodeUserStats(pubkey, {
		follows_count: followsCount,
		followers_count: followersCount,
		note_count: noteCount,
	})
}

export const contactList: VerbHandler = async function* (payload, ctx) {
	const record = payload as Record<string, unknown>
	const pubkey = requireHex64(record?.pubkey, 'pubkey')
	const contact = (await ctx.relay.fetch([{ kinds: [3], authors: [pubkey], limit: 1 }]))[0]
	if (!contact) return
	yield contact
	if (record?.extended_response === true) {
		const follows = [
			...new Set(
				contact.tags
					.filter((t) => t[0] === 'p' && typeof t[1] === 'string' && t[1].length === 64)
					.map((t) => t[1] as string),
			),
		].slice(0, 500)
		if (follows.length > 0) {
			const profiles = await ctx.relay.fetch([
				{ kinds: [0], authors: follows, limit: follows.length },
			])
			for (const profile of profiles) yield profile
		}
	}
}

export const isUserFollowing: VerbHandler = async function* (payload, ctx) {
	const record = payload as Record<string, unknown>
	const pubkey = requireHex64(record?.pubkey, 'pubkey')
	const userPubkey = requireHex64(record?.user_pubkey, 'user_pubkey')
	const contacts = await ctx.relay.fetch([{ kinds: [3], authors: [userPubkey], limit: 1 }])
	const following = contacts[0]?.tags.some((t) => t[0] === 'p' && t[1] === pubkey) ?? false
	yield encodeIsUserFollowing(following)
}

export const userFollowers: VerbHandler = async function* (payload, ctx) {
	const pubkey = requireHex64((payload as Record<string, unknown>)?.pubkey, 'pubkey')
	const contactEvents = await ctx.relay.fetch([{ kinds: [3], '#p': [pubkey], limit: 200 }])
	const followers = [...new Set(contactEvents.map((e) => e.pubkey))].slice(0, 200)
	if (followers.length === 0) return
	const profiles = await ctx.relay.fetch([
		{ kinds: [0], authors: followers, limit: followers.length },
	])
	for (const profile of profiles) yield profile
	yield encodeUserScores(Object.fromEntries(followers.map((p) => [p, 0])))
}

export const getBookmarks: VerbHandler = async function* (payload, ctx) {
	const pubkey = requireHex64((payload as Record<string, unknown>)?.pubkey, 'pubkey')
	const bookmarks = await ctx.relay.fetch([{ kinds: [10003], authors: [pubkey], limit: 1 }])
	if (bookmarks.length > 0) yield bookmarks[0]
}

export const mutelist: VerbHandler = async function* (payload, ctx) {
	const pubkey = requireHex64((payload as Record<string, unknown>)?.pubkey, 'pubkey')
	const lists = await ctx.relay.fetch([{ kinds: [10000], authors: [pubkey], limit: 1 }])
	if (lists.length > 0) yield lists[0]
}

export const userSearch: VerbHandler = async function* (payload, ctx) {
	const record = payload as Record<string, unknown>
	const query = typeof record?.query === 'string' ? record.query.trim() : ''
	if (query.length === 0) return
	const limit = clampLimit(record?.limit, 10, 50)
	const profiles = await ctx.relay.fetch([{ kinds: [0], search: query, limit }])
	// Dedup replaceable kind-0 by author, newest first, in case the relay returns several
	const byAuthor = new Map<string, (typeof profiles)[number]>()
	for (const profile of profiles) {
		const existing = byAuthor.get(profile.pubkey)
		if (!existing || profile.created_at > existing.created_at) byAuthor.set(profile.pubkey, profile)
	}
	for (const profile of byAuthor.values()) yield profile
	yield encodeUserScores(Object.fromEntries([...byAuthor.keys()].map((p) => [p, 0])))
}
