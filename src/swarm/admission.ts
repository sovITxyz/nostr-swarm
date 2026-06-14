import { timingSafeEqual } from 'node:crypto'
import c from 'compact-encoding'
import type { SwarmSocket } from 'hyperswarm'
import Protomux from 'protomux'
import type { EventStore } from '../storage/store.js'
import { logger } from '../util/logger.js'
import { TokenBucket } from '../util/rate-limit.js'
import {
	ADMISSION_PROTOCOL,
	ADMISSION_VERSION,
	type AdmissionReply,
	type AdmissionRequest,
	computeAdmissionProof,
} from './protocol.js'

/** Writer keys are 64 lowercase hex (the joiner's base.local.key) */
const WRITER_KEY_RE = /^[0-9a-f]{64}$/
/** Admission proof is HMAC-SHA256 -> 32 bytes -> 64 hex chars */
const PROOF_RE = /^[0-9a-f]{64}$/i

/**
 * Granter-side admission budget (the v2 contract's "16 admissions/hour").
 * One bucket per node bounds how fast NEW writers are appended, capping
 * add_writer spam even from a holder of the invite.
 */
const ADMISSIONS_PER_HOUR = 16

/**
 * Per-connection request cap. The swarm topic is NOT derived from the invite,
 * so any peer that merely knows the topic can open the channel and send junk
 * requests; this bounds the proof-verification work per connection. Legitimate
 * joiners send exactly one request.
 */
const MAX_REQUESTS_PER_CONN = 16

/**
 * Global request-evaluation backstop (across all connections). The per-
 * connection cap resets on reconnect, so a peer that opens/closes connections
 * repeatedly could otherwise evaluate unbounded requests; this bounds total
 * evaluation regardless of connection churn. Sized to never impede real
 * onboarding (a burst large enough to admit every possible writer at once).
 */
const REQUEST_BURST = 64
const REQUESTS_PER_SEC = 8

/** Anything with a typed send() — the object returned by protomux addMessage() */
interface Sender<T> {
	send(data: T): boolean
}

export interface AdmissionOptions {
	/** Joiner: send a proven writer-admission request on each connection until writable */
	requestWriter: boolean
	/** Granter: honor inbound admission requests proven by invite possession */
	autoAdmit: boolean
}

/**
 * Granter-side evaluation of one admission request. Pure with respect to its
 * inputs (no socket/protomux coupling) so it is unit-testable. Returns the
 * reply to send back; appends an add_writer op as a side effect on success.
 *
 * Check order mirrors docs/design/multiwriter-sync.md §3.6: proof, then dedup,
 * then the rate-limit token, then the append (whose apply() re-checks dedup and
 * the 64-writer cap). A token is refunded when the append is a no-op (lost a
 * race on the cap or a concurrent admission), so dedup/cap never durably cost
 * a token.
 */
export async function evaluateAdmissionRequest(
	store: EventStore,
	handshakeHash: Buffer | null,
	req: AdmissionRequest,
	bucket: TokenBucket,
): Promise<AdmissionReply> {
	if (
		!req ||
		req.v !== ADMISSION_VERSION ||
		req.wants !== 'writer' ||
		typeof req.writerKey !== 'string' ||
		typeof req.proof !== 'string'
	) {
		return { admitted: false, reason: 'malformed request' }
	}

	const writerKey = req.writerKey.toLowerCase()
	if (!WRITER_KEY_RE.test(writerKey)) {
		return { admitted: false, reason: 'invalid writer key' }
	}
	if (!PROOF_RE.test(req.proof)) {
		return { admitted: false, reason: 'invalid proof' }
	}

	// Only an existing writer (founder or admitted) can admit others.
	if (!store.writable) {
		return { admitted: false, reason: 'granter not writable' }
	}

	const baseKey = store.base.key
	if (!baseKey || !handshakeHash) {
		return { admitted: false, reason: 'connection not ready' }
	}

	// 1. Verify the proof in constant time. The HMAC key is base.key (the
	//    invite), so only an invite holder can produce a matching proof, and
	//    binding to this connection's handshakeHash makes it non-replayable.
	const expected = computeAdmissionProof(baseKey, handshakeHash, Buffer.from(writerKey, 'hex'))
	const provided = Buffer.from(req.proof.toLowerCase(), 'hex')
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
		return { admitted: false, reason: 'invalid proof' }
	}

	// 2. Dedup — already a writer (no token spent).
	if (await store.isAdmittedWriter(writerKey)) {
		return { admitted: true }
	}

	// 3. Spend a rate-limit token for this admission attempt.
	if (!bucket.consume()) {
		return { admitted: false, reason: 'rate limited' }
	}

	// 4. Append the add_writer op. admitWriter (and apply) re-check dedup + the
	//    64-writer cap deterministically. If the append is a no-op because we
	//    lost a race, refund the token so only real admissions are charged.
	const result = await store.admitWriter(writerKey)
	if (result === 'appended') {
		return { admitted: true }
	}
	bucket.refund()
	if (result === 'already-admitted') {
		return { admitted: true }
	}
	return { admitted: false, reason: result === 'cap-reached' ? 'writer cap reached' : result }
}

