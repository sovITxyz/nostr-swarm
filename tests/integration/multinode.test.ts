import { randomBytes } from 'node:crypto'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import type { NostrSwarm } from '../../src/relay.js'
import { encodeInvite } from '../../src/util/invite.js'
import type { NostrEvent } from '../../src/util/types.js'
import {
	connectClient,
	createRelay,
	createSignedEvent,
	destroyTestnet,
	getTestnet,
	sendAndCollect,
	waitFor,
	waitForMessage,
} from '../helpers.js'

/** Rate limits high enough that waitFor polling never trips them */
const FAST_LIMITS = { eventRatePerSec: 1000, reqRatePerSec: 1000 }

let subCounter = 0

/** REQ events by id over an open client, fully draining the subscription (EOSE + CLOSED) */
async function queryIds(ws: WebSocket, ids: string[]): Promise<NostrEvent[]> {
	const subId = `mn-${subCounter++}`
	const results = await sendAndCollect(ws, ['REQ', subId, { ids }], 'EOSE')
	// Drain the CLOSED reply so it never leaks into a later waitForMessage
	await sendAndCollect(ws, ['CLOSE', subId], 'CLOSED')
	return results.filter((m) => m[0] === 'EVENT').map((m) => m[2] as NostrEvent)
}

/** Publish an EVENT and return the OK reply */
async function publish(ws: WebSocket, event: NostrEvent): Promise<unknown[]> {
	ws.send(JSON.stringify(['EVENT', event]))
	return waitForMessage(ws, 10_000)
}

