import { describe, expect, it } from 'vitest'
import {
	addressableKey,
	authorKey,
	authorKindKey,
	createdAtKey,
	decodeKind,
	encodeKind,
	eventKey,
	invertTimestamp,
	kindKey,
	prefixRange,
	recoverTimestamp,
	replaceableKey,
	splitKey,
	tagKey,
	timeRange,
} from '../../src/util/keys.js'

describe('invertTimestamp', () => {
	it('produces 8-char hex string', () => {
		const result = invertTimestamp(1711100000)
		expect(result).toHaveLength(8)
		expect(result).toMatch(/^[0-9a-f]{8}$/)
	})

	it('newer timestamps produce smaller hex values (sort first)', () => {
		const newer = invertTimestamp(1711200000)
		const older = invertTimestamp(1711100000)
		expect(newer < older).toBe(true)
	})

	it('round-trips through recoverTimestamp', () => {
		const timestamps = [0, 1, 1711100000, 1711200000, 0xffffffff]
		for (const ts of timestamps) {
			expect(recoverTimestamp(invertTimestamp(ts))).toBe(ts)
		}
	})

	it('handles timestamp 0 (max inverted value)', () => {
		expect(invertTimestamp(0)).toBe('ffffffff')
	})

	it('handles max timestamp (min inverted value)', () => {
		expect(invertTimestamp(0xffffffff)).toBe('00000000')
	})
})

describe('encodeKind / decodeKind', () => {
	it('encodes kind as 8-char hex', () => {
		expect(encodeKind(1)).toBe('00000001')
		expect(encodeKind(0)).toBe('00000000')
		expect(encodeKind(30023)).toBe('00007547')
	})

	it('round-trips', () => {
		const kinds = [0, 1, 3, 5, 1000, 10002, 20000, 30023, 65535]
		for (const k of kinds) {
			expect(decodeKind(encodeKind(k))).toBe(k)
		}
	})
})

describe('key builders', () => {
	const eventId = 'abc123def456'
	const pubkey = 'deadbeef01234567'
	const ts = 1711100000

	it('eventKey is just the event ID', () => {
		expect(eventKey(eventId)).toBe(eventId)
	})

	it('kindKey has correct structure: kind!inv_time!id', () => {
		const key = kindKey(1, ts, eventId)
		const parts = splitKey(key)
		expect(parts).toHaveLength(3)
		expect(parts[0]).toBe(encodeKind(1))
		expect(recoverTimestamp(parts[1]!)).toBe(ts)
		expect(parts[2]).toBe(eventId)
	})

	it('authorKey has correct structure: pubkey!inv_time!id', () => {
		const key = authorKey(pubkey, ts, eventId)
		const parts = splitKey(key)
		expect(parts).toHaveLength(3)
		expect(parts[0]).toBe(pubkey)
		expect(recoverTimestamp(parts[1]!)).toBe(ts)
		expect(parts[2]).toBe(eventId)
	})

	it('authorKindKey has correct structure: pubkey!kind!inv_time!id', () => {
		const key = authorKindKey(pubkey, 1, ts, eventId)
		const parts = splitKey(key)
		expect(parts).toHaveLength(4)
		expect(parts[0]).toBe(pubkey)
		expect(parts[1]).toBe(encodeKind(1))
		expect(recoverTimestamp(parts[2]!)).toBe(ts)
		expect(parts[3]).toBe(eventId)
	})

	it('tagKey has correct structure: name!value!inv_time!id', () => {
		const key = tagKey('p', 'somepubkey', ts, eventId)
		const parts = splitKey(key)
		expect(parts).toHaveLength(4)
		expect(parts[0]).toBe('p')
		expect(parts[1]).toBe('somepubkey')
		expect(recoverTimestamp(parts[2]!)).toBe(ts)
		expect(parts[3]).toBe(eventId)
	})

	it('createdAtKey has correct structure: inv_time!id', () => {
		const key = createdAtKey(ts, eventId)
		const parts = splitKey(key)
		expect(parts).toHaveLength(2)
		expect(recoverTimestamp(parts[0]!)).toBe(ts)
		expect(parts[1]).toBe(eventId)
	})

	it('replaceableKey has correct structure: pubkey!kind', () => {
		const key = replaceableKey(pubkey, 0)
		const parts = splitKey(key)
		expect(parts).toHaveLength(2)
		expect(parts[0]).toBe(pubkey)
		expect(parts[1]).toBe(encodeKind(0))
	})

	it('addressableKey has correct structure: pubkey!kind!d_tag', () => {
		const key = addressableKey(pubkey, 30023, 'my-article')
		const parts = splitKey(key)
		expect(parts).toHaveLength(3)
		expect(parts[0]).toBe(pubkey)
		expect(parts[1]).toBe(encodeKind(30023))
		expect(parts[2]).toBe('my-article')
	})
})

