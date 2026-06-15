import { afterAll, describe, expect, it } from 'vitest'
import { LightStore } from '../../src/light/store.js'
import { EventStore } from '../../src/storage/store.js'
import { loadWotConfig } from '../../src/util/config.js'
import type { LightClientConfig } from '../../src/util/types.js'
import { createSignedEvent, tempStorage, waitFor } from '../helpers.js'

describe('LightStore.prune (storage budget)', () => {
	const stores: EventStore[] = []
	const wotConfig = loadWotConfig({ ownerPubkey: 'a'.repeat(64) })

	function lightConfig(maxStorageBytes: number): LightClientConfig {
		return { enabled: true, maxStorageBytes, pruneIntervalMs: 0 }
	}

	async function founderStore(): Promise<EventStore> {
		const s = new EventStore(tempStorage(), null)
		await s.ready()
		stores.push(s)
		return s
	}

	afterAll(async () => {
		for (const s of stores) await s.close()
	})

	it('evicts oldest non-exempt events over budget, keeping newest and exempt kinds', async () => {
		const store = await founderStore()
		const big = 'x'.repeat(1000) // ~1 KB per event so the budget is easy to exceed

		// Six kind-1 events, ascending created_at.
		const ids: string[] = []
		for (let i = 0; i < 6; i++) {
			const { event } = createSignedEvent({ content: big, created_at: 1_000 + i })
			await store.putEvent(event)
			ids.push(event.id)
		}
		// One exempt kind-0 (profile) — must never be pruned.
		const { event: profile } = createSignedEvent({ kind: 0, content: 'profile' })
		await store.putEvent(profile)

		await waitFor(async () => (await store.indexes.events.get(ids[5] as string)) !== null, {
			timeout: 10_000,
			interval: 50,
		})

		// Budget that holds only ~2-3 events; prune evicts oldest first.
		const light = new LightStore(store, wotConfig, lightConfig(3000))
		await light.prune()

		// Oldest is gone; newest and the exempt profile survive.
		await waitFor(async () => (await store.indexes.events.get(ids[0] as string)) === null, {
			timeout: 10_000,
			interval: 50,
		})
		expect(await store.indexes.events.get(ids[5] as string)).not.toBeNull()
		expect(await store.indexes.events.get(profile.id)).not.toBeNull()
	})

	it('is a no-op (no throw) on a read-only replica it cannot write', async () => {
		// Joiner-style store bootstrapped to a base it did not found: never writable.
		const store = new EventStore(tempStorage(), Buffer.alloc(32, 7))
		await store.ready()
		stores.push(store)
		expect(store.writable).toBe(false)

		const light = new LightStore(store, wotConfig, lightConfig(1))
		await expect(light.prune()).resolves.toBeUndefined()
	})
})
