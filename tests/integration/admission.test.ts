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

/** Rate limits high enough that polling never trips them */
const FAST_LIMITS = { eventRatePerSec: 1000, reqRatePerSec: 1000 }

let subCounter = 0

async function queryIds(ws: WebSocket, ids: string[]): Promise<NostrEvent[]> {
	const subId = `adm-${subCounter++}`
	const results = await sendAndCollect(ws, ['REQ', subId, { ids }], 'EOSE')
	await sendAndCollect(ws, ['CLOSE', subId], 'CLOSED')
	return results.filter((m) => m[0] === 'EVENT').map((m) => m[2] as NostrEvent)
}

async function publish(ws: WebSocket, event: NostrEvent): Promise<unknown[]> {
	ws.send(JSON.stringify(['EVENT', event]))
	return waitForMessage(ws, 10_000)
}

describe('in-band writer admission (local testnet)', { timeout: 120_000 }, () => {
	// Scenario A: granter opts into auto-admit, joiner requests in-band.
	let founder: NostrSwarm
	let joiner: NostrSwarm
	let wsFounder: WebSocket
	let wsJoiner: WebSocket
	// Scenario B: granter does NOT opt in — joiner must stay read-only.
	let founderOff: NostrSwarm
	let joinerOff: NostrSwarm
	let wsFounderOff: WebSocket
	let wsJoinerOff: WebSocket

	const authorSk = generateSecretKey()

	beforeAll(async () => {
		await getTestnet()

		// --- Scenario A: --auto-admit + --request-writer ---
		const topicA = `admit-on-${randomBytes(8).toString('hex')}`
		founder = await createRelay({ relay: { topic: topicA, autoAdmit: true, ...FAST_LIMITS } })
		const baseKeyA = founder.store.base.key
		if (!baseKeyA) throw new Error('founder base key missing')
		joiner = await createRelay({
			relay: {
				topic: topicA,
				bootstrap: encodeInvite(baseKeyA),
				requestWriter: true,
				...FAST_LIMITS,
			},
		})

		// --- Scenario B: granter without --auto-admit ---
		const topicB = `admit-off-${randomBytes(8).toString('hex')}`
		founderOff = await createRelay({ relay: { topic: topicB, ...FAST_LIMITS } })
		const baseKeyB = founderOff.store.base.key
		if (!baseKeyB) throw new Error('founderOff base key missing')
		joinerOff = await createRelay({
			relay: {
				topic: topicB,
				bootstrap: encodeInvite(baseKeyB),
				requestWriter: true,
				...FAST_LIMITS,
			},
		})

		wsFounder = await connectClient(founder.config.port)
		wsJoiner = await connectClient(joiner.config.port)
		wsFounderOff = await connectClient(founderOff.config.port)
		wsJoinerOff = await connectClient(joinerOff.config.port)
	}, 90_000)

	afterAll(async () => {
		for (const ws of [wsFounder, wsJoiner, wsFounderOff, wsJoinerOff]) ws?.close()
		await joiner?.stop()
		await founder?.stop()
		await joinerOff?.stop()
		await founderOff?.stop()
		await destroyTestnet()
	}, 60_000)

	it('admits the joiner in-band, with no operator --admit call', async () => {
		expect(joiner.store.isFounder).toBe(false)
		// Becomes writable purely via the proven in-band request + replication.
		await waitFor(() => joiner.store.writable, { timeout: 60_000, interval: 250 })
		expect(joiner.store.writable).toBe(true)

		// And the founder really recorded it as an admitted writer.
		const joinerWriterKey = joiner.store.localWriterKey.toString('hex')
		await waitFor(() => founder.store.isAdmittedWriter(joinerWriterKey), {
			timeout: 30_000,
			interval: 250,
		})
	})

	it('lets the in-band-admitted joiner write events that flow back to the founder', async () => {
		await waitFor(() => joiner.store.writable, { timeout: 60_000, interval: 250 })

		const { event } = createSignedEvent({
			content: 'written after in-band admission',
			sk: authorSk,
		})
		const ok = await publish(wsJoiner, event)
		expect(ok[0]).toBe('OK')
		expect(ok[2]).toBe(true)

		await waitFor(async () => (await queryIds(wsFounder, [event.id])).length === 1, {
			timeout: 45_000,
			interval: 500,
		})
	})

	it('keeps the joiner read-only when the granter did not opt into --auto-admit', async () => {
		// Prove the replication link is fully live (so any admission would have
		// completed too): a founder event must reach the joiner.
		const { event } = createSignedEvent({ content: 'founder event on off-topic' })
		const ok = await publish(wsFounderOff, event)
		expect(ok[2]).toBe(true)
		await waitFor(async () => (await queryIds(wsJoinerOff, [event.id])).length === 1, {
			timeout: 45_000,
			interval: 500,
		})

		// The link works, the joiner asked (requestWriter), yet without auto-admit
		// it is never granted write access.
		expect(joinerOff.store.writable).toBe(false)
	})
})
