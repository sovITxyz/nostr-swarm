import type { NostrEvent, ReplicationPolicy, WotConfig } from '../util/types.js'
import type { WotGraph } from './graph.js'

/**
 * Decides whether to accept or reject an event based on WoT trust scores.
 * Also determines TTL for accepted events (how long to keep them).
 */
export class ReplicationPolicyEngine {
	private readonly graph: WotGraph
	private readonly config: WotConfig

	constructor(graph: WotGraph, config: WotConfig) {
		this.graph = graph
		this.config = config
	}

	/** Evaluate whether an event should be stored and for how long */
	evaluate(event: NostrEvent): ReplicationPolicy {
		const score = this.graph.getScore(event.pubkey)

		// Always reject muted pubkeys
		if (score.muted) {
			return { action: 'reject', reason: 'muted' }
		}

		// Owner's own events — always accept, keep forever
		if (event.pubkey === this.config.ownerPubkey) {
			return { action: 'accept', ttl: null }
		}

		// Not in trust graph at all
		if (score.degree === -1) {
			return { action: 'reject', reason: 'untrusted' }
		}

		// In trust graph — accept with TTL based on degree
		const ttl = this.config.ttlByDegree[score.degree]
		return {
			action: 'accept',
			ttl: ttl === 0 ? null : (ttl ?? null), // 0 means forever, undefined means forever
		}
	}

	/** Check if an event has exceeded its TTL (should be pruned) */
	isExpiredByPolicy(event: NostrEvent): boolean {
		const policy = this.evaluate(event)
		if (policy.action === 'reject') return true
		if (policy.ttl === null) return false

		const age = Math.floor(Date.now() / 1000) - event.created_at
		return age > policy.ttl
	}
}
