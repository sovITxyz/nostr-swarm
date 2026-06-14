import goodbye from 'graceful-goodbye'
import { LightStore } from './light/store.js'
import { persistBootstrapKey, resolveBootstrap, writeKeysFile } from './storage/bootstrap.js'
import { EventStore } from './storage/store.js'
import { SwarmNetwork, type SwarmNetworkOptions } from './swarm/network.js'
import { loadConfig, loadLightConfig, loadWotConfig } from './util/config.js'
import { logger } from './util/logger.js'
import type { LightClientConfig, RelayConfig, WotConfig } from './util/types.js'
import { WotGraph } from './wot/graph.js'
import { ReplicationPolicyEngine } from './wot/policy.js'
import { RelayServer } from './ws/server.js'

/** Max expired events reclaimed per cleanup cycle (bounds oplog write amplification) */
const EXPIRY_DELETE_BATCH = 256

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
		/** Constructor-only (no RelayConfig/CLI/env surface): DHT options for tests/private DHTs */
		network?: SwarmNetworkOptions
	}) {
		this.config = loadConfig(configOverrides?.relay)
		this.wotConfig = loadWotConfig(configOverrides?.wot)
		this.lightConfig = loadLightConfig(configOverrides?.light)

		// Resolve the Autobase bootstrap before the store exists: a configured
		// invite/hex key joins an existing base, the persistence guard pins this
		// storage dir to its recorded base, and null means this node founds one.
		const bootstrap = resolveBootstrap(this.config.storagePath, this.config.bootstrap)
		this.store = new EventStore(this.config.storagePath, bootstrap)
		this.server = new RelayServer(this.store, this.config)
		this.network = new SwarmNetwork(this.store, this.config.topic, configOverrides?.network, {
			requestWriter: this.config.requestWriter,
			autoAdmit: this.config.autoAdmit,
		})

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

		// Record this storage dir's base identity (no-op re-write for joiners,
		// founder first-start records its own base.key) and surface the invite +
		// writer key in keys.json (read by Start9 properties).
		const baseKey = this.store.base.key
		if (baseKey) {
			persistBootstrapKey(this.config.storagePath, baseKey)
			writeKeysFile(this.config.storagePath, baseKey, this.store.localWriterKey)
		}

		// Admit operator-approved writers: immediately when already writable
		// (founder/admitted writer), otherwise as soon as 'writable' fires.
		if (this.config.admitWriters.length > 0) {
			if (this.store.writable) {
				await this.processAdmissions()
			} else {
				this.store.once('writable', () => void this.processAdmissions())
			}
		}

		// Reconcile the base-wide optimistic-write policy to match this founder's
		// --accept-optimistic flag. Only the founder may set it (set_config is
		// founder-authored), and it is the authoritative source on each restart.
		if (this.store.isFounder) {
			await this.reconcileOptimisticPolicy()
		}

		// Build WoT graph if configured (and not in light mode, which does its own)
		if (this.wot && !this.lightStore) {
			await this.wot.rebuild(() => this.store.indexes)
			this.wot.startRefresh(() => this.store.indexes)
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

	/**
	 * Bring the base's `accept_optimistic` consensus flag in line with this
	 * founder's --accept-optimistic config (writes a set_config op only when it
	 * actually differs, so restarts are a no-op when unchanged).
	 */
	private async reconcileOptimisticPolicy(): Promise<void> {
		try {
			const current = await this.store.getConfig('accept_optimistic')
			if (current !== this.config.acceptOptimistic) {
				await this.store.setConfig('accept_optimistic', this.config.acceptOptimistic)
				logger.info('Set optimistic-write policy', {
					acceptOptimistic: this.config.acceptOptimistic,
				})
			}
		} catch (err) {
			logger.error('Failed to set optimistic-write policy', { error: String(err) })
		}
	}

	/** Append add_writer ops for each configured --admit key (already-admitted keys are skipped) */
	private async processAdmissions(): Promise<void> {
		for (const key of this.config.admitWriters) {
			try {
				const result = await this.store.admitWriter(key)
				logger.info('Writer admission processed', { key: key.slice(0, 16), result })
			} catch (err) {
				logger.error('Writer admission failed', { key: key.slice(0, 16), error: String(err) })
			}
		}
	}

	/**
	 * Periodic NIP-40 cleanup. Expired events are always filtered at query time;
	 * this additionally reclaims their storage via consensus expiry_delete ops so
	 * every peer converges. Only the founder issues them (it is the sole indexer,
	 * which avoids duplicate ops from multiple writers); other nodes just
	 * replicate the result. Bounded per cycle to cap oplog write amplification.
	 */
	private async cleanupExpired(): Promise<void> {
		if (!this.store.isFounder || !this.store.writable) return
		const now = Math.floor(Date.now() / 1000)
		try {
			const ids = await this.store.listExpired(now, EXPIRY_DELETE_BATCH)
			if (ids.length === 0) return
			await this.store.expireEvents(ids)
			logger.info('Reclaimed expired events', { count: ids.length })
		} catch (err) {
			logger.error('Expiration cleanup failed', { error: String(err) })
		}
	}
}
