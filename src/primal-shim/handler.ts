import { validateEventStructure, verifyEventSignature } from '../nostr/events.js'
import { logger } from '../util/logger.js'
import type { NostrEvent, PrimalShimConfig } from '../util/types.js'
import type { SeenStore } from './seen.js'
import type { Session } from './session.js'
import type { StatsService } from './stats.js'
import type { RelayClient } from './upstream.js'

export interface VerbContext {
	relay: RelayClient
	stats: StatsService
	seen: SeenStore
	config: PrimalShimConfig
	signal: AbortSignal
}

/** One-shot verb: yield events in wire order; return ⇒ the handler sends EOSE */
export type VerbHandler = (payload: unknown, ctx: VerbContext) => AsyncIterable<unknown>

/**
 * Long-lived verb (notification_counts etc.): sends its own immediate EOSE,
 * pushes bare EVENTs afterwards, and must register cleanup in session.liveSubs.
 */
export type LiveVerbHandler = (
	payload: unknown,
	ctx: VerbContext,
	session: Session,
	subId: string,
) => Promise<void>

export interface ShimServices {
	relay: RelayClient
	stats: StatsService
	seen: SeenStore
	config: PrimalShimConfig
}

/** Max created_at skew accepted on user-signed request events (matches primal-server) */
const USER_EVENT_MAX_FUTURE_S = 300

/**
 * Extract and verify the signed event Primal attaches to user-scoped verbs
 * (`event_from_user` / `settings_event`). The Schnorr signature is the only
 * write-auth the cache protocol has, so it is always enforced.
 */
export function requireUserEvent(payload: unknown): NostrEvent {
	const record = payload as Record<string, unknown> | null | undefined
	const candidate = record?.event_from_user ?? record?.settings_event
	if (!validateEventStructure(candidate)) {
		throw new Error('missing or malformed signed event in request')
	}
	if (candidate.created_at > Math.floor(Date.now() / 1000) + USER_EVENT_MAX_FUTURE_S) {
		throw new Error('signed request event is too far in the future')
	}
	if (!verifyEventSignature(candidate)) {
		throw new Error('invalid signature on request event')
	}
	return candidate
}

const HEX64 = /^[0-9a-f]{64}$/

export function requireHex64(value: unknown, name: string): string {
	if (typeof value !== 'string' || !HEX64.test(value)) {
		throw new Error(`missing or malformed ${name}`)
	}
	return value
}

export function optionalHex64(value: unknown): string | undefined {
	return typeof value === 'string' && HEX64.test(value) ? value : undefined
}

export function clampLimit(value: unknown, fallback: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
	return Math.max(1, Math.min(max, Math.floor(value)))
}

export function optionalUnixTime(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
	return Math.floor(value)
}

export class ShimMessageHandler {
	constructor(
		private readonly services: ShimServices,
		private readonly verbs: Map<string, VerbHandler>,
		private readonly liveVerbs: Map<string, LiveVerbHandler>,
	) {}

	async handle(session: Session, raw: string): Promise<void> {
		if (raw.length > this.services.config.maxMessageSize) {
			session.send(['NOTICE', 'error: message too large'])
			return
		}

		let msg: unknown
		try {
			msg = JSON.parse(raw)
		} catch {
			session.send(['NOTICE', 'error: invalid JSON'])
			return
		}
		if (!Array.isArray(msg) || msg.length < 2 || typeof msg[1] !== 'string') return
		const subId = msg[1]
		if (subId.length === 0 || subId.length > 128) return

		// CLOSE may carry a third element (a cache payload) — tolerated and ignored
		if (msg[0] === 'CLOSE') {
			session.cancel(subId)
			return
		}
		if (msg[0] !== 'REQ') return

		const filterObj = msg[2] as Record<string, unknown> | undefined
		const cache = filterObj?.cache
		if (!Array.isArray(cache) || typeof cache[0] !== 'string') {
			// Non-cache REQs are never sent by the web app; EOSE keeps it unblocked
			session.sendEose(subId)
			return
		}
		const verb = cache[0]
		const payload = cache[1]

		const live = this.liveVerbs.get(verb)
		if (live) {
			const signal = session.beginRequest(subId)
			try {
				await live(payload, { ...this.services, signal }, session, subId)
			} catch (err) {
				logger.debug('Live verb failed', { verb, error: String(err) })
				session.sendNotice(subId, `error: ${err instanceof Error ? err.message : 'internal'}`)
				session.sendEose(subId)
			} finally {
				session.endRequest(subId, signal)
			}
			return
		}

		const handler = this.verbs.get(verb)
		if (!handler) {
			logger.debug('Unknown cache verb', { verb })
			session.sendEose(subId)
			return
		}

		const signal = session.beginRequest(subId)
		try {
			for await (const event of handler(payload, { ...this.services, signal })) {
				if (signal.aborted) break
				session.sendEvent(subId, event)
			}
			if (!signal.aborted) session.sendEose(subId)
		} catch (err) {
			if (!signal.aborted) {
				logger.debug('Verb failed', { verb, error: String(err) })
				session.sendNotice(subId, `error: ${err instanceof Error ? err.message : 'internal'}`)
				session.sendEose(subId)
			}
		} finally {
			session.endRequest(subId, signal)
		}
	}
}
