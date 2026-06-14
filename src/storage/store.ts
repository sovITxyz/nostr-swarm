import { EventEmitter } from 'node:events'
import Autobase, { type AutobaseApplyHost, type AutobaseApplyNode } from 'autobase'
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
import { encodeInvite } from '../util/invite.js'
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

/**
 * Hard cap on admitted writers, enforced deterministically in apply()
 * (the writers-sub count is part of the view). Bounds add_writer spam.
 */
export const MAX_WRITERS = 64

/** Bound on the 'event:stored' emission-dedup LRU */
const STORED_EMIT_LRU_MAX = 4096

/** Writer keys are the joiner's base.local.key as 64 lowercase hex */
const WRITER_KEY_RE = /^[0-9a-f]{64}$/

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
			// biome-ignore lint/suspicious/noExplicitAny: untyped holepunch view store
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

		// Re-emit base lifecycle events: 'writable' fires when this node's
		// add_writer op has been applied (a joiner needs no restart), 'update'
		// after every drain (used by pollers/tests instead of busy-waiting).
		this.base.on('writable', () => this.emit('writable'))
		this.base.on('update', () => this.emit('update'))
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

	/** Whether this node can append ops (founder, or admitted via add_writer) */
	get writable(): boolean {
		return this.base.writable
	}

	/** This node's writer key (base.local.key) — what an operator sends out-of-band to be admitted */
	get localWriterKey(): Buffer {
		return this.base.local.key
	}

	/** True when this node founded the base (base.key === base.local.key) */
	get isFounder(): boolean {
		const key = this.base.key
		if (key === null) return false
		return key.equals(this.base.local.key)
	}

	async ready(): Promise<void> {
		await this.base.ready()
		const baseKey = this.base.key
		if (baseKey) {
			// Logged prominently: the invite is what operators paste into
			// --bootstrap; the writer key is what gets sent for admission.
			logger.info('Event store ready', {
				invite: encodeInvite(baseKey),
				baseKey: baseKey.toString('hex'),
				writerKey: this.localWriterKey.toString('hex'),
				founder: this.isFounder,
				writable: this.writable,
			})
		}
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
	 * Append an add_writer op for an operator-approved joiner.
	 * This is a pre-check for fast feedback — apply() is authoritative
	 * (it re-checks dedup and the cap deterministically against the view).
	 * Throws when this node is not writable (only writers can admit).
	 */
	async admitWriter(keyHex: string): Promise<'appended' | 'already-admitted' | 'cap-reached'> {
		if (!this.writable) {
			throw new Error('not writable: only an admitted writer (or the founder) can admit writers')
		}
		const key = keyHex.toLowerCase()
		if (!WRITER_KEY_RE.test(key)) {
			throw new Error(`invalid writer key: expected 64 hex chars, got '${keyHex}'`)
		}
		// The founder's writer key is the base key itself — implicitly admitted
		if (this.base.key && key === this.base.key.toString('hex')) return 'already-admitted'
		const subs = this.indexes
		if (await subs.writers.get(key)) return 'already-admitted'
		if ((await this.countWriters(subs)) >= MAX_WRITERS) return 'cap-reached'
		await this.base.append({ type: 'add_writer', key } satisfies StoreOp)
		return 'appended'
	}

	/**
	 * Whether `keyHex` is already an admitted writer. The founder's own writer
	 * key (the base key) is implicit and counts as admitted. Used by the v2
	 * admission granter to dedup before spending a rate-limit token.
	 */
	async isAdmittedWriter(keyHex: string): Promise<boolean> {
		const key = keyHex.toLowerCase()
		if (!WRITER_KEY_RE.test(key)) return false
		if (this.base.key && key === this.base.key.toString('hex')) return true
		return (await this.indexes.writers.get(key)) !== null
	}

	/** All admitted writer keys (64-hex), excluding the implicit founder */
	async listWriters(): Promise<string[]> {
		const keys: string[] = []
		for await (const entry of this.indexes.writers.createReadStream()) {
			keys.push(entry.key)
		}
		return keys
	}

	/** Count entries in the writers sub (cap enforcement; bounded by MAX_WRITERS) */
	private async countWriters(subs: IndexSubs): Promise<number> {
		let count = 0
		for await (const _ of subs.writers.createReadStream()) count++
		return count
	}

	/**
	 * The deterministic apply function for Autobase linearization.
	 *
	 * This is a versioned consensus protocol (CONSENSUS_VERSION): every rule
	 * must be deterministic and config-free, because all peers of one base
	 * re-run it over the same ops and must materialize identical views.
	 */
	private async apply(
		nodes: AutobaseApplyNode[],
		view: Hyperbee,
		host: AutobaseApplyHost,
	): Promise<void> {
		// Create sub-databases from the view directly.
		// Autobase already handles atomicity for the apply function.
		const subs = createSubs(view)

		for (const node of nodes) {
			if (node.value === null) continue // skip ack nodes

			// Skip optimistic blocks: v1 never accepts speculative appends from
			// non-writers. The `optimistic: true` constructor option is reserved
			// for a v2 self-verifying-write path, but enabling it lets any peer
			// holding only the read invite append blocks. Acting on such a block
			// here is unsafe: an `add_writer` for the appender's own key would
			// make autobase treat the optimistic block as acked (it grows that
			// writer's system length) and durably admit an unvetted writer, and a
			// `v > CONSENSUS_VERSION` op would trip host.interrupt — a permanent,
			// swarm-wide halt — on untrusted input. Skipping leaves the writer's
			// system length unchanged so autobase rolls the block back.
			if (node.optimistic) continue

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
				} else if (op.type === 'add_writer') {
					await this.applyAddWriter(subs, op.key, node, host)
				}
			} catch (err) {
				logger.error('Error in apply', { error: String(err), type: op.type })
			}
		}
	}

	/**
	 * Consensus rule 3 (§3.3): admit a writer. All checks read only the view
	 * (deterministic, config-free). Admissions always use { indexer: false }:
	 * the founder stays the sole indexer, so checkpoint liveness never depends
	 * on churny peers.
	 */
	private async applyAddWriter(
		subs: IndexSubs,
		key: string,
		node: AutobaseApplyNode,
		host: AutobaseApplyHost,
	): Promise<void> {
		if (typeof key !== 'string' || !WRITER_KEY_RE.test(key)) return
		// The founder's writer key is the base key itself — implicit, never in
		// the sub, and must never be re-added (could demote its indexer status).
		if (key === host.key.toString('hex')) return
		if (await subs.writers.get(key)) return // duplicate add_writer is a no-op
		if ((await this.countWriters(subs)) >= MAX_WRITERS) return
		await host.addWriter(Buffer.from(key, 'hex'), { indexer: false })
		await subs.writers.put(key, { addedBy: node.from.key.toString('hex') })
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
