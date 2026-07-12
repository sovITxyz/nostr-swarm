import { describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import {
	ShimMessageHandler,
	type ShimServices,
	type VerbHandler,
	clampLimit,
	requireHex64,
	requireUserEvent,
} from '../../src/primal-shim/handler.js'
import type { DmReadStore } from '../../src/primal-shim/dm-read.js'
import type { SeenStore } from '../../src/primal-shim/seen.js'
import { Session } from '../../src/primal-shim/session.js'
import type { StatsService } from '../../src/primal-shim/stats.js'
import type { RelayClient } from '../../src/primal-shim/upstream.js'
import type { PrimalShimConfig } from '../../src/util/types.js'
import { createSignedEvent } from '../helpers.js'

const config: PrimalShimConfig = {
	port: 0,
	host: '127.0.0.1',
	relayUrl: 'ws://127.0.0.1:1',
	publicRelayUrl: 'ws://localhost:1',
	dataDir: '/tmp/unused',
	upstreamSockets: 1,
	statsTtlMs: 1000,
	statsCacheSize: 10,
	maxMessageSize: 4096,
	queryTimeoutMs: 1000,
}

const seenStub: SeenStore = { get: () => 0, set: async () => {} }
const dmReadStub: DmReadStore = { get: () => 0, set: async () => {} }

function makeSession(): { session: Session; sent: unknown[][] } {
	const sent: unknown[][] = []
	const fakeSocket = {
		readyState: 1,
		OPEN: 1,
		send: (data: string) => {
			sent.push(JSON.parse(data))
		},
		close: () => {},
	} as unknown as WebSocket
	return { session: new Session(fakeSocket), sent }
}

function makeHandler(verbs: Record<string, VerbHandler>): ShimMessageHandler {
	const services: ShimServices = {
		relay: {} as RelayClient,
		stats: {} as StatsService,
		seen: seenStub,
		dmRead: dmReadStub,
		config,
	}
	return new ShimMessageHandler(services, new Map(Object.entries(verbs)), new Map())
}

const cacheReq = (subId: string, verb: string, payload?: unknown) =>
	JSON.stringify(['REQ', subId, { cache: payload === undefined ? [verb] : [verb, payload] }])

describe('ShimMessageHandler', () => {
	it('streams verb output as EVENTs and always ends with EOSE', async () => {
		const handler = makeHandler({
			// biome-ignore lint/correctness/useYield: yields two literals
			test_verb: async function* () {
				yield { kind: 1, content: 'one' }
				yield { kind: 2, content: 'two' }
			},
		})
		const { session, sent } = makeSession()
		await handler.handle(session, cacheReq('sub1', 'test_verb'))
		expect(sent).toEqual([
			['EVENT', 'sub1', { kind: 1, content: 'one' }],
			['EVENT', 'sub1', { kind: 2, content: 'two' }],
			['EOSE', 'sub1'],
		])
	})

	it('answers unknown verbs with bare EOSE', async () => {
		const handler = makeHandler({})
		const { session, sent } = makeSession()
		await handler.handle(session, cacheReq('sub2', 'no_such_verb', {}))
		expect(sent).toEqual([['EOSE', 'sub2']])
	})

	it('answers non-cache REQs with bare EOSE', async () => {
		const handler = makeHandler({})
		const { session, sent } = makeSession()
		await handler.handle(session, JSON.stringify(['REQ', 'sub3', { kinds: [1] }]))
		expect(sent).toEqual([['EOSE', 'sub3']])
	})

	it('sends a NOTICE for invalid JSON', async () => {
		const handler = makeHandler({})
		const { session, sent } = makeSession()
		await handler.handle(session, 'not json at all')
		expect(sent).toEqual([['NOTICE', 'error: invalid JSON']])
	})

	it('rejects oversized messages', async () => {
		const handler = makeHandler({})
		const { session, sent } = makeSession()
		await handler.handle(session, 'x'.repeat(config.maxMessageSize + 1))
		expect(sent).toEqual([['NOTICE', 'error: message too large']])
	})

	it('converts verb errors into a subId-scoped NOTICE followed by EOSE', async () => {
		const handler = makeHandler({
			// biome-ignore lint/correctness/useYield: throws before yielding
			boom: async function* () {
				throw new Error('kaput')
			},
		})
		const { session, sent } = makeSession()
		await handler.handle(session, cacheReq('sub4', 'boom'))
		expect(sent).toEqual([
			['NOTICE', 'sub4', 'error: kaput'],
			['EOSE', 'sub4'],
		])
	})

	it('stops streaming and skips EOSE when the client CLOSEs mid-verb', async () => {
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const handler = makeHandler({
			slow: async function* () {
				yield { kind: 1 }
				await gate
				yield { kind: 2 }
			},
		})
		const { session, sent } = makeSession()
		const inflight = handler.handle(session, cacheReq('sub5', 'slow'))
		// Wait for the first EVENT to flush, then cancel
		await new Promise((resolve) => setTimeout(resolve, 10))
		await handler.handle(session, JSON.stringify(['CLOSE', 'sub5']))
		release()
		await inflight
		expect(sent).toEqual([['EVENT', 'sub5', { kind: 1 }]])
	})

	it('tolerates a third element on CLOSE frames', async () => {
		const handler = makeHandler({})
		const { session, sent } = makeSession()
		await handler.handle(
			session,
			JSON.stringify(['CLOSE', 'sub6', { cache: ['notification_counts', { subid: 'sub6' }] }]),
		)
		expect(sent).toEqual([])
	})
})

describe('payload helpers', () => {
	it('requireHex64 accepts pubkeys and rejects junk', () => {
		expect(requireHex64('a'.repeat(64), 'pubkey')).toBe('a'.repeat(64))
		expect(() => requireHex64('nope', 'pubkey')).toThrow('pubkey')
		expect(() => requireHex64(undefined, 'pubkey')).toThrow('pubkey')
		expect(() => requireHex64(`${'a'.repeat(63)}Z`, 'pubkey')).toThrow('pubkey')
	})

	it('clampLimit floors, caps and defaults', () => {
		expect(clampLimit(50, 20, 100)).toBe(50)
		expect(clampLimit(5000, 20, 100)).toBe(100)
		expect(clampLimit(-3, 20, 100)).toBe(1)
		expect(clampLimit('junk', 20, 100)).toBe(20)
	})

	it('requireUserEvent verifies signatures and rejects tampering', () => {
		const { event } = createSignedEvent({ kind: 30078, content: '{}' })
		expect(requireUserEvent({ event_from_user: event })).toEqual(event)
		expect(requireUserEvent({ settings_event: event })).toEqual(event)
		// Deep-clone via JSON like real wire input: finalizeEvent's cached
		// verifiedSymbol would otherwise ride along on an object spread and
		// short-circuit verifyEvent
		const plain = JSON.parse(JSON.stringify(event))
		const tampered = { ...plain, content: '{"evil":true}' }
		expect(() => requireUserEvent({ event_from_user: tampered })).toThrow('signature')
		expect(() => requireUserEvent({})).toThrow('malformed')
		const future = { ...plain, created_at: Math.floor(Date.now() / 1000) + 100_000 }
		expect(() => requireUserEvent({ event_from_user: future })).toThrow('future')
	})
})
