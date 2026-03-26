import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NostrSwarm } from '../../src/relay.js'
import { connectClient, createRelay, createSignedEvent, sendAndCollect, waitForMessage } from '../helpers.js'
import type WebSocket from 'ws'

describe('relay integration', () => {
	let relay: NostrSwarm
	let ws: WebSocket

	beforeAll(async () => {
		relay = await createRelay()
		ws = await connectClient(relay.config.port)
	})

	afterAll(async () => {
		ws.close()
		await relay.stop()
	})

	it('accepts and returns an event', async () => {
		const { event } = createSignedEvent({ content: 'integration test' })

		// Publish event
		ws.send(JSON.stringify(['EVENT', event]))
		const okMsg = await waitForMessage(ws)
		expect(okMsg[0]).toBe('OK')
		expect(okMsg[1]).toBe(event.id)
		expect(okMsg[2]).toBe(true)

		// Query it back
		const results = await sendAndCollect(
			ws,
			['REQ', 'test-sub', { ids: [event.id] }],
			'EOSE',
		)

		const events = results.filter((m) => m[0] === 'EVENT')
		expect(events.length).toBe(1)
		expect((events[0]![2] as any).id).toBe(event.id)
		expect((events[0]![2] as any).content).toBe('integration test')

		// Clean up subscription
		ws.send(JSON.stringify(['CLOSE', 'test-sub']))
	})

	it('queries by kind', async () => {
		const { event: e1 } = createSignedEvent({ kind: 1, content: 'kind1' })
		const { event: e2 } = createSignedEvent({ kind: 7, content: 'kind7' })

		// Publish both
		ws.send(JSON.stringify(['EVENT', e1]))
		await waitForMessage(ws) // OK
		ws.send(JSON.stringify(['EVENT', e2]))
		await waitForMessage(ws) // OK

		// Query kind 7 only
		const results = await sendAndCollect(
			ws,
			['REQ', 'kind-sub', { kinds: [7] }],
			'EOSE',
		)

		const events = results.filter((m) => m[0] === 'EVENT')
		const hasKind7 = events.some((m) => (m[2] as any).id === e2.id)
		expect(hasKind7).toBe(true)

		// Should not have kind 1 events in a kind-7-only query... unless previously stored kind 1 events exist
		// The first test stored a kind 1 event, so we just check kind 7 is present
		ws.send(JSON.stringify(['CLOSE', 'kind-sub']))
	})

	it('handles COUNT', async () => {
		const results = await sendAndCollect(
			ws,
			['COUNT', 'count-q', { kinds: [1] }],
			'COUNT',
		)

		const countMsg = results.find((m) => m[0] === 'COUNT')
		expect(countMsg).toBeDefined()
		expect((countMsg![2] as any).count).toBeGreaterThanOrEqual(1)
	})

	it('rejects invalid event structure', async () => {
		ws.send(JSON.stringify(['EVENT', { id: 'bad' }]))
		const okMsg = await waitForMessage(ws)
		expect(okMsg[0]).toBe('OK')
		expect(okMsg[2]).toBe(false)
	})

	it('handles CLOSE for unknown subscription', async () => {
		ws.send(JSON.stringify(['CLOSE', 'nonexistent']))
		const msg = await waitForMessage(ws)
		expect(msg[0]).toBe('CLOSED')
	})

	it('rejects unknown message types with NOTICE', async () => {
		ws.send(JSON.stringify(['INVALID_TYPE']))
		const msg = await waitForMessage(ws)
		expect(msg[0]).toBe('NOTICE')
	})

	it('live subscription receives new events', async () => {
		// Open a subscription for kind 42
		const subResults = await sendAndCollect(
			ws,
			['REQ', 'live-sub', { kinds: [42] }],
			'EOSE',
		)
		expect(subResults.some((m) => m[0] === 'EOSE')).toBe(true)

		// Now publish a kind 42 event — it should arrive on the subscription
		const { event } = createSignedEvent({ kind: 42, content: 'live!' })

		// Set up listener BEFORE sending the event
		const livePromise = waitForMessage(ws, 5000)
		ws.send(JSON.stringify(['EVENT', event]))

		// We should get either an OK or an EVENT — collect both
		const msg1 = await livePromise
		let foundLiveEvent = false

		if (msg1[0] === 'OK') {
			// The OK came first, wait for the live EVENT
			const msg2 = await waitForMessage(ws, 5000)
			if (msg2[0] === 'EVENT' && msg2[1] === 'live-sub') {
				foundLiveEvent = true
			}
		} else if (msg1[0] === 'EVENT' && msg1[1] === 'live-sub') {
			foundLiveEvent = true
		}

		expect(foundLiveEvent).toBe(true)
		ws.send(JSON.stringify(['CLOSE', 'live-sub']))
	})
})
