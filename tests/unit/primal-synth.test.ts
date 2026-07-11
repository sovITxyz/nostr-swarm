import { describe, expect, it } from 'vitest'
import {
	DEFAULT_APP_SETTINGS,
	DEFAULT_HOME_FEEDS,
	PRIMAL_KIND,
	emptyStats,
	encodeBroadcastResponse,
	encodeDefaultRelays,
	encodeEventStats,
	encodeFeedRange,
	encodeNotificationSummary,
	encodeReferencedEvent,
	encodeUserRelays,
	encodeUserStats,
} from '../../src/primal-shim/synth.js'
import type { NostrEvent } from '../../src/util/types.js'

const id = (n: number) => n.toString(16).padStart(64, '0')

describe('primal-shim synth encoders', () => {
	it('encodes event stats with the exact keys the client reads', () => {
		const encoded = encodeEventStats({ ...emptyStats(id(1)), likes: 3, satszapped: 42 })
		expect(encoded.kind).toBe(PRIMAL_KIND.eventStats)
		const content = JSON.parse(encoded.content)
		expect(content).toMatchObject({
			event_id: id(1),
			likes: 3,
			replies: 0,
			mentions: 0,
			reposts: 0,
			zaps: 0,
			satszapped: 42,
			bookmarks: 0,
		})
		expect(typeof content.score).toBe('number')
		expect(typeof content.score24h).toBe('number')
	})

	it('encodes the feed RANGE with min/max timestamps and ordered elements', () => {
		const events = [
			{ id: id(1), created_at: 300 },
			{ id: id(2), created_at: 200 },
			{ id: id(3), created_at: 100 },
		]
		const range = JSON.parse(encodeFeedRange(events).content)
		expect(range).toEqual({
			since: 100,
			until: 300,
			order_by: 'created_at',
			elements: [id(1), id(2), id(3)],
		})
	})

	it('encodes an empty RANGE without NaN/undefined', () => {
		const range = JSON.parse(encodeFeedRange([]).content)
		expect(range).toEqual({ since: 0, until: 0, order_by: 'created_at', elements: [] })
	})

	it('keeps the notification summary bare: counts at top level, no event fields', () => {
		const summary = encodeNotificationSummary('a'.repeat(64), { '4': 2, '6': 1 })
		expect(summary).toEqual({
			kind: PRIMAL_KIND.notificationSummary,
			pubkey: 'a'.repeat(64),
			'4': 2,
			'6': 1,
		})
		// The client sums every field except pubkey/kind into the badge —
		// id/created_at/sig/content must never leak in
		expect(Object.keys(summary)).not.toContain('created_at')
		expect(Object.keys(summary)).not.toContain('content')
	})

	it('wraps referenced events with the original as stringified content', () => {
		const original: NostrEvent = {
			id: id(9),
			pubkey: 'b'.repeat(64),
			created_at: 123,
			kind: 1,
			tags: [],
			content: 'quoted note',
			sig: 'c'.repeat(128),
		}
		const wrapped = encodeReferencedEvent(original)
		expect(wrapped.kind).toBe(PRIMAL_KIND.referencedEvent)
		expect(wrapped.pubkey).toBe(original.pubkey)
		expect(JSON.parse(wrapped.content)).toEqual(original)
	})

	it('encodes user relays as r-tags', () => {
		const encoded = encodeUserRelays('d'.repeat(64), ['ws://localhost:3000'])
		expect(encoded.kind).toBe(PRIMAL_KIND.userRelays)
		expect(encoded.tags).toEqual([['r', 'ws://localhost:3000']])
	})

	it('encodes default relays as a JSON array of URL strings', () => {
		const encoded = encodeDefaultRelays(['ws://localhost:3000'])
		expect(encoded.kind).toBe(PRIMAL_KIND.defaultRelays)
		expect(JSON.parse(encoded.content)).toEqual(['ws://localhost:3000'])
	})

	it('marks accepted events "ok" in the broadcast response', () => {
		const encoded = encodeBroadcastResponse([
			{ event_id: id(5), accepted: true, reason: '' },
			{ event_id: id(6), accepted: false, reason: 'blocked: read-only' },
		])
		expect(encoded.kind).toBe(PRIMAL_KIND.broadcastResponse)
		expect(JSON.parse(encoded.content)).toEqual([
			{ event_id: id(5), responses: [['ok']] },
			{ event_id: id(6), responses: [['blocked: read-only']] },
		])
	})

	it('ships default settings with every key loadDefaults dereferences', () => {
		// SettingsContext.loadDefaults calls Object.keys() on these and assigns
		// zapDefault/zapConfig unconditionally — absence breaks guest boot
		expect(DEFAULT_APP_SETTINGS.feeds).toBeDefined()
		expect(Object.keys(DEFAULT_APP_SETTINGS.notifications).length).toBeGreaterThan(0)
		expect(Object.keys(DEFAULT_APP_SETTINGS.notificationsAdditional).length).toBeGreaterThan(0)
		expect(DEFAULT_APP_SETTINGS.zapDefault.amount).toBeGreaterThan(0)
		expect(DEFAULT_APP_SETTINGS.zapConfig).toHaveLength(6)
		expect(DEFAULT_APP_SETTINGS.zapOptions).toHaveLength(6)
		expect(DEFAULT_APP_SETTINGS.defaultZapAmount).toBeGreaterThan(0)
		expect(DEFAULT_APP_SETTINGS.proxyThroughPrimal).toBe(false)
	})

	it('advertises home feeds whose specs the feed verb honors', () => {
		for (const feed of DEFAULT_HOME_FEEDS) {
			const spec = JSON.parse(feed.spec)
			expect(['latest', 'all-notes']).toContain(spec.id)
			expect(feed.enabled).toBe(true)
		}
	})
})

describe('primal-shim user stats', () => {
	it('fills every stats field with zeros by default', () => {
		const encoded = encodeUserStats('e'.repeat(64), { followers_count: 7 })
		const content = JSON.parse(encoded.content)
		expect(content.pubkey).toBe('e'.repeat(64))
		expect(content.followers_count).toBe(7)
		expect(content.follows_count).toBe(0)
		expect(content.note_count).toBe(0)
	})
})
