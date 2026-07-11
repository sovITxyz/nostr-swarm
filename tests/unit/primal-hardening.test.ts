import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import {
	ShimMessageHandler,
	type ShimServices,
	type VerbHandler,
	peekSubId,
} from '../../src/primal-shim/handler.js'
import type { SeenStore } from '../../src/primal-shim/seen.js'
import { Session } from '../../src/primal-shim/session.js'
import type { StatsService } from '../../src/primal-shim/stats.js'
import type { RelayClient } from '../../src/primal-shim/upstream.js'
import { hasMediaUrl } from '../../src/primal-shim/verbs/feeds.js'
import type { PrimalShimConfig } from '../../src/util/types.js'

const config: PrimalShimConfig = {
	port: 0,
	host: '127.0.0.1',
	relayUrl: 'ws://127.0.0.1:1',
	publicRelayUrl: 'ws://localhost:1',
	dataDir: '/tmp/unused',
	upstreamSockets: 1,
	statsTtlMs: 1000,
	statsCacheSize: 10,
	maxMessageSize: 256,
	queryTimeoutMs: 1000,
}

const seenStub: SeenStore = { get: () => 0, set: async () => {} }

function makeSession(): { session: Session; sent: unknown[][]; socket: WebSocket } {
	const sent: unknown[][] = []
	const socket = {
		readyState: 1,
		OPEN: 1,
		send: (data: string) => {
			sent.push(JSON.parse(data))
		},
		close: () => {},
	} as unknown as WebSocket
	return { session: new Session(socket), sent, socket }
}

function makeHandler(verbs: Record<string, VerbHandler>): ShimMessageHandler {
	const services: ShimServices = {
		relay: {} as RelayClient,
		stats: {} as StatsService,
		seen: seenStub,
		config,
	}
	return new ShimMessageHandler(services, new Map(Object.entries(verbs)), new Map())
}

describe('peekSubId', () => {
	it('recovers the subId from an oversized REQ frame prefix', () => {
		const raw = `["REQ","feed_web_1_1234567890",{"cache":["events",{"event_ids":[${'"x",'.repeat(9000)}]}]}]`
		expect(peekSubId(raw)).toBe('feed_web_1_1234567890')
	})

	it('returns null when no subId can be parsed', () => {
		expect(peekSubId('garbage without structure')).toBeNull()
		expect(peekSubId('[123, 456]')).toBeNull()
	})
})

describe('EOSE contract on rejected frames', () => {
	it('sends subId-scoped NOTICE + EOSE for an oversized REQ so the client unblocks', async () => {
		const handler = makeHandler({})
		const { session, sent } = makeSession()
		const raw = `["REQ","sub_big",{"cache":["events",{"junk":"${'a'.repeat(400)}"}]}]`
		expect(raw.length).toBeGreaterThan(config.maxMessageSize)
		await handler.handle(session, raw)
		expect(sent).toEqual([
			['NOTICE', 'sub_big', 'error: message too large'],
			['EOSE', 'sub_big'],
		])
	})

	it('still EOSEs a REQ whose subId exceeds the length cap', async () => {
		const handler = makeHandler({})
		const { session, sent } = makeSession()
		const longSub = 'x'.repeat(200)
		await handler.handle(session, JSON.stringify(['REQ', longSub, { cache: ['search'] }]))
		expect(sent).toEqual([['EOSE', longSub]])
	})
})

describe('live-sub reuse and caps', () => {
	it('runs the previous cleanup when a subId is reused (no interval/upstream leak)', () => {
		const { session } = makeSession()
		const cleanup1 = vi.fn()
		const cleanup2 = vi.fn()
		expect(session.registerLiveSub('subA', cleanup1)).toBe(true)
		// A new REQ on the same subId supersedes the previous live sub
		session.beginRequest('subA')
		expect(cleanup1).toHaveBeenCalledOnce()
		expect(session.registerLiveSub('subA', cleanup2)).toBe(true)
		session.close()
		expect(cleanup2).toHaveBeenCalledOnce()
	})

	it('caps concurrent live subscriptions per session', () => {
		const { session } = makeSession()
		const cleanups: Array<() => void> = []
		let accepted = 0
		for (let i = 0; i < 20; i++) {
			const c = vi.fn()
			cleanups.push(c)
			if (session.registerLiveSub(`sub${i}`, c)) accepted++
		}
		// Cap is 8; excess registrations are declined so the caller can clean up
		expect(accepted).toBe(8)
	})

	it('a CLOSE tears down the live sub cleanup', () => {
		const { session } = makeSession()
		const cleanup = vi.fn()
		session.registerLiveSub('subX', cleanup)
		session.cancel('subX')
		expect(cleanup).toHaveBeenCalledOnce()
	})
})

describe('hasMediaUrl (ReDoS-safe media detection)', () => {
	it('detects image and video URLs', () => {
		expect(hasMediaUrl('check this https://cdn.example.com/pic.png out')).toBe(true)
		expect(hasMediaUrl('a clip http://host/v.mp4?t=1')).toBe(true)
		expect(hasMediaUrl('https://x.io/a.jpeg')).toBe(true)
	})

	it('returns false for notes with no media URL', () => {
		expect(hasMediaUrl('just some text, no links here')).toBe(false)
		expect(hasMediaUrl('https://example.com/page.html')).toBe(false)
	})

	it('stays linear on adversarial content (no catastrophic backtracking)', () => {
		// A long run of "http://" fragments with no matching extension is the
		// classic backtracking trigger for the old unanchored `\S+\.` pattern
		const evil = `http://${'http://'.repeat(50_000)}`
		const start = performance.now()
		expect(hasMediaUrl(evil)).toBe(false)
		expect(performance.now() - start).toBeLessThan(500)
	})
})