describe('sort order', () => {
	it('kindKey sorts by kind ascending, then time descending', () => {
		const id = 'aaaa'
		const keys = [
			kindKey(1, 1000, id),
			kindKey(1, 2000, id), // newer, should sort first within kind 1
			kindKey(2, 1000, id),
		]
		const sorted = [...keys].sort()
		// kind 1 before kind 2
		expect(sorted[0]).toBe(kindKey(1, 2000, id)) // kind 1, newer
		expect(sorted[1]).toBe(kindKey(1, 1000, id)) // kind 1, older
		expect(sorted[2]).toBe(kindKey(2, 1000, id)) // kind 2
	})

	it('authorKey sorts by pubkey, then time descending', () => {
		const keys = [
			authorKey('aaa', 1000, 'id1'),
			authorKey('aaa', 2000, 'id2'), // newer
			authorKey('bbb', 1000, 'id3'),
		]
		const sorted = [...keys].sort()
		expect(sorted[0]).toBe(authorKey('aaa', 2000, 'id2'))
		expect(sorted[1]).toBe(authorKey('aaa', 1000, 'id1'))
		expect(sorted[2]).toBe(authorKey('bbb', 1000, 'id3'))
	})

	it('createdAtKey sorts newest-first globally', () => {
		const keys = [
			createdAtKey(1000, 'id1'),
			createdAtKey(3000, 'id3'),
			createdAtKey(2000, 'id2'),
		]
		const sorted = [...keys].sort()
		expect(sorted[0]).toBe(createdAtKey(3000, 'id3'))
		expect(sorted[1]).toBe(createdAtKey(2000, 'id2'))
		expect(sorted[2]).toBe(createdAtKey(1000, 'id1'))
	})
})

describe('prefixRange', () => {
	it('produces gte with separator and lt with tilde', () => {
		const range = prefixRange('deadbeef')
		expect(range.gte).toBe('deadbeef!')
		expect(range.lt).toBe('deadbeef~')
	})

	it('gte < lt', () => {
		const range = prefixRange('test')
		expect(range.gte < range.lt).toBe(true)
	})
})

describe('timeRange', () => {
	it('with only prefix returns full prefix range', () => {
		const range = timeRange('deadbeef')
		expect(range.gte).toBe('deadbeef!')
		expect(range.lt).toBe('deadbeef~')
	})

	it('with since sets lte bound (inverted = largest value for oldest)', () => {
		const range = timeRange('prefix', 1000)
		expect(range.lte).toBeDefined()
		expect(range.lte!.startsWith('prefix!')).toBe(true)
	})

	it('with until sets gte bound (inverted = smallest value for newest)', () => {
		const range = timeRange('prefix', undefined, 2000)
		expect(range.gte.startsWith('prefix!')).toBe(true)
		expect(range.gte.length).toBeGreaterThan('prefix!'.length)
	})

	it('since and until produce a valid range', () => {
		const range = timeRange('prefix', 1000, 2000)
		expect(range.gte < (range.lte ?? range.lt ?? '')).toBe(true)
	})
})
