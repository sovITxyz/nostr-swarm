import { describe, expect, it } from 'vitest'
import {
	classifyKind,
	getDTag,
	getExpiration,
	getIndexableTags,
	isExpired,
	isProtected,
	shouldReplace,
	validateEventStructure,
} from '../../src/nostr/events.js'
import { createSignedEvent } from '../helpers.js'

describe('classifyKind', () => {
	it('classifies kind 0 as replaceable', () => {
		expect(classifyKind(0)).toBe('replaceable')
	})
	it('classifies kind 3 as replaceable', () => {
		expect(classifyKind(3)).toBe('replaceable')
	})
	it('classifies kind 10002 as replaceable', () => {
		expect(classifyKind(10002)).toBe('replaceable')
	})
	it('classifies kind 1 as regular', () => {
		expect(classifyKind(1)).toBe('regular')
	})
	it('classifies kind 4 as regular', () => {
		expect(classifyKind(4)).toBe('regular')
	})
	it('classifies kind 20001 as ephemeral', () => {
		expect(classifyKind(20001)).toBe('ephemeral')
	})
	it('classifies kind 30023 as addressable', () => {
		expect(classifyKind(30023)).toBe('addressable')
	})
})

describe('validateEventStructure', () => {
	it('accepts a valid signed event', () => {
		const { event } = createSignedEvent()
		expect(validateEventStructure(event)).toBe(true)
	})

	it('rejects non-object', () => {
		expect(validateEventStructure('hello')).toBe(false)
		expect(validateEventStructure(null)).toBe(false)
	})

	it('rejects missing fields', () => {
		expect(validateEventStructure({ id: 'abc' })).toBe(false)
	})

	it('rejects wrong id length', () => {
		const { event } = createSignedEvent()
		expect(validateEventStructure({ ...event, id: 'short' })).toBe(false)
	})
})

describe('getDTag', () => {
	it('returns d tag value', () => {
		const { event } = createSignedEvent({ tags: [['d', 'my-article']] })
		expect(getDTag(event)).toBe('my-article')
	})

	it('returns empty string when no d tag', () => {
		const { event } = createSignedEvent()
		expect(getDTag(event)).toBe('')
	})
})

describe('getExpiration / isExpired', () => {
	it('returns expiration timestamp', () => {
		const future = Math.floor(Date.now() / 1000) + 3600
		const { event } = createSignedEvent({ tags: [['expiration', String(future)]] })
		expect(getExpiration(event)).toBe(future)
		expect(isExpired(event)).toBe(false)
	})

	it('detects expired events', () => {
		const past = Math.floor(Date.now() / 1000) - 100
		const { event } = createSignedEvent({ tags: [['expiration', String(past)]] })
		expect(isExpired(event)).toBe(true)
	})

	it('returns null when no expiration', () => {
		const { event } = createSignedEvent()
		expect(getExpiration(event)).toBe(null)
	})
})

describe('isProtected', () => {
	it('detects protected events', () => {
		const { event } = createSignedEvent({ tags: [['-']] })
		expect(isProtected(event)).toBe(true)
	})

	it('returns false for normal events', () => {
		const { event } = createSignedEvent()
		expect(isProtected(event)).toBe(false)
	})
})

describe('getIndexableTags', () => {
	it('extracts single-letter tags', () => {
		const { event } = createSignedEvent({
			tags: [
				['p', 'pubkey1'],
				['e', 'eventid1'],
				['nonce', '123'], // not single-letter, should be excluded
			],
		})
		const tags = getIndexableTags(event)
		expect(tags).toHaveLength(2)
		expect(tags).toContainEqual({ name: 'p', value: 'pubkey1' })
		expect(tags).toContainEqual({ name: 'e', value: 'eventid1' })
	})
})

describe('shouldReplace', () => {
	it('newer event replaces older', () => {
		const { event: older } = createSignedEvent({ created_at: 1000 })
		const { event: newer } = createSignedEvent({ created_at: 2000 })
		expect(shouldReplace(older, newer)).toBe(true)
		expect(shouldReplace(newer, older)).toBe(false)
	})

	it('same timestamp: lower id wins', () => {
		const { event: a } = createSignedEvent({ created_at: 1000, content: 'aaa' })
		const { event: b } = createSignedEvent({ created_at: 1000, content: 'bbb' })
		// One of them should replace the other based on id comparison
		const aWins = shouldReplace(b, a) // a replacing b
		const bWins = shouldReplace(a, b) // b replacing a
		// Exactly one should be true (the one with the lower id)
		expect(aWins !== bWins).toBe(true)
	})
})
