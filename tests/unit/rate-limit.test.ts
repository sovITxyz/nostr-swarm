import { describe, expect, it } from 'vitest'
import { TokenBucket } from '../../src/util/rate-limit.js'

describe('TokenBucket', () => {
	it('allows up to capacity then blocks', () => {
		const bucket = new TokenBucket(3, 0) // no refill
		expect(bucket.consume()).toBe(true)
		expect(bucket.consume()).toBe(true)
		expect(bucket.consume()).toBe(true)
		expect(bucket.consume()).toBe(false)
	})

	it('refunds a consumed token so a later consume succeeds', () => {
		const bucket = new TokenBucket(1, 0) // exactly one token, no refill
		expect(bucket.consume()).toBe(true)
		expect(bucket.consume()).toBe(false)
		bucket.refund()
		expect(bucket.consume()).toBe(true)
	})

	it('never refunds above capacity', () => {
		const bucket = new TokenBucket(1, 0)
		// Refund without a prior consume must not let two consumes through.
		bucket.refund()
		expect(bucket.consume()).toBe(true)
		expect(bucket.consume()).toBe(false)
	})
})
