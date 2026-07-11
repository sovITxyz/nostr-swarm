import { afterEach, describe, expect, it, vi } from 'vitest'
import { LruCache } from '../../src/primal-shim/lru.js'
import { tallyInteraction, zapAmountSats } from '../../src/primal-shim/stats.js'
import { type EventStats, emptyStats } from '../../src/primal-shim/synth.js'
import type { NostrEvent } from '../../src/util/types.js'

const id = (n: number) => n.toString(16).padStart(64, '0')

function interaction(kind: number, target: string, extra?: Partial<NostrEvent>): NostrEvent {
	return {
		id: id(999),
		pubkey: 'a'.repeat(64),
		created_at: 1000,
		kind,
		tags: [['e', target]],
		content: '',
		sig: 'b'.repeat(128),
		...extra,
	}
}

function zapReceipt(target: string, msats: number): NostrEvent {
	const zapRequest = {
		pubkey: 'c'.repeat(64),
		tags: [
			['amount', String(msats)],
			['e', target],
		],
	}
	return interaction(9735, target, {
		tags: [
			['e', target],
			['description', JSON.stringify(zapRequest)],
		],
	})
}

describe('zapAmountSats', () => {
	it('reads sats from the embedded zap request amount (msats)', () => {
		expect(zapAmountSats(zapReceipt(id(1), 21_000))).toBe(21)
	})

	it('returns 0 for missing or malformed descriptions', () => {
		expect(zapAmountSats(interaction(9735, id(1)))).toBe(0)
		expect(
			zapAmountSats(interaction(9735, id(1), { tags: [['description', 'not json']] })),
		).toBe(0)
		expect(
			zapAmountSats(
				interaction(9735, id(1), {
					tags: [['description', JSON.stringify({ tags: [['amount', '-5']] })]],
				}),
			),
		).toBe(0)
	})
})

describe('tallyInteraction', () => {
	it('classifies replies, reposts, likes and zaps per referenced id', () => {
		const stats = new Map<string, EventStats>([[id(1), emptyStats(id(1))]])
		tallyInteraction(interaction(1, id(1)), stats)
		tallyInteraction(interaction(6, id(1)), stats)
		tallyInteraction(interaction(7, id(1)), stats)
		tallyInteraction(zapReceipt(id(1), 5000), stats)
		const entry = stats.get(id(1))
		expect(entry).toMatchObject({ replies: 1, reposts: 1, likes: 1, zaps: 1, satszapped: 5 })
		expect(entry?.score).toBeGreaterThan(0)
	})

	it('ignores interactions targeting ids outside the requested page', () => {
		const stats = new Map<string, EventStats>([[id(1), emptyStats(id(1))]])
		tallyInteraction(interaction(7, id(2)), stats)
		expect(stats.get(id(1))?.likes).toBe(0)
	})

	it('counts an event referencing the same id twice only once', () => {
		const stats = new Map<string, EventStats>([[id(1), emptyStats(id(1))]])
		tallyInteraction(
			interaction(1, id(1), {
				tags: [
					['e', id(1)],
					['e', id(1)],
				],
			}),
			stats,
		)
		expect(stats.get(id(1))?.replies).toBe(1)
	})
})

describe('LruCache', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('evicts the least recently used entry past capacity', () => {
		const cache = new LruCache<string, number>(2, 60_000)
		cache.set('a', 1)
		cache.set('b', 2)
		cache.get('a') // refresh recency: b is now oldest
		cache.set('c', 3)
		expect(cache.get('a')).toBe(1)
		expect(cache.get('b')).toBeUndefined()
		expect(cache.get('c')).toBe(3)
	})

	it('expires entries after the TTL', () => {
		vi.useFakeTimers()
		const cache = new LruCache<string, number>(10, 1000)
		cache.set('a', 1)
		vi.advanceTimersByTime(999)
		expect(cache.get('a')).toBe(1)
		vi.advanceTimersByTime(2)
		expect(cache.get('a')).toBeUndefined()
	})
})
