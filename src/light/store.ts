import { EventEmitter } from 'node:events'
import type { EventStore } from '../storage/store.js'
import { eventKey, prefixRange } from '../util/keys.js'
import { logger } from '../util/logger.js'
import type { LightClientConfig, NostrEvent, WotConfig } from '../util/types.js'
import { WotGraph } from '../wot/graph.js'
import { ReplicationPolicyEngine } from '../wot/policy.js'

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
		// Always accept kind 0 (profiles), kind 3 (contact lists), and kind 10000 (mute lists)
		// Kind 0 enables discoverability; kinds 3/10000 are needed to build the WoT graph
		if (event.kind === 0 || event.kind === 3 || event.kind === 10000) {
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
	 * Warn-once no-op. TTL pruning used to append forged, unsigned kind-5 ops —
	 * the consensus apply() drops those (signature re-verification), and in a
	 * shared multi-writer base they would otherwise act as global deletions.
	 * True local pruning (hypercore clearing) is deferred; until then
	 * LIGHT_MAX_STORAGE is not enforced and degrades to this warning.
	 */
	async prune(): Promise<void> {
		if (this.pruneWarningLogged) return
		this.pruneWarningLogged = true
		logger.warn(
			'Light-client TTL pruning is disabled this release; LIGHT_MAX_STORAGE is not enforced',
			{ maxStorageBytes: this.lightConfig.maxStorageBytes },
		)
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
			if (event.kind === 0 || event.kind === 3 || event.kind === 10000) continue
			count++
		}
		return count
	}
}
