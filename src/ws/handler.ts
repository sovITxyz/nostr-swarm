import { classifyKind, isExpired, isProtected, validateEventStructure, verifyEventSignature } from '../nostr/events.js'
import { matchFilters, validateFilter } from '../nostr/filters.js'
import { countFilters, queryFilters } from '../storage/query.js'
import type { EventStore } from '../storage/store.js'
import { logger } from '../util/logger.js'
import type { NostrEvent, NostrFilter, RelayConfig } from '../util/types.js'
import type { Connection } from './connection.js'

export class MessageHandler {
	private readonly store: EventStore
	private readonly config: RelayConfig
	private readonly connections: Set<Connection>

	constructor(store: EventStore, config: RelayConfig, connections: Set<Connection>) {
		this.store = store
		this.config = config
		this.connections = connections

		// Wire up live subscription delivery
		this.store.on('event:stored', (event: NostrEvent) => {
			this.broadcastToSubscriptions(event)
		})
	}

	async handle(conn: Connection, raw: string): Promise<void> {
		// Size check
		if (raw.length > this.config.maxMessageSize) {
			conn.sendNotice('error: message too large')
			return
		}

		// Parse
		let msg: unknown[]
		try {
			msg = JSON.parse(raw)
		} catch {
			conn.sendNotice('error: invalid JSON')
			return
		}

		if (!Array.isArray(msg) || msg.length === 0 || typeof msg[0] !== 'string') {
			conn.sendNotice('error: invalid message format')
			return
		}

		const type = msg[0]

		try {
			switch (type) {
				case 'EVENT':
					await this.handleEvent(conn, msg)
					break
				case 'REQ':
					await this.handleReq(conn, msg)
					break
				case 'CLOSE':
					this.handleClose(conn, msg)
					break
				case 'COUNT':
					await this.handleCount(conn, msg)
					break
				case 'AUTH':
					this.handleAuth(conn, msg)
					break
				default:
					conn.sendNotice(`error: unknown message type: ${type}`)
			}
		} catch (err) {
			logger.error('Error handling message', { type, error: String(err) })
			conn.sendNotice('error: internal error')
		}
	}

	private async handleEvent(conn: Connection, msg: unknown[]): Promise<void> {
		if (msg.length < 2) {
			conn.sendNotice('error: EVENT requires an event object')
			return
		}

		// Rate limit
		if (!conn.eventLimiter.consume()) {
			const event = msg[1] as { id?: string }
			conn.sendOk(event?.id ?? '', false, 'rate-limited: slow down')
			return
		}

		const event = msg[1] as unknown

		// Structural validation
		if (!validateEventStructure(event)) {
			conn.sendOk((event as any)?.id ?? '', false, 'invalid: bad event structure')
			return
		}

		// Signature verification
		if (!verifyEventSignature(event)) {
			conn.sendOk(event.id, false, 'invalid: bad signature')
			return
		}

		// NIP-40: reject expired events
		if (isExpired(event)) {
			conn.sendOk(event.id, false, 'invalid: event expired')
			return
		}

		// NIP-70: protected events require auth
		if (isProtected(event) && conn.authPubkey !== event.pubkey) {
			conn.sendOk(event.id, false, 'auth-required: protected event')
			return
		}

		// Handle by kind classification
		const kind = classifyKind(event.kind)

		if (kind === 'ephemeral') {
			// Don't store, just broadcast to matching subscriptions
			this.broadcastToSubscriptions(event)
			conn.sendOk(event.id, true, '')
			return
		}

		// NIP-09: deletion events
		if (event.kind === 5) {
			await this.store.deleteEvent(event)
			conn.sendOk(event.id, true, '')
			return
		}

		// Store the event (regular, replaceable, or addressable)
		await this.store.putEvent(event)
		conn.sendOk(event.id, true, '')
	}

