import { describe, expect, it } from 'vitest'
import { matchFilter, matchFilters, validateFilter } from '../../src/nostr/filters.js'
import { createSignedEvent } from '../helpers.js'

describe('validateFilter', () => {
	it('accepts valid filter', () => {
		expect(validateFilter({ kinds: [1], limit: 10 })).toBe(true)
	})

	it('accepts empty filter', () => {
		expect(validateFilter({})).toBe(true)
	})

	it('accepts filter with tag', () => {
		expect(validateFilter({ '#p': ['abc'] })).toBe(true)
	})

	it('rejects non-object', () => {
		expect(validateFilter('bad')).toBe(false)
		expect(validateFilter(null)).toBe(false)
		expect(validateFilter([1])).toBe(false)
	})

	it('rejects invalid kinds', () => {
		expect(validateFilter({ kinds: 'bad' })).toBe(false)
		expect(validateFilter({ kinds: ['bad'] })).toBe(false)
	})

	it('rejects negative limit', () => {
		expect(validateFilter({ limit: -1 })).toBe(false)
	})

	it('rejects multi-letter tag filter', () => {
		expect(validateFilter({ '#abc': ['val'] })).toBe(false)
	})
})

describe('matchFilter', () => {
	it('matches by kind', () => {
		const { event } = createSignedEvent({ kind: 1 })
		expect(matchFilter({ kinds: [1] }, event)).toBe(true)
		expect(matchFilter({ kinds: [2] }, event)).toBe(false)
	})

	it('matches by author prefix', () => {
		const { event, pubkey } = createSignedEvent()
		expect(matchFilter({ authors: [pubkey.slice(0, 8)] }, event)).toBe(true)
		expect(matchFilter({ authors: ['00000000'] }, event)).toBe(false)
	})

	it('matches by id prefix', () => {
		const { event } = createSignedEvent()
		expect(matchFilter({ ids: [event.id.slice(0, 8)] }, event)).toBe(true)
	})

	it('matches since/until', () => {
		const { event } = createSignedEvent({ created_at: 1500 })
		expect(matchFilter({ since: 1000, until: 2000 }, event)).toBe(true)
		expect(matchFilter({ since: 2000 }, event)).toBe(false)
		expect(matchFilter({ until: 1000 }, event)).toBe(false)
	})

	it('matches tag filters', () => {
		const { event } = createSignedEvent({ tags: [['p', 'abc123']] })
		expect(matchFilter({ '#p': ['abc123'] }, event)).toBe(true)
		expect(matchFilter({ '#p': ['xyz'] }, event)).toBe(false)
	})

	it('empty filter matches everything', () => {
		const { event } = createSignedEvent()
		expect(matchFilter({}, event)).toBe(true)
	})

	it('multiple conditions are AND', () => {
		const { event } = createSignedEvent({ kind: 1 })
		expect(matchFilter({ kinds: [1], since: event.created_at - 10 }, event)).toBe(true)
		expect(matchFilter({ kinds: [2], since: event.created_at - 10 }, event)).toBe(false)
	})
})

describe('matchFilters', () => {
	it('multiple filters are OR', () => {
		const { event } = createSignedEvent({ kind: 1 })
		expect(matchFilters([{ kinds: [2] }, { kinds: [1] }], event)).toBe(true)
		expect(matchFilters([{ kinds: [2] }, { kinds: [3] }], event)).toBe(false)
	})
})
