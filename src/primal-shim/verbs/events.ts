/** Event-by-id and replaceable-event lookups. */

import type { VerbHandler } from '../handler.js'
import { optionalHex64, requireHex64 } from '../handler.js'
import { hydrateNotes } from '../hydrate.js'

export const events: VerbHandler = async function* (payload, ctx) {
	const record = payload as Record<string, unknown>
	const raw = record?.event_ids
	if (!Array.isArray(raw)) throw new Error('missing event_ids')
	const ids = [...new Set(raw.map((id) => requireHex64(id, 'event id')))].slice(0, 200)
	if (ids.length === 0) return
	const found = await ctx.relay.fetch([{ ids, limit: ids.length }])
	if (record?.extended_response === true) {
		yield* hydrateNotes(found, ctx, { userPubkey: optionalHex64(record?.user_pubkey) })
	} else {
		for (const event of found) yield event
	}
}

export const replaceableEvent: VerbHandler = async function* (payload, ctx) {
	const record = payload as Record<string, unknown>
	const pubkey = requireHex64(record?.pubkey, 'pubkey')
	const kind = typeof record?.kind === 'number' ? Math.floor(record.kind) : null
	if (kind === null || kind < 0 || kind > 65535) throw new Error('missing kind')
	const found = await ctx.relay.fetch([{ kinds: [kind], authors: [pubkey], limit: 1 }])
	if (found.length > 0) yield found[0]
}

export const parametrizedReplaceableEvent: VerbHandler = async function* (payload, ctx) {
	const record = payload as Record<string, unknown>
	const pubkey = requireHex64(record?.pubkey, 'pubkey')
	const kind = typeof record?.kind === 'number' ? Math.floor(record.kind) : null
	if (kind === null || kind < 0 || kind > 65535) throw new Error('missing kind')
	const identifier = typeof record?.identifier === 'string' ? record.identifier : ''
	const found = await ctx.relay.fetch([
		{ kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 1 },
	])
	if (found.length > 0) yield found[0]
}

export const parametrizedReplaceableEvents: VerbHandler = async function* (payload, ctx) {
	const raw = (payload as Record<string, unknown>)?.events
	if (!Array.isArray(raw)) throw new Error('missing events')
	for (const entry of raw.slice(0, 50)) {
		const record = entry as Record<string, unknown>
		const pubkey = optionalHex64(record?.pubkey)
		const kind = typeof record?.kind === 'number' ? Math.floor(record.kind) : null
		if (!pubkey || kind === null) continue
		const identifier = typeof record?.identifier === 'string' ? record.identifier : ''
		const found = await ctx.relay.fetch([
			{ kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 1 },
		])
		if (found.length > 0) yield found[0]
	}
}
