import { afterAll, describe, expect, it } from 'vitest'
import { EventStore } from '../../src/storage/store.js'
import { createSignedEvent, tempStorage, waitFor } from '../helpers.js'

describe('NIP-40 expiration reclaim', () => {
	const stores: EventStore[] = []

	async function founderStore(): Promise<EventStore> {
		const s = new EventStore(tempStorage(), null)
		await s.ready()
		stores.push(s)
		return s
	}

	/** Wait until the event is materialized in the view */
	async function waitStored(store: EventStore, id: string): Promise<void> {
		await waitFor(async () => (await store.indexes.events.get(id)) !== null, {
			timeout: 10_000,
			interval: 50,
		})
	}

	afterAll(async () => {
		for (const s of stores) await s.close()
	})

	it('lists and reclaims events whose expiration has passed', async () => {
		const store = await founderStore()
		const past = Math.floor(Date.now() / 1000) - 3600
		const { event } = createSignedEvent({
			content: 'expired',
			tags: [['expiration', String(past)]],
		})
		await store.putEvent(event)
		await waitStored(store, event.id)

		const now = Math.floor(Date.now() / 1000)
		const expired = await store.listExpired(now, 100)
		expect(expired).toContain(event.id)

		await store.expireEvents([event.id])
		await waitFor(async () => (await store.indexes.events.get(event.id)) === null, {
			timeout: 10_000,
			interval: 50,
		})
		// The expiration index entry is cleaned up too (no resurrection on re-scan).
		expect(await store.listExpired(now, 100)).not.toContain(event.id)
	})

	it('does not list or reclaim events expiring in the future', async () => {
		const store = await founderStore()
		const future = Math.floor(Date.now() / 1000) + 3600
		const { event } = createSignedEvent({
			content: 'not yet expired',
			tags: [['expiration', String(future)]],
		})
		await store.putEvent(event)
		await waitStored(store, event.id)

		const now = Math.floor(Date.now() / 1000)
		expect(await store.listExpired(now, 100)).not.toContain(event.id)
	})

	it('refuses to reclaim an event that never declared an expiration (no censorship)', async () => {
		const store = await founderStore()
		const { event } = createSignedEvent({ content: 'permanent, no expiration tag' })
		await store.putEvent(event)
		await waitStored(store, event.id)

		// An expiry_delete naming a non-expiring event must be a no-op in apply.
		await store.expireEvents([event.id])
		// Give apply time to process the op, then confirm the event survived.
		await new Promise((r) => setTimeout(r, 1500))
		expect(await store.indexes.events.get(event.id)).not.toBeNull()
	})
})
