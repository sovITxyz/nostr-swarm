import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'

/**
 * One Primal-client WebSocket session. Tracks in-flight verb requests (so a
 * CLOSE or disconnect aborts them) and long-lived subscriptions' cleanups.
 */
/** Cap on concurrent long-lived subscriptions per client, to bound relay sub-slot use */
const MAX_LIVE_SUBS_PER_SESSION = 8

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

	/**
	 * Register a new in-flight request, superseding any previous work on the
	 * same subId — aborting a one-shot verb AND tearing down a live verb whose
	 * cleanup would otherwise leak its timer and upstream subscription when the
	 * client re-uses the subId (e.g. an account switch re-issuing
	 * notification_counts).
	 */
	beginRequest(subId: string): AbortSignal {
		this.active.get(subId)?.abort()
		this.clearLiveSub(subId)
		const controller = new AbortController()
		this.active.set(subId, controller)
		return controller.signal
	}

	endRequest(subId: string, signal: AbortSignal): void {
		const current = this.active.get(subId)
		if (current && current.signal === signal) this.active.delete(subId)
	}

	/** Run and drop the live-sub cleanup for a subId, if any */
	clearLiveSub(subId: string): void {
		const cleanup = this.liveSubs.get(subId)
		if (cleanup) {
			this.liveSubs.delete(subId)
			cleanup()
		}
	}

	/**
	 * Register a live-sub cleanup, enforcing the per-session cap. Returns false
	 * if the cap is already reached (the caller should decline the subscription).
	 */
	registerLiveSub(subId: string, cleanup: () => void): boolean {
		if (!this.liveSubs.has(subId) && this.liveSubs.size >= MAX_LIVE_SUBS_PER_SESSION) {
			return false
		}
		this.liveSubs.set(subId, cleanup)
		return true
	}

	/** Client CLOSE: abort the in-flight request and tear down any live sub */
	cancel(subId: string): void {
		this.active.get(subId)?.abort()
		this.active.delete(subId)
		this.clearLiveSub(subId)
	}

	close(): void {
		for (const controller of this.active.values()) controller.abort()
		this.active.clear()
		for (const cleanup of this.liveSubs.values()) cleanup()
		this.liveSubs.clear()
		this.socket.close()
	}
}