describe('multi-node convergence (local testnet)', { timeout: 60_000 }, () => {
	let topic: string
	let invite: string
	let founder: NostrSwarm
	let joiner: NostrSwarm
	let light: NostrSwarm | null = null
	let wsFounder: WebSocket
	let wsJoiner: WebSocket
	const authorSk = generateSecretKey()

	beforeAll(async () => {
		await getTestnet()
		topic = `multinode-${randomBytes(8).toString('hex')}`

		founder = await createRelay({ relay: { topic, ...FAST_LIMITS } })
		const baseKey = founder.store.base.key
		if (!baseKey) throw new Error('founder base key missing after ready')
		invite = encodeInvite(baseKey)

		joiner = await createRelay({ relay: { topic, bootstrap: invite, ...FAST_LIMITS } })

		wsFounder = await connectClient(founder.config.port)
		wsJoiner = await connectClient(joiner.config.port)
	}, 60_000)

	afterAll(async () => {
		wsFounder?.close()
		wsJoiner?.close()
		if (light) await light.stop()
		await joiner.stop()
		await founder.stop()
		await destroyTestnet()
	}, 60_000)

	it('joiner deterministically opens the founder base', () => {
		const founderKey = founder.store.base.key
		const joinerKey = joiner.store.base.key
		expect(founderKey).not.toBeNull()
		expect(joinerKey).not.toBeNull()
		expect(founderKey !== null && joinerKey !== null && joinerKey.equals(founderKey)).toBe(true)
		expect(founder.store.isFounder).toBe(true)
		expect(founder.store.writable).toBe(true)
		expect(joiner.store.isFounder).toBe(false)
	})

	it('replicates founder events to the joiner (reads need no admission)', async () => {
		const { event } = createSignedEvent({ content: 'founder event', sk: authorSk })
		const ok = await publish(wsFounder, event)
		expect(ok[0]).toBe('OK')
		expect(ok[2]).toBe(true)

		await waitFor(async () => (await queryIds(wsJoiner, [event.id])).length === 1, {
			timeout: 45_000,
			interval: 500,
		})
	})

	it('blocks EVENT on the unadmitted joiner with the read-only OK', async () => {
		expect(joiner.store.writable).toBe(false)
		const { event } = createSignedEvent({ content: 'should be blocked' })
		const ok = await publish(wsJoiner, event)
		expect(ok).toEqual([
			'OK',
			event.id,
			false,
			'blocked: read-only replica awaiting writer admission',
		])
	})

	it('admitWriter makes the joiner writable without restart and writes flow back', async () => {
		const writerKey = joiner.store.localWriterKey.toString('hex')
		expect(await founder.store.admitWriter(writerKey)).toBe('appended')

		// The add_writer op replicates; the joiner's base emits 'writable'
		await waitFor(() => joiner.store.writable, { timeout: 45_000, interval: 250 })

		const { event } = createSignedEvent({ content: 'joiner write', sk: authorSk })
		const ok = await publish(wsJoiner, event)
		expect(ok[0]).toBe('OK')
		expect(ok[2]).toBe(true)

		await waitFor(async () => (await queryIds(wsFounder, [event.id])).length === 1, {
			timeout: 45_000,
			interval: 500,
		})

		// The admission is recorded once in the writers sub; re-admitting is a no-op
		expect(await founder.store.listWriters()).toEqual([writerKey])
		expect(await founder.store.admitWriter(writerKey)).toBe('already-admitted')
	})

	it('restarting the founder with the same --admit yields exactly one writers entry', async () => {
		const writerKey = joiner.store.localWriterKey.toString('hex')
		const storagePath = founder.config.storagePath
		wsFounder.close()
		await founder.stop()

		founder = await createRelay({
			relay: { topic, storagePath, admitWriters: [writerKey], ...FAST_LIMITS },
		})
		wsFounder = await connectClient(founder.config.port)

		expect(founder.store.isFounder).toBe(true)
		expect(await founder.store.listWriters()).toEqual([writerKey])
	})

	it('propagates an author-valid NIP-09 delete', async () => {
		// Write the target through the (now writable) joiner so the delete also
		// proves cross-writer enforcement, then delete through the founder.
		const { event: target } = createSignedEvent({ content: 'to be deleted', sk: authorSk })
		const okPut = await publish(wsJoiner, target)
		expect(okPut[2]).toBe(true)

		await waitFor(async () => (await queryIds(wsFounder, [target.id])).length === 1, {
			timeout: 45_000,
			interval: 500,
		})

		const { event: deletion } = createSignedEvent({
			kind: 5,
			content: '',
			tags: [['e', target.id]],
			sk: authorSk,
		})
		const okDel = await publish(wsFounder, deletion)
		expect(okDel[2]).toBe(true)

		await waitFor(
			async () =>
				(await queryIds(wsJoiner, [target.id])).length === 0 &&
				(await queryIds(wsJoiner, [deletion.id])).length === 1,
			{ timeout: 45_000, interval: 500 },
		)
	})

	it('light-client joiner never becomes writable and injects no kind-5 forgeries', async () => {
		light = await createRelay({
			relay: { topic, bootstrap: invite, ...FAST_LIMITS },
			wot: { ownerPubkey: getPublicKey(authorSk) },
			light: { enabled: true, pruneIntervalMs: 0 },
		})
		const lightRelay = light

		const founderKey = founder.store.base.key
		const lightKey = lightRelay.store.base.key
		expect(founderKey !== null && lightKey !== null && lightKey.equals(founderKey)).toBe(true)

		// Prove it replicates the shared base (reads work without admission)
		const { event: probe } = createSignedEvent({ content: 'light probe', sk: authorSk })
		const ok = await publish(wsFounder, probe)
		expect(ok[2]).toBe(true)
		await waitFor(async () => (await lightRelay.store.indexes.events.get(probe.id)) !== null, {
			timeout: 45_000,
			interval: 500,
		})

		// Never admitted: stays read-only, and its local input core stays empty
		expect(lightRelay.store.writable).toBe(false)
		expect(lightRelay.store.base.local.length).toBe(0)

		// prune() is a warn-once no-op — no forged unsigned kind-5 ops appended,
		// nothing deleted from the shared view
		await lightRelay.lightStore?.prune()
		await lightRelay.lightStore?.prune()
		expect(lightRelay.store.base.local.length).toBe(0)
		expect((await queryIds(wsFounder, [probe.id])).length).toBe(1)
	})
})
