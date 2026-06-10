import { EventEmitter } from 'node:events'
import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import {
	classifyKind,
	getDTag,
	getExpiration,
	getIndexableTags,
	isProtected,
	shouldReplace,
	validateEventStructure,
	verifyEventSignature,
} from '../nostr/events.js'
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
import { type IndexSubs, createSubs } from './indexes.js'

/**
 * Version of the deterministic consensus rules implemented by apply().
 * Ops carrying a higher `v` halt the node (host.interrupt) instead of diverging.
 */
export const CONSENSUS_VERSION = 1

/** Bound on the 'event:stored' emission-dedup LRU */
const STORED_EMIT_LRU_MAX = 4096

/**
 * Tombstone recorded in the deletion sub.
 * A tombstone only blocks future puts authored by the same pubkey — forged
 * tombstones from other pubkeys must never censor. Legacy (pre-multiwriter)
 * records are plain strings and block unconditionally.
 */
interface Tombstone {
	/** id of the kind-5 deletion event */
	id: string
	/** pubkey of the deleter */
	pubkey: string
}

export class EventStore extends EventEmitter {
	readonly corestore: Corestore
	readonly base: Autobase
	private subs: IndexSubs | null = null
	private subsView: Hyperbee | null = null
	/** Insertion-ordered id set used to dedup 'event:stored' emissions (reorgs re-run applyPut) */
	private readonly emittedStoredIds = new Set<string>()

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
			// Reserved now (constructor-gated; cannot be retrofitted without a
			// consensus bump). v1's apply never acks optimistic blocks, so they
			// are always rolled back — kept for v2 self-verifying writes.
			optimistic: true,
		})
	}

	get view(): Hyperbee {
		return this.base.view
	}

	get indexes(): IndexSubs {
		// Fast-forward can swap base.view identity; cached subs must follow it
		// or readers would serve a stale, no-longer-updated snapshot.
		const view = this.view
		if (!this.subs || this.subsView !== view) {
			this.subsView = view
			this.subs = createSubs(view)
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

	/**
	 * The deterministic apply function for Autobase linearization.
	 *
	 * This is a versioned consensus protocol (CONSENSUS_VERSION): every rule
	 * must be deterministic and config-free, because all peers of one base
	 * re-run it over the same ops and must materialize identical views.
	 */
	private async apply(nodes: any[], view: Hyperbee, host: any): Promise<void> {
		// Create sub-databases from the view directly.
		// Autobase already handles atomicity for the apply function.
		const subs = createSubs(view)

		for (const node of nodes) {
			if (node.value === null) continue // skip ack nodes

			const op = node.value as StoreOp

			// Ops from a newer consensus version halt the node rather than diverge.
			// host.interrupt throws — it must never be swallowed by the catch below.
			if (op.v !== undefined && op.v > CONSENSUS_VERSION) {
				host.interrupt('unsupported op version')
			}

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
		// Consensus rule: re-validate everything. Replicated ops are never
		// trusted — admitted writers cannot bypass WS-edge validation.
		if (!validateEventStructure(event) || !verifyEventSignature(event)) return

		// NIP-70: a replicated store cannot honor "don't propagate" — skip unconditionally
		if (isProtected(event)) return

		const id = event.id

		// Dedup: skip if event already exists
		const existing = await subs.events.get(eventKey(id))
		if (existing) return

		// Tombstone check: object tombstones only block a put when the deleter
		// is the event's author (kills the forged-tombstone censorship vector
		// and makes delete-before-put ordering safe). Legacy string tombstones
		// (pre-upgrade single-node data) block unconditionally.
		const deleted = await subs.deletion.get(deletionKey(id))
		if (deleted) {
			const tombstone = deleted.value as Tombstone | string
			if (typeof tombstone === 'string') return
			if (tombstone && tombstone.pubkey === event.pubkey) return
		}

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
		await subs.authorKind.put(authorKindKey(event.pubkey, event.kind, event.created_at, id), id)
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
		this.emitStored(event)
	}

	private async applyDelete(subs: IndexSubs, deletionEvent: NostrEvent): Promise<void> {
		// Consensus rule: the kind-5 itself must be structurally valid and signed.
		// This also drops legacy forged prune ops (unsigned synthetic deletions).
		if (!validateEventStructure(deletionEvent) || !verifyEventSignature(deletionEvent)) return

		// NIP-09: kind 5 events delete events by their referenced 'e' tags
		// Only the original author can delete their own events
		const eTags = deletionEvent.tags.filter((t) => t[0] === 'e')

		for (const tag of eTags) {
			const targetId = tag[1]
			if (!targetId) continue

			const targetEntry = await subs.events.get(eventKey(targetId))
			if (targetEntry) {
				const targetEvent = targetEntry.value as NostrEvent

				// Only the author can delete their own events
				if (targetEvent.pubkey === deletionEvent.pubkey) {
					// Remove the target event and all its indexes
					await this.removeIndexes(subs, targetEvent)
					await subs.events.del(eventKey(targetId))
				}
			}

			// Always record the tombstone; the put path scopes its blocking
			// power to the deleter's own pubkey.
			await subs.deletion.put(deletionKey(targetId), {
				id: deletionEvent.id,
				pubkey: deletionEvent.pubkey,
			} satisfies Tombstone)
		}

		// Store the deletion event itself (a regular event, re-validated by applyPut)
		await this.applyPut(subs, deletionEvent)
	}

	/** Emit 'event:stored' at most once per event id (bounded LRU — reorgs re-run applyPut) */
	private emitStored(event: NostrEvent): void {
		if (this.emittedStoredIds.has(event.id)) {
			// Refresh recency
			this.emittedStoredIds.delete(event.id)
			this.emittedStoredIds.add(event.id)
			return
		}
		this.emittedStoredIds.add(event.id)
		if (this.emittedStoredIds.size > STORED_EMIT_LRU_MAX) {
			const oldest = this.emittedStoredIds.values().next().value
			if (oldest !== undefined) this.emittedStoredIds.delete(oldest)
		}
		process.nextTick(() => this.emit('event:stored', event))
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

		// Clean up replaceable/addressable pointers — but only when they still
		// reference the deleted event. Deleting a superseded version must not
		// orphan the pointer to its replacement.
		const kind = classifyKind(event.kind)
		if (kind === 'replaceable') {
			const rKey = replaceableKey(event.pubkey, event.kind)
			const pointer = await subs.replaceable.get(rKey)
			if (pointer && pointer.value === id) {
				await subs.replaceable.del(rKey)
			}
		}
		if (kind === 'addressable') {
			const aKey = addressableKey(event.pubkey, event.kind, getDTag(event))
			const pointer = await subs.addressable.get(aKey)
			if (pointer && pointer.value === id) {
				await subs.addressable.del(aKey)
			}
		}
	}
}
