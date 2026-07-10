import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countFilters, queryFilter, queryFilters } from '../../src/storage/query.js'
import { EventStore } from '../../src/storage/store.js'
import { replaceableKey } from '../../src/util/keys.js'
import type { NostrEvent } from '../../src/util/types.js'
import { createSignedEvent, tempStorage } from '../helpers.js'

describe('EventStore', () => {
	let store: EventStore

	beforeEach(async () => {
		store = new EventStore(tempStorage())
		await store.ready()
	})

	afterEach(async () => {
		await store.close()
	})

	async function put(...events: Parameters<typeof store.putEvent>[0][]) {
		for (const event of events) {
			await store.putEvent(event)
		}
		await store.update()
	}

	async function del(deletionEvent: Parameters<typeof store.deleteEvent>[0]) {
		await store.deleteEvent(deletionEvent)
		await store.update()
	}

	describe('save and retrieve', () => {
		it('round-trips all event fields', async () => {
			const { event } = createSignedEvent({
				kind: 1,
				content: 'hello nostr',
				tags: [['t', 'test']],
			})
			await put(event)

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(1)
			const stored = events[0]!
			expect(stored.id).toBe(event.id)
			expect(stored.pubkey).toBe(event.pubkey)
			expect(stored.created_at).toBe(event.created_at)
			expect(stored.kind).toBe(event.kind)
			expect(stored.content).toBe(event.content)
			expect(stored.tags).toEqual(event.tags)
			expect(stored.sig).toBe(event.sig)
		})

		it('returns empty for nonexistent ID', async () => {
			const { events } = await queryFilter(store.indexes, { ids: ['a'.repeat(64)] })
			expect(events).toHaveLength(0)
		})
	})

	describe('deduplication', () => {
		it('ignores duplicate events', async () => {
			const { event } = createSignedEvent()
			await put(event)
			await put(event)

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(1)
		})
	})

	describe('query filters', () => {
		it('filters by kind', async () => {
			const { event: e1 } = createSignedEvent({ kind: 1 })
			const { event: e7 } = createSignedEvent({ kind: 7 })
			await put(e1, e7)

			const { events } = await queryFilter(store.indexes, { kinds: [7] })
			expect(events).toHaveLength(1)
			expect(events[0]!.id).toBe(e7.id)
		})

		it('filters by author', async () => {
			const { event: e1 } = createSignedEvent({ content: 'author-1' })
			const { event: e2 } = createSignedEvent({ content: 'author-2' })
			await put(e1, e2)

			const { events } = await queryFilter(store.indexes, { authors: [e1.pubkey] })
			expect(events).toHaveLength(1)
			expect(events[0]!.id).toBe(e1.id)
		})

		it('filters by author + kind', async () => {
			const { event: e1, sk } = createSignedEvent({ kind: 1 })
			const { event: e7 } = createSignedEvent({ kind: 7, sk })
			const { event: other } = createSignedEvent({ kind: 7 })
			await put(e1, e7, other)

			const { events } = await queryFilter(store.indexes, {
				authors: [e1.pubkey],
				kinds: [7],
			})
			expect(events).toHaveLength(1)
			expect(events[0]!.id).toBe(e7.id)
		})

		it('filters by time range (since/until)', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { event: old } = createSignedEvent({ created_at: now - 100 })
			const { event: mid } = createSignedEvent({ created_at: now - 50 })
			const { event: recent } = createSignedEvent({ created_at: now })
			await put(old, mid, recent)

			const { events } = await queryFilter(store.indexes, {
				since: now - 75,
				until: now - 25,
			})
			expect(events).toHaveLength(1)
			expect(events[0]!.id).toBe(mid.id)
		})

		it('filters by tag', async () => {
			const { event: e1 } = createSignedEvent({ tags: [['t', 'bitcoin']] })
			const { event: e2 } = createSignedEvent({ tags: [['t', 'nostr']] })
			await put(e1, e2)

			const { events } = await queryFilter(store.indexes, { '#t': ['bitcoin'] })
			expect(events).toHaveLength(1)
			expect(events[0]!.id).toBe(e1.id)
		})

		it('returns newest first', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { event: older, sk } = createSignedEvent({ created_at: now - 10 })
			const { event: newer } = createSignedEvent({ created_at: now, sk })
			await put(older, newer)

			const events = await queryFilters(store.indexes, [{ authors: [older.pubkey] }])
			expect(events).toHaveLength(2)
			expect(events[0]!.id).toBe(newer.id)
			expect(events[1]!.id).toBe(older.id)
		})

		it('respects limit', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { event: e1, sk } = createSignedEvent({ created_at: now - 20 })
			const { event: e2 } = createSignedEvent({ created_at: now - 10, sk })
			const { event: e3 } = createSignedEvent({ created_at: now, sk })
			await put(e1, e2, e3)

			const { events } = await queryFilter(store.indexes, {
				authors: [e1.pubkey],
				limit: 2,
			})
			expect(events).toHaveLength(2)
		})

		it('multi-author + limit returns the globally newest events', async () => {
			const now = Math.floor(Date.now() / 1000)
			// Author A (listed FIRST) owns >= limit OLDER events
			const { event: a1, sk: skA } = createSignedEvent({ created_at: now - 30 })
			const { event: a2 } = createSignedEvent({ created_at: now - 20, sk: skA })
			const { event: aNewest } = createSignedEvent({ created_at: now - 10, sk: skA })
			// Author B owns the single newest event
			const { event: bNewest } = createSignedEvent({ created_at: now })
			await put(a1, a2, aNewest, bNewest)

			const { events } = await queryFilter(store.indexes, {
				authors: [a1.pubkey, bNewest.pubkey],
				limit: 2,
			})
			expect(events.map((e) => e.id)).toEqual([bNewest.id, aNewest.id])
		})

		it('multi-kind + limit returns the globally newest events', async () => {
			const now = Math.floor(Date.now() / 1000)
			// Kind 1 (listed FIRST) owns >= limit OLDER events
			const { event: k1a } = createSignedEvent({ kind: 1, created_at: now - 30 })
			const { event: k1b } = createSignedEvent({ kind: 1, created_at: now - 20 })
			const { event: k1Newest } = createSignedEvent({ kind: 1, created_at: now - 10 })
			// Kind 7 owns the single newest event
			const { event: k7Newest } = createSignedEvent({ kind: 7, created_at: now })
			await put(k1a, k1b, k1Newest, k7Newest)

			const { events } = await queryFilter(store.indexes, {
				kinds: [1, 7],
				limit: 2,
			})
			expect(events.map((e) => e.id)).toEqual([k7Newest.id, k1Newest.id])
		})

		it('multi-tag-value + limit returns the globally newest events', async () => {
			const now = Math.floor(Date.now() / 1000)
			// Tag value 'x' (listed FIRST) owns >= limit OLDER events
			const { event: x1 } = createSignedEvent({ tags: [['t', 'x']], created_at: now - 30 })
			const { event: x2 } = createSignedEvent({ tags: [['t', 'x']], created_at: now - 20 })
			const { event: xNewest } = createSignedEvent({ tags: [['t', 'x']], created_at: now - 10 })
			// Tag value 'y' owns the single newest event
			const { event: yNewest } = createSignedEvent({ tags: [['t', 'y']], created_at: now })
			await put(x1, x2, xNewest, yNewest)

			const { events } = await queryFilter(store.indexes, {
				'#t': ['x', 'y'],
				limit: 2,
			})
			expect(events.map((e) => e.id)).toEqual([yNewest.id, xNewest.id])
		})

		it('deduplicates an event matched by multiple tag values', async () => {
			const { event } = createSignedEvent({
				tags: [
					['t', 'x'],
					['t', 'y'],
				],
			})
			await put(event)

			const { events, count } = await queryFilter(store.indexes, { '#t': ['x', 'y'] })
			expect(events).toHaveLength(1)
			expect(count).toBe(1)
			expect(events[0]!.id).toBe(event.id)
		})

		it('does not serve expired events on read (NIP-40)', async () => {
			const now = Math.floor(Date.now() / 1000)
			// putEvent bypasses the ingest expiration guard
			const { event: expired } = createSignedEvent({
				tags: [['expiration', String(now - 3600)]],
			})
			await put(expired)

			const { events } = await queryFilter(store.indexes, { ids: [expired.id] })
			expect(events).toHaveLength(0)

			const count = await countFilters(store.indexes, [{ ids: [expired.id] }])
			expect(count).toBe(0)
		})

		it('matches events by id prefix', async () => {
			const { event } = createSignedEvent({ content: 'find me by prefix' })
			await put(event)

			const { events } = await queryFilter(store.indexes, { ids: [event.id.slice(0, 10)] })
			expect(events).toHaveLength(1)
			expect(events[0]!.id).toBe(event.id)
		})

		it('filters by NIP-50 search', async () => {
			const { event: match } = createSignedEvent({ content: 'contains the needleterm here' })
			const { event: other } = createSignedEvent({ content: 'nothing to see' })
			await put(match, other)

			const { events } = await queryFilter(store.indexes, { search: 'needleterm' })
			expect(events).toHaveLength(1)
			expect(events[0]!.id).toBe(match.id)
		})
	})

	describe('replaceable events', () => {
		it('kind 0: keeps only the newest per pubkey', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { sk, pubkey } = createSignedEvent()
			const { event: old } = createSignedEvent({
				kind: 0,
				content: 'old profile',
				created_at: now - 10,
				sk,
			})
			const { event: newer } = createSignedEvent({
				kind: 0,
				content: 'new profile',
				created_at: now,
				sk,
			})
			await put(old, newer)

			const { events } = await queryFilter(store.indexes, { kinds: [0], authors: [pubkey] })
			expect(events).toHaveLength(1)
			expect(events[0]!.content).toBe('new profile')
		})

		it('kind 0: rejects older replacement', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { sk, pubkey } = createSignedEvent()
			const { event: newer } = createSignedEvent({ kind: 0, content: 'new', created_at: now, sk })
			const { event: old } = createSignedEvent({
				kind: 0,
				content: 'old',
				created_at: now - 10,
				sk,
			})
			await put(newer)
			await put(old) // should be rejected

			const { events } = await queryFilter(store.indexes, { kinds: [0], authors: [pubkey] })
			expect(events).toHaveLength(1)
			expect(events[0]!.content).toBe('new')
		})

		it('kind 3: replaceable contact list', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { sk, pubkey } = createSignedEvent()
			const { event: old } = createSignedEvent({
				kind: 3,
				content: 'old contacts',
				created_at: now - 10,
				sk,
			})
			const { event: newer } = createSignedEvent({
				kind: 3,
				content: 'new contacts',
				created_at: now,
				sk,
			})
			await put(old, newer)

			const { events } = await queryFilter(store.indexes, { kinds: [3], authors: [pubkey] })
			expect(events).toHaveLength(1)
			expect(events[0]!.content).toBe('new contacts')
		})

		it('kind 10002: replaceable relay list', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { sk, pubkey } = createSignedEvent()
			const { event: old } = createSignedEvent({
				kind: 10002,
				content: 'old',
				created_at: now - 10,
				sk,
			})
			const { event: newer } = createSignedEvent({
				kind: 10002,
				content: 'new',
				created_at: now,
				sk,
			})
			await put(old, newer)

			const { events } = await queryFilter(store.indexes, { kinds: [10002], authors: [pubkey] })
			expect(events).toHaveLength(1)
			expect(events[0]!.content).toBe('new')
		})
	})

	describe('addressable events (kind 30000-39999)', () => {
		it('replaces by pubkey + kind + d-tag', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { sk, pubkey } = createSignedEvent()
			const { event: old } = createSignedEvent({
				kind: 30023,
				content: 'v1',
				tags: [['d', 'my-article']],
				created_at: now - 10,
				sk,
			})
			const { event: newer } = createSignedEvent({
				kind: 30023,
				content: 'v2',
				tags: [['d', 'my-article']],
				created_at: now,
				sk,
			})
			await put(old, newer)

			const { events } = await queryFilter(store.indexes, {
				kinds: [30023],
				authors: [pubkey],
			})
			expect(events).toHaveLength(1)
			expect(events[0]!.content).toBe('v2')
		})

		it('rejects older addressable replacement', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { sk, pubkey } = createSignedEvent()
			const { event: newer } = createSignedEvent({
				kind: 30023,
				content: 'new',
				tags: [['d', 'post']],
				created_at: now,
				sk,
			})
			const { event: old } = createSignedEvent({
				kind: 30023,
				content: 'old',
				tags: [['d', 'post']],
				created_at: now - 10,
				sk,
			})
			await put(newer)
			await put(old)

			const { events } = await queryFilter(store.indexes, {
				kinds: [30023],
				authors: [pubkey],
			})
			expect(events).toHaveLength(1)
			expect(events[0]!.content).toBe('new')
		})

		it('different d-tags are stored separately', async () => {
			const { sk, pubkey } = createSignedEvent()
			const { event: e1 } = createSignedEvent({
				kind: 30023,
				content: 'article 1',
				tags: [['d', 'article-1']],
				sk,
			})
			const { event: e2 } = createSignedEvent({
				kind: 30023,
				content: 'article 2',
				tags: [['d', 'article-2']],
				sk,
			})
			await put(e1, e2)

			const { events } = await queryFilter(store.indexes, {
				kinds: [30023],
				authors: [pubkey],
			})
			expect(events).toHaveLength(2)
		})
	})

	describe('ephemeral events (kind 20000-29999)', () => {
		it('does not store ephemeral events', async () => {
			const { event } = createSignedEvent({ kind: 20001 })
			await put(event)

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(0)
		})
	})

	describe('NIP-09 deletion', () => {
		it('deletes own events', async () => {
			const { event, sk } = createSignedEvent({ content: 'to delete' })
			await put(event)

			const { event: delEvent } = createSignedEvent({
				kind: 5,
				tags: [['e', event.id]],
				sk,
			})
			await del(delEvent)

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(0)
		})

		it('cannot delete events by other authors', async () => {
			const { event } = createSignedEvent({ content: 'protected' })
			await put(event)

			// Different author tries to delete
			const { event: delEvent } = createSignedEvent({
				kind: 5,
				tags: [['e', event.id]],
			})
			await del(delEvent)

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(1)
			expect(events[0]!.content).toBe('protected')
		})

		it('prevents re-insertion of deleted events', async () => {
			const { event, sk } = createSignedEvent({ content: 'delete me' })
			await put(event)

			const { event: delEvent } = createSignedEvent({
				kind: 5,
				tags: [['e', event.id]],
				sk,
			})
			await del(delEvent)

			// Try to re-insert
			await put(event)

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(0)
		})

		it('deletes multiple events in one deletion', async () => {
			const { event: e1, sk } = createSignedEvent({ content: 'first' })
			const { event: e2 } = createSignedEvent({ content: 'second', sk })
			await put(e1, e2)

			const { event: delEvent } = createSignedEvent({
				kind: 5,
				tags: [
					['e', e1.id],
					['e', e2.id],
				],
				sk,
			})
			await del(delEvent)

			const { events: r1 } = await queryFilter(store.indexes, { ids: [e1.id] })
			const { events: r2 } = await queryFilter(store.indexes, { ids: [e2.id] })
			expect(r1).toHaveLength(0)
			expect(r2).toHaveLength(0)
		})
	})

	describe('counting', () => {
		it('counts matching events', async () => {
			const { sk } = createSignedEvent()
			const { event: e1 } = createSignedEvent({ kind: 1, content: 'first', sk })
			const { event: e2 } = createSignedEvent({ kind: 1, content: 'second', sk })
			const { event: e3 } = createSignedEvent({ kind: 7, content: 'reaction', sk })
			await put(e1, e2, e3)

			const count = await countFilters(store.indexes, [{ kinds: [1], authors: [e1.pubkey] }])
			expect(count).toBe(2)
		})

		it('deduplicates across multiple filter counts', async () => {
			const { event } = createSignedEvent({ kind: 1 })
			await put(event)

			// Both filters match the same event
			const count = await countFilters(store.indexes, [{ kinds: [1] }, { ids: [event.id] }])
			expect(count).toBe(1)
		})
	})

	describe('consensus hardening (apply re-validation)', () => {
		it('skips puts with a bad signature', async () => {
			const { event } = createSignedEvent({ content: 'original' })
			// Tamper with the content after signing — id/sig no longer verify
			const forged: NostrEvent = { ...event, content: 'tampered' }
			await put(forged)

			const { events } = await queryFilter(store.indexes, { ids: [forged.id] })
			expect(events).toHaveLength(0)
		})

		it('skips protected (NIP-70) events unconditionally', async () => {
			const { event } = createSignedEvent({ tags: [['-']] })
			await put(event)

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(0)
		})

		it('forged tombstone does not censor a later legitimate put', async () => {
			const { event } = createSignedEvent({ content: 'legit' })

			// Attacker (different key) "deletes" the event before it is stored
			const { event: forgedDelete } = createSignedEvent({
				kind: 5,
				tags: [['e', event.id]],
			})
			await del(forgedDelete)

			// The real author's put must still land
			await put(event)

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(1)
			expect(events[0]?.content).toBe('legit')
		})

		it("author's own tombstone blocks a put that arrives after the delete", async () => {
			const { event, sk } = createSignedEvent({ content: 'gone' })
			const { event: delEvent } = createSignedEvent({
				kind: 5,
				tags: [['e', event.id]],
				sk,
			})
			await del(delEvent)
			await put(event) // delete-before-put ordering

			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(0)
		})

		it('drops unsigned forged deletions entirely (no tombstone, no removal)', async () => {
			const { event } = createSignedEvent({ content: 'target' })
			await put(event)

			// Like the old light-client prune ops: unsigned synthetic kind 5
			await del({
				id: 'f'.repeat(64),
				pubkey: event.pubkey,
				created_at: Math.floor(Date.now() / 1000),
				kind: 5,
				tags: [['e', event.id]],
				content: 'pruned by WoT policy',
				sig: '',
			})

			// Still stored, and re-puttable (no tombstone was written)
			const { events } = await queryFilter(store.indexes, { ids: [event.id] })
			expect(events).toHaveLength(1)
		})

		it('preserves the replaceable pointer when deleting a superseded event', async () => {
			const now = Math.floor(Date.now() / 1000)
			const { sk, pubkey } = createSignedEvent()
			const { event: old } = createSignedEvent({
				kind: 0,
				content: 'old profile',
				created_at: now - 10,
				sk,
			})
			const { event: newer } = createSignedEvent({
				kind: 0,
				content: 'new profile',
				created_at: now,
				sk,
			})
			await put(old, newer)

			// Author deletes the superseded old version; the pointer references `newer`
			const { event: delEvent } = createSignedEvent({
				kind: 5,
				tags: [['e', old.id]],
				sk,
			})
			await del(delEvent)

			const pointer = await store.indexes.replaceable.get(replaceableKey(pubkey, 0))
			expect(pointer?.value).toBe(newer.id)

			// An even older profile must still be rejected as a replacement
			const { event: oldest } = createSignedEvent({
				kind: 0,
				content: 'oldest profile',
				created_at: now - 20,
				sk,
			})
			await put(oldest)

			const { events } = await queryFilter(store.indexes, { kinds: [0], authors: [pubkey] })
			expect(events).toHaveLength(1)
			expect(events[0]?.content).toBe('new profile')
		})

		it('halts (host.interrupt) on ops with a newer consensus version', async () => {
			const { event } = createSignedEvent()
			const interrupted = new Promise((resolve) => {
				store.base.once('interrupt', resolve)
			})

			// Append throws 'Autobase is closing' once the interrupt lands.
			// v:3 is above CONSENSUS_VERSION (2), so apply must halt.
			await store.base.append({ type: 'put', event, v: 3 }).catch(() => {})

			await expect(interrupted).resolves.toBe('unsupported op version')
		})
	})

	describe('multiple filters (OR logic)', () => {
		it('combines results across filters', async () => {
			const { event: e1 } = createSignedEvent({ kind: 1 })
			const { event: e7 } = createSignedEvent({ kind: 7 })
			await put(e1, e7)

			const events = await queryFilters(store.indexes, [{ kinds: [1] }, { kinds: [7] }])
			const ids = events.map((e) => e.id)
			expect(ids).toContain(e1.id)
			expect(ids).toContain(e7.id)
		})

		it('deduplicates across filters', async () => {
			const { event } = createSignedEvent({ kind: 1 })
			await put(event)

			const events = await queryFilters(store.indexes, [{ kinds: [1] }, { ids: [event.id] }])
			expect(events).toHaveLength(1)
		})
	})
})
