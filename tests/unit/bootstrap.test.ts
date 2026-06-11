import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	persistBootstrapKey,
	resolveBootstrap,
	writeKeysFile,
} from '../../src/storage/bootstrap.js'
import { decodeInvite, encodeInvite } from '../../src/util/invite.js'

const dirs: string[] = []

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'nostr-swarm-bootstrap-test-'))
	dirs.push(dir)
	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe('resolveBootstrap', () => {
	it('returns null when neither file nor config exists (founder path)', () => {
		const dir = tempDir()
		expect(resolveBootstrap(dir, '')).toBeNull()
		// Founder persists nothing until the base is ready (caller's job)
		expect(existsSync(join(dir, 'bootstrap-key'))).toBe(false)
	})

	it('persists a configured hex key on first start and reloads it', () => {
		const dir = tempDir()
		const key = randomBytes(32)

		const first = resolveBootstrap(dir, key.toString('hex'))
		expect(first?.equals(key)).toBe(true)
		expect(readFileSync(join(dir, 'bootstrap-key'), 'utf8').trim()).toBe(key.toString('hex'))

		// Restart with the same config: same key
		expect(resolveBootstrap(dir, key.toString('hex'))?.equals(key)).toBe(true)
		// Restart with no config (flag dropped): persisted key still wins
		expect(resolveBootstrap(dir, '')?.equals(key)).toBe(true)
	})

	it('accepts an nsw1 invite as the configured value', () => {
		const dir = tempDir()
		const key = randomBytes(32)

		expect(resolveBootstrap(dir, encodeInvite(key))?.equals(key)).toBe(true)
		// Persisted as raw hex; reloads without the flag
		expect(resolveBootstrap(dir, '')?.equals(key)).toBe(true)
		// Equivalent forms (invite vs raw hex) are not a mismatch
		expect(resolveBootstrap(dir, key.toString('hex'))?.equals(key)).toBe(true)
	})

	it('creates the storage directory if missing when persisting', () => {
		const dir = join(tempDir(), 'nested', 'storage')
		const key = randomBytes(32)
		expect(resolveBootstrap(dir, key.toString('hex'))?.equals(key)).toBe(true)
		expect(resolveBootstrap(dir, '')?.equals(key)).toBe(true)
	})

	it('throws when the configured key differs from the persisted one (re-found guard)', () => {
		const dir = tempDir()
		const keyA = randomBytes(32)
		const keyB = randomBytes(32)

		resolveBootstrap(dir, keyA.toString('hex'))
		expect(() => resolveBootstrap(dir, keyB.toString('hex'))).toThrow(/bootstrap key mismatch/)
		expect(() => resolveBootstrap(dir, encodeInvite(keyB))).toThrow(/bootstrap key mismatch/)
		// The persisted key is untouched after the failed start
		expect(resolveBootstrap(dir, '')?.equals(keyA)).toBe(true)
	})

	it('propagates parseBootstrap errors for invalid configured values', () => {
		const dir = tempDir()
		expect(() => resolveBootstrap(dir, 'garbage')).toThrow(/invalid bootstrap value/)
		// No file written on a failed parse
		expect(existsSync(join(dir, 'bootstrap-key'))).toBe(false)
	})

	it('throws on a corrupted bootstrap-key file', () => {
		const dir = tempDir()
		writeFileSync(join(dir, 'bootstrap-key'), 'not hex at all\n')
		expect(() => resolveBootstrap(dir, '')).toThrow(/corrupted bootstrap-key/)
	})
})

describe('persistBootstrapKey', () => {
	it('records the founder base key so later starts resolve to it', () => {
		const dir = tempDir()
		const key = randomBytes(32)

		// Founder: nothing configured, base founded, then key persisted at ready
		expect(resolveBootstrap(dir, '')).toBeNull()
		persistBootstrapKey(dir, key)

		expect(resolveBootstrap(dir, '')?.equals(key)).toBe(true)
		// A conflicting --bootstrap on a founded dir is fatal
		expect(() => resolveBootstrap(dir, randomBytes(32).toString('hex'))).toThrow(
			/bootstrap key mismatch/,
		)
	})
})

describe('writeKeysFile', () => {
	it('writes keys.json with baseKey, invite and writerKey', () => {
		const dir = tempDir()
		const baseKey = randomBytes(32)
		const writerKey = randomBytes(32)

		writeKeysFile(dir, baseKey, writerKey)

		const parsed = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8'))
		expect(parsed).toEqual({
			baseKey: baseKey.toString('hex'),
			invite: encodeInvite(baseKey),
			writerKey: writerKey.toString('hex'),
		})
		expect(decodeInvite(parsed.invite).equals(baseKey)).toBe(true)
	})
})