	private async handleReq(conn: Connection, msg: unknown[]): Promise<void> {
		if (msg.length < 3) {
			conn.sendNotice('error: REQ requires subscription ID and at least one filter')
			return
		}

		// Rate limit
		if (!conn.reqLimiter.consume()) {
			const subId = typeof msg[1] === 'string' ? msg[1] : ''
			conn.sendClosed(subId, 'rate-limited: slow down')
			return
		}

		const subId = msg[1]
		if (typeof subId !== 'string' || subId.length === 0 || subId.length > 64) {
			conn.sendNotice('error: invalid subscription ID')
			return
		}

		// Check subscription limit
		if (
			!conn.subscriptions.has(subId) &&
			conn.subscriptions.size >= conn.maxSubscriptions
		) {
			conn.sendClosed(subId, 'error: too many subscriptions')
			return
		}

		// Validate filters
		const filters: NostrFilter[] = []
		const rawFilters = msg.slice(2)
		if (rawFilters.length > conn.maxFiltersPerReq) {
			conn.sendClosed(subId, 'error: too many filters')
			return
		}

		for (const rawFilter of rawFilters) {
			if (!validateFilter(rawFilter)) {
				conn.sendClosed(subId, 'error: invalid filter')
				return
			}
			filters.push(rawFilter)
		}

		// Store subscription for live updates
		conn.subscriptions.set(subId, filters)

		// Query stored events
		const events = await queryFilters(this.store.indexes, filters)
		for (const event of events) {
			conn.sendEvent(subId, event)
		}

		conn.sendEose(subId)
	}

	private handleClose(conn: Connection, msg: unknown[]): void {
		if (msg.length < 2 || typeof msg[1] !== 'string') {
			conn.sendNotice('error: CLOSE requires subscription ID')
			return
		}
		const subId = msg[1]
		conn.subscriptions.delete(subId)
		conn.sendClosed(subId, '')
	}

	private async handleCount(conn: Connection, msg: unknown[]): Promise<void> {
		if (msg.length < 3) {
			conn.sendNotice('error: COUNT requires query ID and at least one filter')
			return
		}

		if (!conn.reqLimiter.consume()) {
			return
		}

		const queryId = msg[1]
		if (typeof queryId !== 'string') {
			conn.sendNotice('error: invalid query ID')
			return
		}

		const filters: NostrFilter[] = []
		for (const rawFilter of msg.slice(2)) {
			if (!validateFilter(rawFilter)) {
				conn.sendNotice('error: invalid filter in COUNT')
				return
			}
			filters.push(rawFilter)
		}

		const count = await countFilters(this.store.indexes, filters)
		conn.sendCount(queryId, count)
	}

	private handleAuth(conn: Connection, msg: unknown[]): void {
		if (msg.length < 2) {
			conn.sendNotice('error: AUTH requires a signed event')
			return
		}

		const event = msg[1] as unknown
		if (!validateEventStructure(event)) {
			conn.sendOk((event as any)?.id ?? '', false, 'invalid: bad event structure')
			return
		}

		// NIP-42: kind 22242 auth event
		if (event.kind !== 22242) {
			conn.sendOk(event.id, false, 'invalid: auth event must be kind 22242')
			return
		}

		if (!verifyEventSignature(event)) {
			conn.sendOk(event.id, false, 'invalid: bad signature')
			return
		}

		// Check challenge tag
		const challengeTag = event.tags.find((t) => t[0] === 'challenge')
		if (challengeTag?.[1] !== conn.challenge) {
			conn.sendOk(event.id, false, 'invalid: wrong challenge')
			return
		}

		// Check relay tag
		const relayTag = event.tags.find((t) => t[0] === 'relay')
		if (!relayTag?.[1]) {
			conn.sendOk(event.id, false, 'invalid: missing relay tag')
			return
		}

		// Check created_at within 10 minutes
		const now = Math.floor(Date.now() / 1000)
		if (Math.abs(now - event.created_at) > 600) {
			conn.sendOk(event.id, false, 'invalid: auth event too old or too new')
			return
		}

		conn.authPubkey = event.pubkey
		conn.sendOk(event.id, true, '')
	}

	private broadcastToSubscriptions(event: NostrEvent): void {
		for (const conn of this.connections) {
			for (const [subId, filters] of conn.subscriptions) {
				if (matchFilters(filters, event)) {
					conn.sendEvent(subId, event)
				}
			}
		}
	}
}
