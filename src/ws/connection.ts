import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import { TokenBucket } from '../util/rate-limit.js'
import type { NostrFilter, RelayConfig } from '../util/types.js'

export class Connection {
	readonly id: string
	readonly socket: WebSocket
	readonly subscriptions: Map<string, NostrFilter[]> = new Map()
	readonly eventLimiter: TokenBucket
	readonly reqLimiter: TokenBucket
	readonly maxSubscriptions: number
	readonly maxFiltersPerReq: number
	authPubkey: string | null = null
	challenge: string

	constructor(socket: WebSocket, config: RelayConfig) {
		this.id = randomBytes(8).toString('hex')
		this.socket = socket
		this.eventLimiter = new TokenBucket(config.eventRatePerSec * 2, config.eventRatePerSec)
		this.reqLimiter = new TokenBucket(config.reqRatePerSec * 2, config.reqRatePerSec)
		this.maxSubscriptions = config.maxSubscriptionsPerConn
		this.maxFiltersPerReq = config.maxFiltersPerReq
		this.challenge = randomBytes(16).toString('hex')
	}

	send(msg: unknown[]): void {
		if (this.socket.readyState === this.socket.OPEN) {
			this.socket.send(JSON.stringify(msg))
		}
	}

	sendOk(eventId: string, accepted: boolean, message = ''): void {
		this.send(['OK', eventId, accepted, message])
	}

	sendEvent(subscriptionId: string, event: unknown): void {
		this.send(['EVENT', subscriptionId, event])
	}

	sendEose(subscriptionId: string): void {
		this.send(['EOSE', subscriptionId])
	}

	sendClosed(subscriptionId: string, message: string): void {
		this.send(['CLOSED', subscriptionId, message])
	}

	sendNotice(message: string): void {
		this.send(['NOTICE', message])
	}

	sendCount(queryId: string, count: number): void {
		this.send(['COUNT', queryId, { count }])
	}

	sendAuth(): void {
		this.send(['AUTH', this.challenge])
	}

	close(): void {
		this.subscriptions.clear()
		this.socket.close()
	}
}
