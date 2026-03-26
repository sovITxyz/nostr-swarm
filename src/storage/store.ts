import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Corestore from 'corestore'
import { EventEmitter } from 'node:events'
import { classifyKind, getDTag, getExpiration, getIndexableTags, shouldReplace } from '../nostr/events.js'
import {
	addressableKey,
	authorKey,
	authorKindKey,
	createdAtKey,
	deletionKey,
	eventKey,
	expirationKey,
	kindKey,
	replaceableKey,
	tagKey,
} from '../util/keys.js'
import { logger } from '../util/logger.js'
import type { NostrEvent, StoreOp } from '../util/types.js'
import { createSubs, type IndexSubs } from './indexes.js'

export class EventStore extends EventEmitter {
	readonly corestore: Corestore
	readonly base: Autobase
	private subs: IndexSubs | null = null

	constructor(storagePath: string, bootstrap?: Buffer | null) {
		super()
		this.corestore = new Corestore(storagePath)
		this.base = new Autobase(this.corestore, bootstrap ?? null, {
			open: (store: any) => {
				return new Hyperbee(store.get('view'), {
					keyEncoding: 'utf-8',
					valueEncoding: 'json',
				})
			},
			apply: this.apply.bind(this),
			valueEncoding: 'json',
			ackInterval: 1000,
		})
	}

	get view(): Hyperbee {
		return this.base.view
	}

	get indexes(): IndexSubs {
		if (!this.subs) {
			this.subs = createSubs(this.view)
		}
		return this.subs
	}

	async ready(): Promise<void> {
		await this.base.ready()
		logger.info('Event store ready', { key: this.base.key?.toString('hex')?.slice(0, 16) })
	}

	async close(): Promise<void> {
		await this.base.close()
		await this.corestore.close()
	}

	/** Append a put operation */
	async putEvent(event: NostrEvent): Promise<void> {
		await this.base.append({ type: 'put', event } satisfies StoreOp)
	}

	/** Append a delete operation (for NIP-09 kind 5 events) */
	async deleteEvent(deletionEvent: NostrEvent): Promise<void> {
		await this.base.append({ type: 'delete', event: deletionEvent } satisfies StoreOp)
	}

	/** Force an update from peers */
	async update(): Promise<void> {
		await this.base.update()
	}

	/** The deterministic apply function for Autobase linearization */
	private async apply(nodes: any[], view: Hyperbee, _host: any): Promise<void> {
		// Create sub-databases from the view directly.
		// Autobase already handles atomicity for the apply function.
		const subs = createSubs(view)

		for (const node of nodes) {
			if (node.value === null) continue // skip ack nodes

			const op = node.value as StoreOp
			try {
				if (op.type === 'put') {
					await this.applyPut(subs, op.event)
				} else if (op.type === 'delete') {
					await this.applyDelete(subs, op.event)
				}
			} catch (err) {
				logger.error('Error in apply', { error: String(err), type: op.type })
			}
		}
	}

	private async applyPut(subs: IndexSubs, event: NostrEvent): Promise<void> {
		const id = event.id

		// Dedup: skip if event already exists
		const existing = await subs.events.get(eventKey(id))
		if (existing) return

		// Check if this event was previously deleted
		const deleted = await subs.deletion.get(deletionKey(id))
		if (deleted) return

		const kind = classifyKind(event.kind)

		// Handle replaceable events (kinds 0, 3, 10000-19999)
		if (kind === 'replaceable') {
			const rKey = replaceableKey(event.pubkey, event.kind)
			const prev = await subs.replaceable.get(rKey)
			if (prev) {
				const prevEvent = await subs.events.get(eventKey(prev.value))
				if (prevEvent && !shouldReplace(prevEvent.value, event)) return
				// Remove old indexes
				if (prevEvent) await this.removeIndexes(subs, prevEvent.value)
			}
			await subs.replaceable.put(rKey, id)
		}

		// Handle addressable events (kinds 30000-39999)
		if (kind === 'addressable') {
			const dTag = getDTag(event)
			const aKey = addressableKey(event.pubkey, event.kind, dTag)
			const prev = await subs.addressable.get(aKey)
			if (prev) {
				const prevEvent = await subs.events.get(eventKey(prev.value))
				if (prevEvent && !shouldReplace(prevEvent.value, event)) return
				if (prevEvent) await this.removeIndexes(subs, prevEvent.value)
			}
			await subs.addressable.put(aKey, id)
		}

		// Ephemeral events are not stored
		if (kind === 'ephemeral') return

		// Write event to primary store
		await subs.events.put(eventKey(id), event)

		// Write all secondary indexes
		await subs.kind.put(kindKey(event.kind, event.created_at, id), id)
		await subs.author.put(authorKey(event.pubkey, event.created_at, id), id)
		await subs.authorKind.put(
			authorKindKey(event.pubkey, event.kind, event.created_at, id),
			id,
		)
		await subs.createdAt.put(createdAtKey(event.created_at, id), id)

		// Index single-letter tags
		for (const { name, value } of getIndexableTags(event)) {
			await subs.tag.put(tagKey(name, value, event.created_at, id), id)
		}

		// Index expiration if present
		const expiry = getExpiration(event)
		if (expiry !== null) {
			await subs.expiration.put(expirationKey(expiry, id), id)
		}

		// Emit for live subscriptions (outside of apply, via event loop)
		process.nextTick(() => this.emit('event:stored', event))
	}

	private async applyDelete(subs: IndexSubs, deletionEvent: NostrEvent): Promise<void> {
		// NIP-09: kind 5 events delete events by their referenced 'e' tags
		// Only the original author can delete their own events
		const eTags = deletionEvent.tags.filter((t) => t[0] === 'e')

		for (const tag of eTags) {
			const targetId = tag[1]
			if (!targetId) continue

			const targetEntry = await subs.events.get(eventKey(targetId))
			if (!targetEntry) {
				// Mark as deleted anyway to prevent future insertion
				await subs.deletion.put(deletionKey(targetId), deletionEvent.id)
				continue
			}

			const targetEvent = targetEntry.value as NostrEvent

			// Only the author can delete their own events
			if (targetEvent.pubkey !== deletionEvent.pubkey) continue

			// Remove the target event and all its indexes
			await this.removeIndexes(subs, targetEvent)
			await subs.events.del(eventKey(targetId))

			// Track the deletion
			await subs.deletion.put(deletionKey(targetId), deletionEvent.id)
		}

		// Store the deletion event itself (it's a regular event)
		await this.applyPut(subs, deletionEvent)
	}

	private async removeIndexes(subs: IndexSubs, event: NostrEvent): Promise<void> {
		const id = event.id
		await subs.kind.del(kindKey(event.kind, event.created_at, id))
		await subs.author.del(authorKey(event.pubkey, event.created_at, id))
		await subs.authorKind.del(authorKindKey(event.pubkey, event.kind, event.created_at, id))
		await subs.createdAt.del(createdAtKey(event.created_at, id))

		for (const { name, value } of getIndexableTags(event)) {
			await subs.tag.del(tagKey(name, value, event.created_at, id))
		}

		const expiry = getExpiration(event)
		if (expiry !== null) {
			await subs.expiration.del(expirationKey(expiry, id))
		}

		// Clean up replaceable/addressable pointers
		const kind = classifyKind(event.kind)
		if (kind === 'replaceable') {
			await subs.replaceable.del(replaceableKey(event.pubkey, event.kind))
		}
		if (kind === 'addressable') {
			await subs.addressable.del(addressableKey(event.pubkey, event.kind, getDTag(event)))
		}
	}
}
