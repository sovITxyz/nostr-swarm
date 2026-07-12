/**
 * Shared enrichment pipeline ("response_messages_for_posts" in primal-server):
 * for a page of primary events, also emit author metadata, per-event stats,
 * referenced/quoted events, the caller's note actions, and the feed RANGE.
 */

import { decode } from 'nostr-tools/nip19'
import type { NostrEvent } from '../util/types.js'
import type { VerbContext } from './handler.js'
import { zapSenderPubkey } from './stats.js'
import {
	encodeEventStats,
	encodeFeedRange,
	encodeNoteActions,
	encodeReferencedEvent,
} from './synth.js'

const HEX64 = /^[0-9a-f]{64}$/
const EVENT_REF_REGEX = /(?:nostr:)?((?:note|nevent)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)/g

/** Event ids referenced by an event via e/q tags and bech32 mentions in content */
export function extractReferencedIds(event: NostrEvent): string[] {
	const ids = new Set<string>()
	for (const tag of event.tags) {
		if ((tag[0] === 'e' || tag[0] === 'q') && typeof tag[1] === 'string' && HEX64.test(tag[1])) {
			ids.add(tag[1])
		}
	}
	for (const match of event.content.matchAll(EVENT_REF_REGEX)) {
		const ref = match[1]
		if (!ref) continue
		try {
			const decoded = decode(ref as `note1${string}` | `nevent1${string}`)
			if (decoded.type === 'note') ids.add(decoded.data)
			else if (decoded.type === 'nevent') ids.add(decoded.data.id)
		} catch {
			// malformed bech32 in user content — skip
		}
	}
	return [...ids]
}

/** Pubkeys an event involves: author plus p-tags */
function involvedPubkeys(event: NostrEvent): string[] {
	const pubkeys = [event.pubkey]
	for (const tag of event.tags) {
		if (tag[0] === 'p' && typeof tag[1] === 'string' && HEX64.test(tag[1])) {
			pubkeys.push(tag[1])
		}
	}
	return pubkeys
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
	return chunks
}

/**
 * Caps on second-order references, so a page of attacker-authored events (each
 * of which may carry hundreds of e/q/p tags) cannot amplify one client request
 * into an unbounded number of upstream queries against the rate-limited relay.
 */
const MAX_REFERENCED_EVENTS = 256
const MAX_INVOLVED_PUBKEYS = 512
/** Ids per upstream query — keeps every REQ frame well under the relay's message-size limit */
const QUERY_ID_CHUNK = 100

export interface HydrateOptions {
	/** Logged-in user, drives note-actions synthesis */
	userPubkey?: string | undefined
	/** Emit the kind-10000113 RANGE (mandatory for feed/search pages) */
	includeRange?: boolean | undefined
}

export async function* hydrateNotes(
	notes: NostrEvent[],
	ctx: VerbContext,
	opts: HydrateOptions = {},
): AsyncIterable<unknown> {
	const noteIds = new Set(notes.map((n) => n.id))

	// 1. The page's primary events
	for (const note of notes) yield note

	// 2. Referenced/quoted events (one level), wrapped as kind 10000107.
	// Capped: events are attacker-authored and may carry hundreds of refs each.
	const refIds = new Set<string>()
	for (const note of notes) {
		for (const id of extractReferencedIds(note)) {
			if (!noteIds.has(id)) refIds.add(id)
			if (refIds.size >= MAX_REFERENCED_EVENTS) break
		}
		if (refIds.size >= MAX_REFERENCED_EVENTS) break
	}
	const referenced: NostrEvent[] = []
	if (refIds.size > 0) {
		for (const ids of chunk([...refIds], QUERY_ID_CHUNK)) {
			const events = await ctx.relay.fetch([{ ids, limit: ids.length }])
			referenced.push(...events)
		}
		for (const event of referenced) yield encodeReferencedEvent(event)
	}

	// 3. Author metadata for everyone involved (capped like refs)
	const pubkeys = new Set<string>()
	for (const event of [...notes, ...referenced]) {
		for (const pubkey of involvedPubkeys(event)) {
			pubkeys.add(pubkey)
			if (pubkeys.size >= MAX_INVOLVED_PUBKEYS) break
		}
		if (pubkeys.size >= MAX_INVOLVED_PUBKEYS) break
	}
	if (pubkeys.size > 0) {
		for (const authors of chunk([...pubkeys], QUERY_ID_CHUNK)) {
			const profiles = await ctx.relay.fetch([{ kinds: [0], authors, limit: authors.length }])
			for (const profile of profiles) yield profile
		}
	}

	// 4. Engagement stats for every primary and referenced event
	const statIds = [...noteIds, ...refIds]
	if (statIds.length > 0) {
		const stats = await ctx.stats.getStats(statIds)
		for (const entry of stats.values()) yield encodeEventStats(entry)
	}

	// 5. The caller's own interactions with the page (like/reply/repost/zap flags)
	if (opts.userPubkey && notes.length > 0) {
		const userPubkey = opts.userPubkey
		const ids = [...noteIds]
		const acted = new Map<
			string,
			{ replied: boolean; liked: boolean; reposted: boolean; zapped: boolean }
		>()
		for (const id of ids)
			acted.set(id, { replied: false, liked: false, reposted: false, zapped: false })

		// Reply/like/repost: kinds 1/6/7 are authored by the user directly.
		// Zaps: kind-9735 receipts are authored by the wallet provider, so query
		// them by #e and match the sender inside the embedded zap request.
		const [own, zapReceipts] = await Promise.all([
			ctx.relay.fetch([{ kinds: [1, 6, 7], authors: [userPubkey], '#e': ids, limit: 500 }]),
			ctx.relay.fetch([{ kinds: [9735], '#e': ids, limit: 500 }]),
		])
		for (const event of own) {
			for (const tag of event.tags) {
				if (tag[0] !== 'e' || typeof tag[1] !== 'string') continue
				const entry = acted.get(tag[1])
				if (!entry) continue
				if (event.kind === 1) entry.replied = true
				else if (event.kind === 6) entry.reposted = true
				else if (event.kind === 7) entry.liked = true
			}
		}
		for (const receipt of zapReceipts) {
			if (zapSenderPubkey(receipt) !== userPubkey) continue
			for (const tag of receipt.tags) {
				if (tag[0] !== 'e' || typeof tag[1] !== 'string') continue
				const entry = acted.get(tag[1])
				if (entry) entry.zapped = true
			}
		}
		for (const [event_id, flags] of acted) {
			yield encodeNoteActions({ event_id, ...flags })
		}
	}

	// 6. Feed page RANGE — required by the client to render the page at all
	if (opts.includeRange) {
		yield encodeFeedRange(notes)
	}
}
