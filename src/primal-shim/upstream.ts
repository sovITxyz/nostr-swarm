/**
 * Multiplexed NIP-01 client for the shim's backing relay.
 *
 * The relay's rate limits and subscription caps are per WebSocket connection
 * (see ws/connection.ts), so queries fan out over a small socket pool picked
 * by least in-flight, with one extra dedicated socket for long-lived live
 * subscriptions so they never compete with query slots. Upstream subscription
 * ids are shim-generated — client subIds are never forwarded upstream.
 */

import WebSocket from 'ws'
import { logger } from '../util/logger.js'
import type { NostrEvent, NostrFilter } from '../util/types.js'

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000
/** Backoff before re-opening a live sub the relay closed (rate-limit / over-cap) */
const LIVE_RESUBSCRIBE_MS = 5_000
const OK_TIMEOUT_MS = 30_000
const RATE_LIMIT_RETRY_MS = 500
const MAX_RATE_LIMIT_RETRIES = 10

export interface PublishResult {
	accepted: boolean
	reason: string
}

interface PendingQuery {
	events: NostrEvent[]
	resolve: (events: NostrEvent[]) => void
	reject: (err: Error) => void
	timer: NodeJS.Timeout
}

interface PendingCount {
	resolve: (count: number) => void
	reject: (err: Error) => void
	timer: NodeJS.Timeout
}

interface OkWaiter {
	resolve: (result: PublishResult) => void
	timer: NodeJS.Timeout
}

interface LiveSub {
	filters: NostrFilter[]
	onEvent: (event: NostrEvent) => void
}

let subCounter = 0
function nextSubId(): string {
	subCounter = (subCounter + 1) % Number.MAX_SAFE_INTEGER
	return `q${subCounter}`
}

class UpstreamSocket {
	private ws: WebSocket | null = null
	private closed = false
	private reconnectDelay = RECONNECT_MIN_MS
	private readonly pendingQueries = new Map<string, PendingQuery>()
	private readonly pendingCounts = new Map<string, PendingCount>()
	private readonly okWaiters = new Map<string, OkWaiter[]>()
	readonly liveSubs = new Map<string, LiveSub>()

	constructor(
		private readonly url: string,
		private readonly label: string,
		private readonly queryTimeoutMs: number,
	) {}

