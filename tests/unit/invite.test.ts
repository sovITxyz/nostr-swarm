import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import z32 from 'z32'
import { decodeInvite, encodeInvite, parseBootstrap } from '../../src/util/invite.js'

/** Build 'nsw1' + z32(payload) from a raw payload buffer */
function inviteFromPayload(payload: Buffer): string {
	return `nsw1${z32.encode(payload)}`
}

/** version || key || sha256(version || key)[0..4) */
function buildPayload(version: number, key: Buffer): Buffer {
	const versionAndKey = Buffer.concat([Buffer.from([version]), key])
	const checksum = createHash('sha256').update(versionAndKey).digest().subarray(0, 4)
	return Buffer.concat([versionAndKey, checksum])
}

describe('encodeInvite / decodeInvite', () => {
	it('round-trips a random 32-byte key', () => {
		for (let i = 0; i < 16; i++) {
			const key = randomBytes(32)
			const invite = encodeInvite(key)
			expect(invite.startsWith('nsw1')).toBe(true)
			expect(decodeInvite(invite).equals(key)).toBe(true)
		}
	})

	it('produces only z-base32 alphabet characters after the prefix', () => {
		const invite = encodeInvite(randomBytes(32))
		for (const ch of invite.slice(4)) {
			expect(z32.ALPHABET.includes(ch)).toBe(true)
		}
	})

	it('rejects a non-32-byte key at encode time', () => {
		expect(() => encodeInvite(randomBytes(31))).toThrow(/32 bytes/)
		expect(() => encodeInvite(randomBytes(33))).toThrow(/32 bytes/)
	})

	it('rejects a corrupted checksum', () => {
		const key = randomBytes(32)
		const payload = buildPayload(0x01, key)
		const corrupted = Buffer.from(payload)
		corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff
		expect(() => decodeInvite(inviteFromPayload(corrupted))).toThrow(/checksum/)
	})

	it('rejects a corrupted key byte (checksum no longer matches)', () => {
		const key = randomBytes(32)
		const payload = buildPayload(0x01, key)
		const corrupted = Buffer.from(payload)
		corrupted[10] = (corrupted[10] ?? 0) ^ 0x01
		expect(() => decodeInvite(inviteFromPayload(corrupted))).toThrow(/checksum/)
	})

	it('rejects an unsupported version even with a valid checksum', () => {
		const payload = buildPayload(0x02, randomBytes(32))
		expect(() => decodeInvite(inviteFromPayload(payload))).toThrow(/version/)
	})

	it('rejects a wrong-length payload', () => {
		expect(() => decodeInvite(inviteFromPayload(randomBytes(20)))).toThrow(/length/)
		expect(() => decodeInvite(inviteFromPayload(randomBytes(64)))).toThrow(/length/)
	})

	it('rejects a missing prefix', () => {
		const invite = encodeInvite(randomBytes(32))
		expect(() => decodeInvite(invite.slice(4))).toThrow(/prefix/)
	})

	it('rejects characters outside the z-base32 alphabet', () => {
		// 'l', 'v', '0' and '2' are not in the z-base32 alphabet
		expect(() => decodeInvite('nsw1llllllllll')).toThrow(/invalid invite/)
	})
})

describe('parseBootstrap', () => {
	it('returns null for the empty string (founder)', () => {
		expect(parseBootstrap('')).toBeNull()
	})

	it('decodes an nsw1 invite', () => {
		const key = randomBytes(32)
		const parsed = parseBootstrap(encodeInvite(key))
		expect(parsed?.equals(key)).toBe(true)
	})

	it('accepts a raw 64-hex key (lowercase and uppercase)', () => {
		const key = randomBytes(32)
		const lower = parseBootstrap(key.toString('hex'))
		const upper = parseBootstrap(key.toString('hex').toUpperCase())
		expect(lower?.equals(key)).toBe(true)
		expect(upper?.equals(key)).toBe(true)
	})

	it('throws on a corrupted invite instead of falling back', () => {
		const invite = encodeInvite(randomBytes(32))
		// Swap a character covering the checksum bytes for a different alphabet
		// character (the very last char carries padding bits and may decode
		// identically, so corrupt the third-from-last instead)
		const idx = invite.length - 3
		const original = invite[idx]
		const replacement = z32.ALPHABET.split('').find((c) => c !== original) ?? ''
		const corrupted = invite.slice(0, idx) + replacement + invite.slice(idx + 1)
		expect(() => parseBootstrap(corrupted)).toThrow(/invalid invite/)
	})

	it('throws on garbage values (fatal at startup)', () => {
		expect(() => parseBootstrap('not-a-key')).toThrow(/invalid bootstrap value/)
		expect(() => parseBootstrap('deadbeef')).toThrow(/invalid bootstrap value/)
		// 63 hex chars: too short for a raw key
		expect(() => parseBootstrap('a'.repeat(63))).toThrow(/invalid bootstrap value/)
		// 65 hex chars: too long
		expect(() => parseBootstrap('a'.repeat(65))).toThrow(/invalid bootstrap value/)
		// whitespace is not trimmed: a padded key is rejected, not re-founded silently
		expect(() => parseBootstrap(` ${'a'.repeat(64)}`)).toThrow(/invalid bootstrap value/)
	})
})
