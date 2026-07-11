/**
 * Publish proxies. broadcast_events is the cache-proxied publish path
 * (proxyThroughPrimal=true); import_events is sent by the client after every
 * direct-to-relay publish so the cache can ingest what it just signed.
 */

import { validateEventStructure, verifyEventSignature } from '../../nostr/events.js'
import type { NostrEvent } from '../../util/types.js'
import type { VerbContext, VerbHandler } from '../handler.js'
import { encodeBroadcastResponse, encodeImportResponse } from '../synth.js'

const MAX_EVENTS_PER_REQUEST = 50

function parseEvents(payload: unknown): NostrEvent[] {
	const raw = (payload as Record<string, unknown>)?.events
	if (!Array.isArray(raw) || raw.length === 0) throw new Error('missing events')
	if (raw.length > MAX_EVENTS_PER_REQUEST) throw new Error('too many events in one request')
	const events: NostrEvent[] = []
	for (const candidate of raw) {
		if (!validateEventStructure(candidate) || !verifyEventSignature(candidate)) {
			throw new Error('invalid event in request')
		}
		events.push(candidate)
	}
	return events
}

async function publishAll(
	events: NostrEvent[],
	ctx: VerbContext,
): Promise<Array<{ event_id: string; accepted: boolean; reason: string }>> {
	const results: Array<{ event_id: string; accepted: boolean; reason: string }> = []
	for (const event of events) {
		const result = await ctx.relay.publish(event)
		// Idempotent replay: the relay already has it — that is success
		const accepted = result.accepted || result.reason.startsWith('duplicate:')
		results.push({ event_id: event.id, accepted, reason: result.reason })
	}
	return results
}

/** Client contract: any EVENT before EOSE = success; bare EOSE or NOTICE = failure */
export const broadcastEvents: VerbHandler = async function* (payload, ctx) {
	const events = parseEvents(payload)
	const results = await publishAll(events, ctx)
	const anyAccepted = results.some((r) => r.accepted)
	if (!anyAccepted) {
		throw new Error(`relay rejected the event: ${results[0]?.reason ?? 'unknown'}`)
	}
	yield encodeBroadcastResponse(results)
}

export const importEvents: VerbHandler = async function* (payload, ctx) {
	const events = parseEvents(payload)
	const results = await publishAll(events, ctx)
	const imported = results.filter((r) => r.accepted).length
	yield encodeImportResponse(imported, results.length - imported)
}
