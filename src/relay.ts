import goodbye from 'graceful-goodbye'
import { LightStore } from './light/store.js'
import { EventStore } from './storage/store.js'
import { SwarmNetwork } from './swarm/network.js'
import { loadConfig, loadLightConfig, loadWotConfig } from './util/config.js'
import { logger } from './util/logger.js'
import type { LightClientConfig, RelayConfig, WotConfig } from './util/types.js'
import { WotGraph } from './wot/graph.js'
import { ReplicationPolicyEngine } from './wot/policy.js'
import { RelayServer } from './ws/server.js'

export class NostrSwarm {
	readonly config: RelayConfig
	readonly wotConfig: WotConfig
	readonly lightConfig: LightClientConfig
	readonly store: EventStore
	readonly server: RelayServer
	readonly network: SwarmNetwork
	readonly wot: WotGraph | null
	readonly policy: ReplicationPolicyEngine | null
	readonly lightStore: LightStore | null
	private cleanupTimer: ReturnType<typeof setInterval> | null = null

	constructor(configOverrides?: {
		relay?: Partial<RelayConfig>
		wot?: Partial<WotConfig>
		light?: Partial<LightClientConfig>
	}) {
		this.config = loadConfig(configOverrides?.relay)
		this.wotConfig = loadWotConfig(configOverrides?.wot)
		this.lightConfig = loadLightConfig(configOverrides?.light)

		this.store = new EventStore(this.config.storagePath)
		this.server = new RelayServer(this.store, this.config)
		this.network = new SwarmNetwork(this.store, this.config.topic)

		// Initialize WoT if owner pubkey is configured
		if (this.wotConfig.ownerPubkey) {
			this.wot = new WotGraph(this.wotConfig)
			this.policy = new ReplicationPolicyEngine(this.wot, this.wotConfig)
		} else {
			this.wot = null
			this.policy = null
		}

		// Initialize light client mode if enabled
		if (this.lightConfig.enabled && this.wotConfig.ownerPubkey) {
			this.lightStore = new LightStore(this.store, this.wotConfig, this.lightConfig)
		} else {
			this.lightStore = null
		}
	}

	async start(): Promise<void> {
		if (this.lightStore) {
			await this.lightStore.ready()
		} else {
			await this.store.ready()
		}

		// Build WoT graph if configured (and not in light mode, which does its own)
		if (this.wot && !this.lightStore) {
			await this.wot.rebuild(this.store.indexes)
			this.wot.startRefresh(this.store.indexes)
		}

		await this.server.start()
		await this.network.start()

		// Register shutdown hooks
		goodbye(async () => {
			logger.info('Shutting down...')
			await this.stop()
		})

		// Start expiration cleanup timer
		if (this.config.expirationCleanupIntervalMs > 0) {
			this.cleanupTimer = setInterval(
				() => this.cleanupExpired(),
				this.config.expirationCleanupIntervalMs,
			)
		}

		logger.info('nostr-swarm started', {
			port: this.config.port,
			topic: this.config.topic,
			storage: this.config.storagePath,
			wot: this.wot ? 'enabled' : 'disabled',
			lightClient: this.lightStore ? 'enabled' : 'disabled',
		})
	}

	async stop(): Promise<void> {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer)
			this.cleanupTimer = null
		}
		if (this.wot && !this.lightStore) {
			this.wot.stopRefresh()
		}
		await this.server.stop()
		await this.network.stop()
		if (this.lightStore) {
			await this.lightStore.close()
		} else {
			await this.store.close()
		}
		logger.info('nostr-swarm stopped')
	}

	/** Periodic cleanup of expired events (NIP-40) */
	private async cleanupExpired(): Promise<void> {
		// This would scan the expiration index and remove expired events.
		// For v1, expired events are filtered at query time in the handler.
		// Full cleanup can be added in a future version.
	}
}
