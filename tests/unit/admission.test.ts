import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { EventStore } from '../../src/storage/store.js'
import { evaluateAdmissionRequest } from '../../src/swarm/admission.js'
import {
	ADMISSION_VERSION,
	type AdmissionRequest,
	computeAdmissionProof,
} from '../../src/swarm/protocol.js'
import { TokenBucket } from '../../src/util/rate-limit.js'
import { tempStorage, waitFor } from '../helpers.js'

describe('computeAdmissionProof', () => {
	const baseKey = randomBytes(32)
	const handshakeHash = randomBytes(64)
	const writerKey = randomBytes(32)

	it('produces a deterministic 32-byte proof', () => {
		const a = computeAdmissionProof(baseKey, handshakeHash, writerKey)
		const b = computeAdmissionProof(baseKey, handshakeHash, writerKey)
		expect(a.length).toBe(32)
		expect(a.equals(b)).toBe(true)
	})

	it('changes when the base key (invite secret) changes', () => {
		const a = computeAdmissionProof(baseKey, handshakeHash, writerKey)
		const b = computeAdmissionProof(randomBytes(32), handshakeHash, writerKey)
		expect(a.equals(b)).toBe(false)
	})

	it('changes when the handshake hash (connection binding) changes', () => {
		const a = computeAdmissionProof(baseKey, handshakeHash, writerKey)
		const b = computeAdmissionProof(baseKey, randomBytes(64), writerKey)
		expect(a.equals(b)).toBe(false)
	})

	it('changes when the writer key changes', () => {
		const a = computeAdmissionProof(baseKey, handshakeHash, writerKey)
		const b = computeAdmissionProof(baseKey, handshakeHash, randomBytes(32))
		expect(a.equals(b)).toBe(false)
	})
})

describe('evaluateAdmissionRequest (granter logic)', () => {
	const stores: EventStore[] = []

	async function founderStore(): Promise<EventStore> {
		const s = new EventStore(tempStorage(), null)
		await s.ready()
		stores.push(s)
		return s
	}

	/** Build a well-formed request with a valid proof against `store`'s base + handshakeHash */
	function signedRequest(
		store: EventStore,
		handshakeHash: Buffer,
		writerKey: Buffer,
	): AdmissionRequest {
		const baseKey = store.base.key
		if (!baseKey) throw new Error('store base key missing')
		return {
			v: ADMISSION_VERSION,
			writerKey: writerKey.toString('hex'),
			wants: 'writer',
			proof: computeAdmissionProof(baseKey, handshakeHash, writerKey).toString('hex'),
		}
	}

	afterAll(async () => {
		for (const s of stores) await s.close()
	})

	it('admits a writer with a valid proof and actually appends the add_writer', async () => {
		const store = await founderStore()
		const hh = randomBytes(64)
		const writerKey = randomBytes(32)
		const bucket = new TokenBucket(16, 16 / 3600)

		const reply = await evaluateAdmissionRequest(
			store,
			hh,
			signedRequest(store, hh, writerKey),
			bucket,
		)
		expect(reply.admitted).toBe(true)
		expect(reply.reason).toBeUndefined()

		// The op really lands in the writers sub (apply ran).
		await waitFor(() => store.isAdmittedWriter(writerKey.toString('hex')), {
			timeout: 10_000,
			interval: 100,
		})
	})

	it('rejects a forged proof (wrong base key) in constant time', async () => {
		const store = await founderStore()
		const hh = randomBytes(64)
		const writerKey = randomBytes(32)
		const bucket = new TokenBucket(16, 16 / 3600)

		// Proof computed against a DIFFERENT base key — an attacker without the invite.
		const forged: AdmissionRequest = {
			v: ADMISSION_VERSION,
			writerKey: writerKey.toString('hex'),
			wants: 'writer',
			proof: computeAdmissionProof(randomBytes(32), hh, writerKey).toString('hex'),
		}
		const reply = await evaluateAdmissionRequest(store, hh, forged, bucket)
		expect(reply.admitted).toBe(false)
		expect(reply.reason).toBe('invalid proof')
		expect(await store.isAdmittedWriter(writerKey.toString('hex'))).toBe(false)
	})

	it('rejects a proof bound to a different connection (replay protection)', async () => {
		const store = await founderStore()
		const writerKey = randomBytes(32)
		const bucket = new TokenBucket(16, 16 / 3600)

		// Proof made for connection A, presented on connection B.
		const reqForOtherConn = signedRequest(store, randomBytes(64), writerKey)
		const reply = await evaluateAdmissionRequest(store, randomBytes(64), reqForOtherConn, bucket)
		expect(reply.admitted).toBe(false)
		expect(reply.reason).toBe('invalid proof')
	})

	it('rejects malformed requests and bad writer keys', async () => {
		const store = await founderStore()
		const hh = randomBytes(64)
		const bucket = new TokenBucket(16, 16 / 3600)

		const wrongVersion = { ...signedRequest(store, hh, randomBytes(32)), v: 2 }
		expect((await evaluateAdmissionRequest(store, hh, wrongVersion, bucket)).reason).toBe(
			'malformed request',
		)

		const readerWants = { ...signedRequest(store, hh, randomBytes(32)), wants: 'reader' as const }
		expect((await evaluateAdmissionRequest(store, hh, readerWants, bucket)).reason).toBe(
			'malformed request',
		)

		const badKey: AdmissionRequest = {
			v: ADMISSION_VERSION,
			writerKey: 'not-hex',
			wants: 'writer',
			proof: randomBytes(32).toString('hex'),
		}
		expect((await evaluateAdmissionRequest(store, hh, badKey, bucket)).reason).toBe(
			'invalid writer key',
		)
	})

	it('treats an already-admitted key as success without spending a token (dedup)', async () => {
		const store = await founderStore()
		const hh = randomBytes(64)
		const baseKey = store.base.key
		if (!baseKey) throw new Error('base key missing')

		// The founder's own base key is an implicit writer — a perfect dedup case.
		const bucket = new TokenBucket(0, 0) // no tokens: proves dedup never reaches the bucket
		const req = signedRequest(store, hh, baseKey)
		const reply = await evaluateAdmissionRequest(store, hh, req, bucket)
		expect(reply.admitted).toBe(true)
	})

	it('rate-limits a burst of distinct admissions', async () => {
		const store = await founderStore()
		const hh = randomBytes(64)
		const bucket = new TokenBucket(1, 0) // exactly one admission allowed, no refill

		const first = await evaluateAdmissionRequest(
			store,
			hh,
			signedRequest(store, hh, randomBytes(32)),
			bucket,
		)
		expect(first.admitted).toBe(true)

		const second = await evaluateAdmissionRequest(
			store,
			hh,
			signedRequest(store, hh, randomBytes(32)),
			bucket,
		)
		expect(second.admitted).toBe(false)
		expect(second.reason).toBe('rate limited')
	})

	it('refuses to admit when the granter is not itself a writer', async () => {
		// A joiner-style store (bootstrapped to some base) is never writable here.
		const someBaseKey = randomBytes(32)
		const store = new EventStore(tempStorage(), someBaseKey)
		await store.ready()
		stores.push(store)
		expect(store.writable).toBe(false)

		const hh = randomBytes(64)
		const writerKey = randomBytes(32)
		// Proof is valid for this store's base key, but the granter still can't admit.
		const reply = await evaluateAdmissionRequest(
			store,
			hh,
			signedRequest(store, hh, writerKey),
			new TokenBucket(16, 16 / 3600),
		)
		expect(reply.admitted).toBe(false)
		expect(reply.reason).toBe('granter not writable')
	})
})