/**
 * Runs the v2 in-band admission channel over each swarm connection. A joiner
 * (`requestWriter`) sends a proof of invite possession; a granter
 * (`autoAdmit`) verifies it and appends the add_writer op. Both ends opt in
 * explicitly — with neither flag set the channel is never opened and the node
 * behaves exactly as in v1 (operator `--admit` only).
 */
export class AdmissionService {
	private readonly store: EventStore
	private readonly opts: AdmissionOptions
	// Granter budget: capacity = burst of 16, refilling at 16/hour.
	private readonly bucket = new TokenBucket(ADMISSIONS_PER_HOUR, ADMISSIONS_PER_HOUR / 3600)
	// Global request-evaluation backstop across all connections (see REQUEST_BURST).
	private readonly requestBudget = new TokenBucket(REQUEST_BURST, REQUESTS_PER_SEC)

	constructor(store: EventStore, opts: AdmissionOptions) {
		this.store = store
		this.opts = opts
	}

	/** Whether this node plays any admission role; if not, the channel is never opened. */
	get active(): boolean {
		return this.opts.requestWriter || this.opts.autoAdmit
	}

	/**
	 * Attach the admission channel to a freshly-established swarm connection.
	 * Must be called after `base.replicate(socket)` so it reuses the muxer
	 * Autobase created. All setup is wrapped so a failure here never tears down
	 * replication on the same socket.
	 */
	attach(socket: SwarmSocket): void {
		if (!this.active) return
		try {
			const mux = Protomux.from(socket)
			const channel = mux.createChannel({ protocol: ADMISSION_PROTOCOL })
			// null => a duplicate admission channel already exists on this mux.
			if (channel === null) return

			let requestsHandled = 0
			// Messages are added in a fixed order (request, then reply) so their
			// indices line up on both peers.
			const requestMsg = channel.addMessage<AdmissionRequest>({
				encoding: c.json,
				onmessage: (req) => {
					// Granter path. Ignore inbound requests unless we opted in, and
					// bound work against spammers: per-connection first, then a
					// global budget so reconnect cycling can't reset its way around it.
					if (!this.opts.autoAdmit) return
					if (requestsHandled >= MAX_REQUESTS_PER_CONN) return
					requestsHandled++
					if (!this.requestBudget.consume()) return
					this.handleRequest(socket, req, replyMsg).catch((err) =>
						logger.error('Admission request handler error', { error: String(err) }),
					)
				},
			})
			const replyMsg: Sender<AdmissionReply> = channel.addMessage<AdmissionReply>({
				encoding: c.json,
				onmessage: (reply) => {
					try {
						this.handleReply(reply)
					} catch (err) {
						logger.error('Admission reply handler error', { error: String(err) })
					}
				},
			})

			channel.open()

			// Joiner path: request admission once per connection while read-only.
			if (this.opts.requestWriter && !this.store.writable) {
				this.sendRequest(socket, requestMsg)
			}
		} catch (err) {
			logger.error('Admission channel setup failed', { error: String(err) })
		}
	}

	/** Granter: evaluate a request and reply with the decision. */
	private async handleRequest(
		socket: SwarmSocket,
		req: AdmissionRequest,
		replyMsg: Sender<AdmissionReply>,
	): Promise<void> {
		const reply = await evaluateAdmissionRequest(this.store, socket.handshakeHash, req, this.bucket)
		if (reply.admitted) {
			logger.info('Admitted writer in-band', {
				writerKey: typeof req?.writerKey === 'string' ? req.writerKey.slice(0, 16) : 'invalid',
			})
		} else {
			logger.warn('Rejected in-band admission request', { reason: reply.reason })
		}
		replyMsg.send(reply)
	}

	/** Joiner: log the granter's decision. The real signal is base 'writable'. */
	private handleReply(reply: AdmissionReply): void {
		if (!reply || typeof reply.admitted !== 'boolean') return
		if (reply.admitted) {
			logger.info('Writer admission accepted by peer (writable follows via replication)')
		} else {
			logger.warn('Writer admission rejected by peer', { reason: reply.reason ?? 'unknown' })
		}
	}

	/** Joiner: build and send a proof of invite possession for our writer key. */
	private sendRequest(socket: SwarmSocket, requestMsg: Sender<AdmissionRequest>): void {
		try {
			const baseKey = this.store.base.key
			const handshakeHash = socket.handshakeHash
			if (!baseKey || !handshakeHash) {
				logger.warn('Cannot request admission: base key or handshake hash not ready')
				return
			}
			const writerKey = this.store.localWriterKey
			const proof = computeAdmissionProof(baseKey, handshakeHash, writerKey)
			requestMsg.send({
				v: ADMISSION_VERSION,
				writerKey: writerKey.toString('hex'),
				wants: 'writer',
				proof: proof.toString('hex'),
			})
			logger.info('Sent writer admission request', {
				writerKey: writerKey.toString('hex').slice(0, 16),
			})
		} catch (err) {
			logger.error('Failed to send admission request', { error: String(err) })
		}
	}
}
