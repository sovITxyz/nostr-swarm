import { createHash } from 'node:crypto'
import Hyperswarm, { type PeerInfo, type SwarmSocket } from 'hyperswarm'
import type { EventStore } from '../storage/store.js'
import { logger } from '../util/logger.js'
import { type AdmissionOptions, AdmissionService } from './admission.js'

export interface SwarmNetworkOptions {
	/**
	 * Override the DHT bootstrap node list (e.g. a local hyperdht testnet).
	 * Constructor-only: never exposed via RelayConfig/CLI/env. When unset,
	 * Hyperswarm uses the public DHT bootstrap servers.
	 */
	dhtBootstrap?: { host: string; port: number }[]
}

export class SwarmNetwork {
	private readonly swarm: Hyperswarm
	private readonly store: EventStore
	private readonly topicBuffer: Buffer
	private readonly admission: AdmissionService
	private peerCount = 0

	constructor(
		store: EventStore,
		topic: string,
		opts?: SwarmNetworkOptions,
		admission?: AdmissionOptions,
	) {
		// Bootstrap-array form only — never inject a shared DHT node via opts.dht,
		// because Hyperswarm.destroy() force-destroys injected DHT instances.
		this.swarm = opts?.dhtBootstrap
			? new Hyperswarm({ bootstrap: opts.dhtBootstrap })
			: new Hyperswarm()
		this.store = store
		this.topicBuffer = createHash('sha256').update(`nostr-swarm:${topic}`).digest()
		this.admission = new AdmissionService(
			store,
			admission ?? { requestWriter: false, autoAdmit: false },
		)
	}

	async start(): Promise<void> {
		this.swarm.on('connection', (socket: SwarmSocket, peerInfo: PeerInfo) => {
			this.peerCount++
			const remoteKey = peerInfo.publicKey?.toString('hex')?.slice(0, 16) ?? 'unknown'
			logger.info('Peer connected', { peer: remoteKey, total: this.peerCount })

			// Replicate through the Autobase (not the raw corestore) so the
			// protomux-wakeup protocol announces writer heads to this peer.
			// relay.ts ordering guarantees the base is ready before connections.
			this.store.base.replicate(socket)

			// Open the v2 admission channel on the same muxer (no-op unless this
			// node opted into requesting or granting in-band admission). Must run
			// after replicate() so Protomux.from reuses Autobase's muxer.
			this.admission.attach(socket)

			socket.on('close', () => {
				this.peerCount--
				logger.info('Peer disconnected', { peer: remoteKey, total: this.peerCount })
			})

			socket.on('error', (err: Error) => {
				logger.error('Peer socket error', { peer: remoteKey, error: err.message })
			})
		})

		// Join the topic as both server and client
		const discovery = this.swarm.join(this.topicBuffer, { server: true, client: true })
		await discovery.flushed()

		logger.info('Joined swarm topic', {
			topic: this.topicBuffer.toString('hex').slice(0, 16),
		})
	}

	async stop(): Promise<void> {
		await this.swarm.destroy()
		logger.info('Swarm network stopped')
	}

	get peers(): number {
		return this.peerCount
	}
}