	get inflight(): number {
		return this.pendingQueries.size + this.pendingCounts.size
	}

	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN
	}

	/** Resolves once the first connection is open; rejects if it cannot be established */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.open(resolve, reject)
		})
	}

	private open(onFirstOpen?: () => void, onFirstError?: (err: Error) => void): void {
		if (this.closed) return
		// Only the very first open/error may settle the connect() promise
		let firstOpen = onFirstOpen
		let firstError = onFirstError
		const ws = new WebSocket(this.url)
		this.ws = ws

		ws.once('open', () => {
			this.reconnectDelay = RECONNECT_MIN_MS
			logger.debug('Upstream socket connected', { label: this.label, url: this.url })
			// Re-establish long-lived subscriptions lost with the previous socket
			for (const [subId, sub] of this.liveSubs) {
				ws.send(JSON.stringify(['REQ', subId, ...sub.filters]))
			}
			firstOpen?.()
			firstOpen = undefined
			firstError = undefined
		})

		ws.on('message', (data) => this.route(data))

		ws.on('error', (err) => {
			if (firstError) {
				firstError(err instanceof Error ? err : new Error(String(err)))
				firstError = undefined
				firstOpen = undefined
				this.closed = true
				return
			}
			logger.warn('Upstream socket error', { label: this.label, error: String(err) })
		})

		ws.on('close', () => {
			this.ws = null
			this.failAllPending(new Error('upstream relay connection closed'))
			if (this.closed) return
			const delay = this.reconnectDelay
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
			logger.debug('Upstream socket reconnecting', { label: this.label, delayMs: delay })
			setTimeout(() => this.open(), delay).unref()
		})
	}

	close(): void {
		this.closed = true
		this.failAllPending(new Error('shim shutting down'))
		this.ws?.close()
		this.ws = null
	}

	private failAllPending(err: Error): void {
		for (const [subId, pending] of this.pendingQueries) {
			clearTimeout(pending.timer)
			this.pendingQueries.delete(subId)
			pending.reject(err)
		}
		for (const [subId, pending] of this.pendingCounts) {
			clearTimeout(pending.timer)
			this.pendingCounts.delete(subId)
			pending.reject(err)
		}
		for (const [id, waiters] of this.okWaiters) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer)
				waiter.resolve({ accepted: false, reason: `error: ${err.message}` })
			}
			this.okWaiters.delete(id)
		}
	}

	private route(data: WebSocket.RawData): void {
		let msg: unknown
		try {
			msg = JSON.parse(data.toString())
		} catch {
			return
		}
		if (!Array.isArray(msg)) return

		switch (msg[0]) {
			case 'EVENT': {
				const subId = String(msg[1])
				const event = msg[2] as NostrEvent
				const pending = this.pendingQueries.get(subId)
				if (pending) {
					pending.events.push(event)
					return
				}
				this.liveSubs.get(subId)?.onEvent(event)
				return
			}
			case 'EOSE': {
				const subId = String(msg[1])
				const pending = this.pendingQueries.get(subId)
				if (!pending) return
				clearTimeout(pending.timer)
				this.pendingQueries.delete(subId)
				// Free the relay-side subscription slot: EOSE keeps it live otherwise
				this.send(['CLOSE', subId])
				pending.resolve(pending.events)
				return
			}
			case 'CLOSED': {
				const subId = String(msg[1])
				const reason = typeof msg[2] === 'string' ? msg[2] : 'subscription closed by relay'
				const pending = this.pendingQueries.get(subId)
				if (pending) {
					clearTimeout(pending.timer)
					this.pendingQueries.delete(subId)
					pending.reject(new Error(reason))
					return
				}
				if (this.liveSubs.has(subId)) {
					// Relay dropped a live sub (rate-limited / over sub-cap). Re-REQ
					// after a backoff so badge updates recover instead of going dark.
					logger.warn('Upstream closed a live subscription; will resubscribe', {
						label: this.label,
						reason,
					})
					this.scheduleLiveResubscribe(subId)
				}
				return
			}
			case 'COUNT': {
				const subId = String(msg[1])
				const pending = this.pendingCounts.get(subId)
				if (!pending) return
				clearTimeout(pending.timer)
				this.pendingCounts.delete(subId)
				const count = (msg[2] as { count?: number } | undefined)?.count
				pending.resolve(typeof count === 'number' ? count : 0)
				return
			}
			case 'OK': {
				const id = String(msg[1])
				const waiters = this.okWaiters.get(id)
				const waiter = waiters?.shift()
				if (!waiter) return
				if (waiters && waiters.length === 0) this.okWaiters.delete(id)
				clearTimeout(waiter.timer)
				waiter.resolve({
					accepted: msg[2] === true,
					reason: typeof msg[3] === 'string' ? msg[3] : '',
				})
				return
			}
			default:
				// AUTH challenge (relay sends it unconditionally) and NOTICE are ignored
				return
		}
	}

	private send(msg: unknown[]): void {
		if (!this.connected || this.ws === null) {
			throw new Error('upstream relay not connected')
		}
		this.ws.send(JSON.stringify(msg))
	}

	/** Re-open a live sub the relay closed, after a fixed backoff (if still wanted) */
	private scheduleLiveResubscribe(subId: string): void {
		setTimeout(() => {
			const sub = this.liveSubs.get(subId)
			if (!sub || this.closed || !this.connected) return
			try {
				this.send(['REQ', subId, ...sub.filters])
			} catch {
				// socket down; the reconnect handler re-sends every live sub
			}
		}, LIVE_RESUBSCRIBE_MS).unref()
	}

	query(filters: NostrFilter[]): Promise<NostrEvent[]> {
		return new Promise((resolve, reject) => {
			const subId = nextSubId()
			const timer = setTimeout(() => {
				this.pendingQueries.delete(subId)
				try {
					this.send(['CLOSE', subId])
				} catch {
					// socket already gone; nothing to clean up upstream
				}
				reject(new Error('upstream query timed out'))
			}, this.queryTimeoutMs)
			timer.unref()
			this.pendingQueries.set(subId, { events: [], resolve, reject, timer })
			try {
				this.send(['REQ', subId, ...filters])
			} catch (err) {
				clearTimeout(timer)
				this.pendingQueries.delete(subId)
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})
	}

	count(filters: NostrFilter[]): Promise<number> {
		return new Promise((resolve, reject) => {
			const subId = nextSubId()
			const timer = setTimeout(() => {
				this.pendingCounts.delete(subId)
				reject(new Error('upstream count timed out'))
			}, this.queryTimeoutMs)
			timer.unref()
			this.pendingCounts.set(subId, { resolve, reject, timer })
			try {
				this.send(['COUNT', subId, ...filters])
			} catch (err) {
				clearTimeout(timer)
				this.pendingCounts.delete(subId)
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})
	}

	private awaitOk(eventId: string): Promise<PublishResult> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const waiters = this.okWaiters.get(eventId)
				if (waiters) {
					const idx = waiters.findIndex((w) => w.timer === timer)
					if (idx >= 0) waiters.splice(idx, 1)
					if (waiters.length === 0) this.okWaiters.delete(eventId)
				}
				resolve({ accepted: false, reason: 'error: timed out waiting for OK' })
			}, OK_TIMEOUT_MS)
			timer.unref()
			const waiters = this.okWaiters.get(eventId) ?? []
			waiters.push({ resolve, timer })
			this.okWaiters.set(eventId, waiters)
		})
	}

	/** Open a long-lived subscription registered in liveSubs (survives reconnects) */
	openLiveSub(subId: string, filters: NostrFilter[], onEvent: (event: NostrEvent) => void): void {
		this.liveSubs.set(subId, { filters, onEvent })
		if (this.connected) this.send(['REQ', subId, ...filters])
	}

	closeLiveSub(subId: string): void {
		this.liveSubs.delete(subId)
		if (this.connected) this.send(['CLOSE', subId])
	}

	/** Publish one event, retrying on the relay's 'rate-limited:' OK with a bounded backoff */
	async publish(event: NostrEvent): Promise<PublishResult> {
		for (let attempt = 0; ; attempt++) {
			const okPromise = this.awaitOk(event.id)
			try {
				this.send(['EVENT', event])
			} catch (err) {
				return { accepted: false, reason: `error: ${err instanceof Error ? err.message : err}` }
			}
			const result = await okPromise
			if (result.reason.startsWith('rate-limited:') && attempt < MAX_RATE_LIMIT_RETRIES) {
				await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS).unref())
				continue
			}
			return result
		}
	}
}

