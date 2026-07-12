/** thread_view / multi_kind_thread_view: parent chain + focused event + replies. */

import type { NostrEvent } from '../../util/types.js'
import type { VerbHandler } from '../handler.js'
import { clampLimit, optionalHex64, requireHex64 } from '../handler.js'
import { hydrateNotes } from '../hydrate.js'

const MAX_PARENT_HOPS = 10

/** NIP-10 parent: marked 'reply' tag first, then 'root', then the last e-tag */
export function parentEventId(event: NostrEvent): string | null {
	const refs: Array<{ id: string; marker: string | undefined }> = []
	for (const tag of event.tags) {
		if (tag[0] === 'e' && typeof tag[1] === 'string' && tag[1].length === 64) {
			refs.push({ id: tag[1], marker: tag[3] })
		}
	}
	if (refs.length === 0) return null
	const reply = refs.find((r) => r.marker === 'reply')
	if (reply) return reply.id
	const root = refs.find((r) => r.marker === 'root')
	if (root) return root.id
	return refs[refs.length - 1]?.id ?? null
}

export const threadView: VerbHandler = async function* (payload, ctx) {
	const record = payload as Record<string, unknown>
	const eventId = requireHex64(record?.event_id, 'event_id')
	const limit = clampLimit(record?.limit, 100, 200)
	const userPubkey = optionalHex64(record?.user_pubkey)

	const focused = (await ctx.relay.fetch([{ ids: [eventId], limit: 1 }]))[0]
	if (!focused) return

	// Walk the reply chain up to the root
	const seen = new Set<string>([eventId])
	const parents: NostrEvent[] = []
	let current = focused
	for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
		const parentId = parentEventId(current)
		if (!parentId || seen.has(parentId)) break
		seen.add(parentId)
		const parent = (await ctx.relay.fetch([{ ids: [parentId], limit: 1 }]))[0]
		if (!parent) break
		parents.unshift(parent)
		current = parent
	}

	const replies = (await ctx.relay.fetch([{ kinds: [1], '#e': [eventId], limit }])).filter(
		(e) => !seen.has(e.id),
	)
	replies.sort((a, b) => b.created_at - a.created_at)

	const events = [...parents, focused, ...replies]
	yield* hydrateNotes(events, ctx, { userPubkey })
}
