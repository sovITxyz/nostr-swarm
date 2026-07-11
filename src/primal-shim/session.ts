import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'

/**
 * One Primal-client WebSocket session. Tracks in-flight verb requests (so a
 * CLOSE or disconnect aborts them) and long-lived subscriptions' cleanups.
 */
export class Session {
	readonly id: string
	readonly socket: WebSocket
	/** subId → abort controller for an in-flight one-shot verb */
	private readonly active = new Map<string, AbortController>()
	/** subId → cleanup for a long-lived verb (notification_counts etc.) */
	readonly liveSubs = new Map<string, () => void>()

	constructor(socket: WebSocket) {
		this.id = randomBytes(8).toString('hex')
		this.socket = socket
	}

	send(msg: unknown[]): void {
		if (this.socket.readyState === this.socket.OPEN) {
			this.socket.send(JSON.stringify(msg))
		}
	}

	sendEvent(subId: string, event: unknown): void {
		this.send(['EVENT', subId, event])
	}

	sendEose(subId: string): void {
		this.send(['EOSE', subId])
	}

	/** Primal cache NOTICEs are 3-element: subId then message */
	sendNotice(subId: string, message: string): void {
		this.send(['NOTICE', subId, message])
	}

	/** Register a new in-flight request, aborting any previous one on the same subId */
	beginRequest(subId: string): AbortSignal {
		this.active.get(subId)?.abort()
		const controller = new AbortController()
		this.active.set(subId, controller)
		return controller.signal
	}

	endRequest(subId: string, signal: AbortSignal): void {
		const current = this.active.get(subId)
		if (current && current.signal === signal) this.active.delete(subId)
	}

	/** Client CLOSE: abort the in-flight request and tear down any live sub */
	cancel(subId: string): void {
		this.active.get(subId)?.abort()
		this.active.delete(subId)
		const cleanup = this.liveSubs.get(subId)
		if (cleanup) {
			this.liveSubs.delete(subId)
			cleanup()
		}
	}

	close(): void {
		for (const controller of this.active.values()) controller.abort()
		this.active.clear()
		for (const cleanup of this.liveSubs.values()) cleanup()
		this.liveSubs.clear()
		this.socket.close()
	}
}