export class RelayClient {
	private readonly sockets: UpstreamSocket[]
	private readonly liveSocket: UpstreamSocket

	constructor(url: string, opts: { sockets: number; queryTimeoutMs: number }) {
		const poolSize = Math.max(1, opts.sockets)
		this.sockets = Array.from(
			{ length: poolSize },
			(_, i) => new UpstreamSocket(url, `query-${i}`, opts.queryTimeoutMs),
		)
		this.liveSocket = new UpstreamSocket(url, 'live', opts.queryTimeoutMs)
	}

	async connect(): Promise<void> {
		await Promise.all([...this.sockets.map((s) => s.connect()), this.liveSocket.connect()])
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.close()
		this.liveSocket.close()
	}

	private pick(): UpstreamSocket {
		let best: UpstreamSocket | null = null
		for (const socket of this.sockets) {
			if (!socket.connected) continue
			if (best === null || socket.inflight < best.inflight) best = socket
		}
		if (!best) throw new Error('upstream relay not connected')
		return best
	}

	/** One-shot query: REQ, collect until EOSE, CLOSE */
	fetch(filters: NostrFilter[]): Promise<NostrEvent[]> {
		return this.pick().query(filters)
	}

	/** NIP-45 COUNT */
	count(filters: NostrFilter[]): Promise<number> {
		return this.pick().count(filters)
	}

	/** EVENT, await the matching OK */
	publish(event: NostrEvent): Promise<PublishResult> {
		return this.pick().publish(event)
	}

	/**
	 * Persistent REQ on the dedicated live socket, re-established automatically
	 * after reconnects. Returns an unsubscribe function.
	 */
	subscribeLive(filters: NostrFilter[], onEvent: (event: NostrEvent) => void): () => void {
		const subId = nextSubId()
		try {
			this.liveSocket.openLiveSub(subId, filters, onEvent)
		} catch {
			// socket down right now; the reconnect handler re-sends from liveSubs
		}
		return () => {
			try {
				this.liveSocket.closeLiveSub(subId)
			} catch {
				// socket down; the sub died with it
			}
		}
	}
}
