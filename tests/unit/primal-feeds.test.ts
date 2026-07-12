import { describe, expect, it } from 'vitest'
import { applyPage } from '../../src/primal-shim/verbs/feeds.js'
import type { NostrEvent } from '../../src/util/types.js'

const note = (n: number, createdAt: number): NostrEvent => ({
	id: n.toString(16).padStart(64, '0'),
	pubkey: 'a'.repeat(64),
	created_at: createdAt,
	kind: 1,
	tags: [],
	content: `note ${n}`,
	sig: 'b'.repeat(128),
})

const base = { spec: {}, limit: 20, offset: 0, kinds: [1, 6] }

describe('applyPage pagination', () => {
	const events = [note(1, 100), note(2, 200), note(3, 300), note(4, 400), note(5, 500)]

	it('returns the newest events first, capped at limit', () => {
		const page = applyPage(events, { ...base, limit: 3 })
		expect(page.map((e) => e.created_at)).toEqual([500, 400, 300])
	})

	it('does not repeat the boundary event on the next until-page', () => {
		const page1 = applyPage(events, { ...base, limit: 3 })
		const boundary = page1.at(-1)?.created_at ?? 0 // 300
		// Client semantics: until = previous RANGE.since, offset = rendered ties
		const page2 = applyPage(events, { ...base, limit: 3, until: boundary, offset: 1 })
		expect(page2.map((e) => e.created_at)).toEqual([200, 100])
		const seen = new Set(page1.map((e) => e.id))
		expect(page2.some((e) => seen.has(e.id))).toBe(false)
	})

	it('skips exactly `offset` ties at a shared boundary timestamp', () => {
		const tied = [note(1, 100), note(2, 100), note(3, 100), note(4, 50)]
		const page = applyPage(tied, { ...base, until: 100, offset: 2 })
		expect(page).toHaveLength(2)
		expect(page.map((e) => e.created_at)).toEqual([100, 50])
	})

	it('does not repeat the boundary event on a since-poll (new-notes pill)', () => {
		// Client polls with since = previous until and offset = rendered ties there
		const poll = applyPage(events, { ...base, since: 500, offset: 1 })
		expect(poll.map((e) => e.created_at)).not.toContain(500)
	})

	it('treats missing/garbage offset as zero, not one', () => {
		const page = applyPage(events, { ...base, until: 500, offset: 0, limit: 5 })
		expect(page.map((e) => e.created_at)).toEqual([500, 400, 300, 200, 100])
	})
})
