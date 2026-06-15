import { EventEmitter } from 'node:events'
import type { EventStore } from '../storage/store.js'
import { eventKey, prefixRange } from '../util/keys.js'
import { logger } from '../util/logger.js'
import type { LightClientConfig, NostrEvent, WotConfig } from '../util/types.js'
import { WotGraph } from '../wot/graph.js'
import { ReplicationPolicyEngine } from '../wot/policy.js'

/**
 * Kinds never pruned or discovery-capped: profiles (0), contact lists (3), and
 * mute lists (10000) — they are tiny, replaceable, and needed to build the WoT
 * graph and stay discoverable.
 */
const EXEMPT_KINDS = new Set([0, 3, 10000])

/** Max events evicted per prune cycle (keeps a single cycle bounded) */
const PRUNE_BATCH = 1000

/**
 * Light client wrapper around EventStore.
 *
 * Applies WoT-based filtering to incoming events.
 *
 * Full relay nodes don't use this — they store everything.
 * Light clients (phones, constrained devices) use this to keep
 * storage manageable while prioritizing socially relevant events.
 *
 * Note: TTL-based pruning is disabled this release (see prune()) —
 * it forged unsigned kind-5 ops that the consensus apply() now drops,
 * and in a shared base they would otherwise act as global deletions.
 */
export class LightStore extends EventEmitter {
	readonly store: EventStore
	readonly wot: WotGraph
	readonly policy: ReplicationPolicyEngine
	private readonly wotConfig: WotConfig
	private readonly lightConfig: LightClientConfig
	private pruneTimer: ReturnType<typeof setInterval> | null = null
	private pruneWarningLogged = false

	constructor(store: EventStore, wotConfig: WotConfig, lightConfig: LightClientConfig) {
		super()
		this.store = store
		this.wot = new WotGraph(wotConfig)
		this.policy = new ReplicationPolicyEngine(this.wot, wotConfig)
		this.wotConfig = wotConfig
		this.lightConfig = lightConfig
	}

	async ready(): Promise<void> {
		await this.store.ready()

		// Build initial trust graph from stored events
		await this.wot.rebuild(() => this.store.indexes)

		// Start periodic WoT refresh
		this.wot.startRefresh(() => this.store.indexes)

		// Start periodic pruning
		if (this.lightConfig.pruneIntervalMs > 0) {
			this.pruneTimer = setInterval(
				() => this.prune().catch((err) => logger.error('Prune failed', { error: String(err) })),
				this.lightConfig.pruneIntervalMs,
			)
		}

		logger.info('Light store ready', this.wot.getStats())
	}

	async close(): Promise<void> {
		this.wot.stopRefresh()
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer)
			this.pruneTimer = null
		}
		await this.store.close()
	}

	/**
	 * Put an event through the WoT filter before storing.
	 * Returns true if the event was accepted, false if rejected.
	 */
	async putEvent(event: NostrEvent): Promise<boolean> {
		// Always accept profiles/contact lists/mute lists: needed for discovery and WoT
		if (EXEMPT_KINDS.has(event.kind)) {
			await this.store.putEvent(event)
			return true
		}

		const decision = this.policy.evaluate(event)

		if (decision.action === 'reject') {
			logger.debug('WoT rejected event', {
				pubkey: event.pubkey.slice(0, 16),
				kind: event.kind,
				reason: decision.reason,
			})
			return false
		}

		// Discovery tier: enforce per-pubkey event cap
		if (decision.discovery) {
			const count = await this.countAuthorEvents(event.pubkey)
			if (count >= this.wotConfig.discoveryMaxEventsPerPubkey) {
				logger.debug('WoT discovery cap reached', {
					pubkey: event.pubkey.slice(0, 16),
					count,
					max: this.wotConfig.discoveryMaxEventsPerPubkey,
				})
				return false
			}
		}

		await this.store.putEvent(event)
		return true
	}

	/** Delete an event (NIP-09). WoT check: only process if the author is trusted. */
	async deleteEvent(deletionEvent: NostrEvent): Promise<boolean> {
		const decision = this.policy.evaluate(deletionEvent)
		if (decision.action === 'reject') return false

		await this.store.deleteEvent(deletionEvent)
		return true
	}

	/**
	 * Enforce LIGHT_MAX_STORAGE by evicting the oldest events via founder-authored
	 * prune_delete ops (a consensus op, so the view stays convergent — the legacy
	 * path forged unsigned kind-5 ops that apply() now drops, and that would have
	 * meant global deletions in a shared base).
	 *
	 * This only works on a WRITABLE base (a light client running as its own
	 * personal-relay founder). A read-only replica cannot soundly mutate the
	 * shared, autobase-materialized view, so there pruning is a no-op and storage
	 * is bounded only by WoT ingest filtering — surfaced via a one-time warning.
	 */
	async prune(): Promise<void> {
		if (!this.store.writable) {
			if (!this.pruneWarningLogged) {
				this.pruneWarningLogged = true
				logger.warn(
					'Light pruning needs a writable (founder) base; LIGHT_MAX_STORAGE is not enforced on a read-only replica',
					{ maxStorageBytes: this.lightConfig.maxStorageBytes },
				)
			}
			return
		}

		const max = this.lightConfig.maxStorageBytes
		if (max <= 0) return

		// Measure stored event bytes and gather non-exempt prune candidates.
		let totalBytes = 0
		const candidates: { id: string; createdAt: number; bytes: number }[] = []
		for await (const entry of this.store.indexes.events.createReadStream()) {
			const event = entry.value as NostrEvent
			const bytes = Buffer.byteLength(JSON.stringify(event))
			totalBytes += bytes
			if (!EXEMPT_KINDS.has(event.kind)) {
				candidates.push({ id: event.id, createdAt: event.created_at, bytes })
			}
		}

		if (totalBytes <= max) return

		// Evict oldest-first down to 80% of the budget (hysteresis avoids
		// thrashing), bounded per cycle so a large overage clears incrementally.
		const target = max * 0.8
		candidates.sort((a, b) => a.createdAt - b.createdAt)
		const toDrop: string[] = []
		let projected = totalBytes
		for (const c of candidates) {
			if (projected <= target || toDrop.length >= PRUNE_BATCH) break
			toDrop.push(c.id)
			projected -= c.bytes
		}

		if (toDrop.length > 0) {
			await this.store.pruneEvents(toDrop)
			logger.info('Pruned events to honor storage budget', {
				dropped: toDrop.length,
				beforeBytes: totalBytes,
				maxBytes: max,
			})
		}
	}

	/** Count stored events for a pubkey, excluding exempt kinds (0, 3, 10000). */
	private async countAuthorEvents(pubkey: string): Promise<number> {
		const subs = this.store.indexes
		const range = prefixRange(pubkey)
		const stream = subs.author.createReadStream(range)

		let count = 0
		for await (const entry of stream) {
			const eventId = entry.value as string
			const eventEntry = await subs.events.get(eventKey(eventId))
			if (!eventEntry) continue

			const event = eventEntry.value as NostrEvent
			if (EXEMPT_KINDS.has(event.kind)) continue
			count++
		}
		return count
	}
}
