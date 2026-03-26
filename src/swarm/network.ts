import { createHash } from 'node:crypto'
import Hyperswarm from 'hyperswarm'
import type { EventStore } from '../storage/store.js'
import { logger } from '../util/logger.js'

export class SwarmNetwork {
	private readonly swarm: Hyperswarm
	private readonly store: EventStore
	private readonly topicBuffer: Buffer
	private peerCount = 0

	constructor(store: EventStore, topic: string) {
		this.swarm = new Hyperswarm()
		this.store = store
		this.topicBuffer = createHash('sha256')
			.update(`nostr-swarm:${topic}`)
			.digest()
	}

	async start(): Promise<void> {
		this.swarm.on('connection', (socket: any, peerInfo: any) => {
			this.peerCount++
			const remoteKey = peerInfo.publicKey?.toString('hex')?.slice(0, 16) ?? 'unknown'
			logger.info('Peer connected', { peer: remoteKey, total: this.peerCount })

			// Replicate all corestores over this encrypted connection
			this.store.corestore.replicate(socket)

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
