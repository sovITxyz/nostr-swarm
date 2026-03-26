import goodbye from 'graceful-goodbye'
import { EventStore } from './storage/store.js'
import { SwarmNetwork } from './swarm/network.js'
import { loadConfig } from './util/config.js'
import { logger } from './util/logger.js'
import type { RelayConfig } from './util/types.js'
import { RelayServer } from './ws/server.js'

export class NostrSwarm {
	readonly config: RelayConfig
	readonly store: EventStore
	readonly server: RelayServer
	readonly network: SwarmNetwork
	private cleanupTimer: ReturnType<typeof setInterval> | null = null

	constructor(configOverrides?: Partial<RelayConfig>) {
		this.config = loadConfig(configOverrides)
		this.store = new EventStore(this.config.storagePath)
		this.server = new RelayServer(this.store, this.config)
		this.network = new SwarmNetwork(this.store, this.config.topic)
	}

	async start(): Promise<void> {
		await this.store.ready()
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
		})
	}

	async stop(): Promise<void> {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer)
			this.cleanupTimer = null
		}
		await this.server.stop()
		await this.network.stop()
		await this.store.close()
		logger.info('nostr-swarm stopped')
	}

	/** Periodic cleanup of expired events (NIP-40) */
	private async cleanupExpired(): Promise<void> {
		// This would scan the expiration index and remove expired events.
		// For v1, expired events are filtered at query time in the handler.
		// Full cleanup can be added in a future version.
	}
}
