import { randomBytes } from 'node:crypto'
import { generateSecretKey } from 'nostr-tools/pure'
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

const FAST_LIMITS = { eventRatePerSec: 1000, reqRatePerSec: 1000 }

let subCounter = 0

async function queryIds(ws: WebSocket, ids: string[]): Promise<NostrEvent[]> {
	const subId = `opt-${subCounter++}`
	const results = await sendAndCollect(ws, ['REQ', subId, { ids }], 'EOSE')
	await sendAndCollect(ws, ['CLOSE', subId], 'CLOSED')
	return results.filter((m) => m[0] === 'EVENT').map((m) => m[2] as NostrEvent)
}

async function publish(ws: WebSocket, event: NostrEvent): Promise<unknown[]> {
	ws.send(JSON.stringify(['EVENT', event]))
	return waitForMessage(ws, 10_000)
}

describe('optimistic self-verifying writes (local testnet)', { timeout: 120_000 }, () => {
	// Scenario A: founder opts in with --accept-optimistic.
	let founder: NostrSwarm
	let joiner: NostrSwarm
	let wsFounder: WebSocket
	let wsJoiner: WebSocket
	// Scenario B: founder did NOT opt in.
	let founderOff: NostrSwarm
	let joinerOff: NostrSwarm
	let wsJoinerOff: WebSocket

	const authorSk = generateSecretKey()

	beforeAll(async () => {
		await getTestnet()

		const topicA = `opt-on-${randomBytes(8).toString('hex')}`
		founder = await createRelay({
			relay: { topic: topicA, acceptOptimistic: true, ...FAST_LIMITS },
		})
		const baseKeyA = founder.store.base.key
		if (!baseKeyA) throw new Error('founder base key missing')
		// Joiner is NOT admitted and does NOT request writer status.
		joiner = await createRelay({
			relay: { topic: topicA, bootstrap: encodeInvite(baseKeyA), ...FAST_LIMITS },
		})

		const topicB = `opt-off-${randomBytes(8).toString('hex')}`
		founderOff = await createRelay({ relay: { topic: topicB, ...FAST_LIMITS } })
		const baseKeyB = founderOff.store.base.key
		if (!baseKeyB) throw new Error('founderOff base key missing')
		joinerOff = await createRelay({
			relay: { topic: topicB, bootstrap: encodeInvite(baseKeyB), ...FAST_LIMITS },
		})

		wsFounder = await connectClient(founder.config.port)
		wsJoiner = await connectClient(joiner.config.port)
		wsJoinerOff = await connectClient(joinerOff.config.port)
	}, 90_000)

	afterAll(async () => {
		for (const ws of [wsFounder, wsJoiner, wsJoinerOff]) ws?.close()
		await joiner?.stop()
		await founder?.stop()
		await joinerOff?.stop()
		await founderOff?.stop()
		await destroyTestnet()
	}, 60_000)

	it('the founder records the accept_optimistic consensus policy', async () => {
		expect(await founder.store.getConfig('accept_optimistic')).toBe(true)
	})

	it("accepts an unadmitted joiner's write durably, without admitting it as a writer", async () => {
		expect(joiner.store.writable).toBe(false)

		// Wait for the founder's accept_optimistic policy to replicate to the joiner.
		await waitFor(() => joiner.store.acceptsOptimistic(), { timeout: 60_000, interval: 250 })

		const { event } = createSignedEvent({
			content: 'optimistic write from a read-only peer',
			sk: authorSk,
		})
		const ok = await publish(wsJoiner, event)
		expect(ok[0]).toBe('OK')
		expect(ok[2]).toBe(true)

		// It reaches the founder durably (acked, not rolled back).
		await waitFor(async () => (await queryIds(wsFounder, [event.id])).length === 1, {
			timeout: 60_000,
			interval: 500,
		})

		// Crucially, the joiner was NOT promoted to a writer (ack != admit).
		expect(joiner.store.writable).toBe(false)
		expect(await founder.store.listWriters()).toEqual([])
	})

	it('rejects optimistic writes when the founder did not opt in', async () => {
		expect(joinerOff.store.writable).toBe(false)
		expect(await joinerOff.store.acceptsOptimistic()).toBe(false)

		const { event } = createSignedEvent({ content: 'should be blocked' })
		const ok = await publish(wsJoinerOff, event)
		expect(ok[0]).toBe('OK')
		expect(ok[2]).toBe(false)
		expect(String(ok[3])).toContain('read-only replica')
	})
})
