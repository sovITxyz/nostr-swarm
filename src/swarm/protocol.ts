/**
 * Swarm protocol extensions.
 *
 * In v1, Autobase replication (`store.base.replicate(socket)`) handles all
 * data sync, and writer admission is operator-driven (`--admit`, restart).
 * The v2 in-band admission channel (docs/design/multiwriter-sync.md §3.6) is
 * now implemented (see `swarm/admission.ts`); this module defines its wire
 * contract — the channel name, the proof construction, and the message shapes.
 *
 * ## v2 admission channel: 'nostr-swarm/admission@1'
 *
 * Transport: a protomux channel named 'nostr-swarm/admission@1' opened via
 * `Protomux.from(socket)` on the existing swarm connection, coexisting with
 * Autobase replication on the same muxer. Implementation hazards (handled in
 * admission.ts):
 * - `createChannel` returns null when the channel already exists on the
 *   muxer (duplicate open) — this MUST be handled, not assumed non-null.
 * - Every message handler MUST be wrapped in try/catch: an uncaught throw
 *   destroys the whole connection, including replication.
 *
 * Both sides opt in explicitly (so the read invite never silently becomes a
 * write capability for existing deployments): a granter sets `--auto-admit`
 * to honor requests; a joiner sets `--request-writer` to send one. Without
 * those flags the channel is never opened and behavior is exactly v1.
 *
 * Request message (JSON), joiner -> granter:
 *
 *   {
 *     v: 1,                       // protocol version
 *     writerKey: <hex64>,         // joiner's base.local.key
 *     wants: 'writer' | 'reader', // only 'writer' triggers admission
 *     proof: <hex64>              // see computeAdmissionProof
 *   }
 *
 *   proof = HMAC-SHA256(
 *     key  = base.key,
 *     data = utf8('nostr-swarm/admit/1') || conn.handshakeHash || writerKeyBytes
 *   )
 *
 * The proof demonstrates possession of the invite (base.key) and is bound to
 * the Noise session via `conn.handshakeHash`, making it replay-proof across
 * connections, with no persistent swarm seed needed.
 *
 * Reply message (JSON), granter -> joiner:
 *
 *   { admitted: boolean, reason?: string }
 *
 * Granter-side checks, in order, before appending add_writer:
 * 1. proof verifies against this base's key and this connection's
 *    handshakeHash (constant-time compare);
 * 2. writers-sub dedup (already-admitted keys reply admitted: true, no op);
 * 3. a per-admitter token bucket of 16 admissions/hour — spent for the append
 *    attempt and refunded if the append is a no-op (so only real admissions
 *    are charged). apply() re-checks dedup and the 64-writer cap (MAX_WRITERS
 *    in storage/store.ts) deterministically.
 *
 * Inbound requests are additionally bounded per connection and by a global
 * request-evaluation budget, so a peer that only knows the (non-secret) topic
 * cannot make a granter burn CPU verifying junk proofs via connection churn.
 *
 * The joiner then simply watches its base's 'writable' event — admission
 * replicates like any other op, exactly as in the v1 --admit flow.
 */

import { createHmac } from 'node:crypto'
import type { SwarmMessage } from '../util/types.js'

/** protomux channel name for the v2 admission protocol */
export const ADMISSION_PROTOCOL = 'nostr-swarm/admission@1'

/** Domain-separation tag mixed into the admission proof */
export const ADMISSION_DOMAIN = 'nostr-swarm/admit/1'

/** Current admission protocol version */
export const ADMISSION_VERSION = 1

/** Joiner -> granter: a proven request to be admitted as a writer */
export interface AdmissionRequest {
	/** Protocol version (ADMISSION_VERSION) */
	v: number
	/** The joiner's base.local.key as 64 lowercase hex */
	writerKey: string
	/** Only 'writer' requests admission; 'reader' is announce-only */
	wants: 'writer' | 'reader'
	/** computeAdmissionProof() output as 64 hex chars (32 bytes) */
	proof: string
}

/** Granter -> joiner: the admission decision (informational; the real signal is the base 'writable' event) */
export interface AdmissionReply {
	admitted: boolean
	reason?: string
}

/**
 * Compute the admission proof:
 *   HMAC-SHA256(key = baseKey, data = utf8(ADMISSION_DOMAIN) || handshakeHash || writerKey)
 *
 * Both peers of a Noise connection derive the same `handshakeHash`, and both
 * hold `baseKey` (the invite), so a joiner and a granter compute the identical
 * proof. Possession of `baseKey` is the authorization; binding to the
 * per-connection `handshakeHash` prevents replay onto another connection.
 */
export function computeAdmissionProof(
	baseKey: Buffer,
	handshakeHash: Buffer,
	writerKey: Buffer,
): Buffer {
	return createHmac('sha256', baseKey)
		.update(Buffer.concat([Buffer.from(ADMISSION_DOMAIN, 'utf8'), handshakeHash, writerKey]))
		.digest()
}

/** Encode a swarm protocol message */
export function encodeMessage(msg: SwarmMessage): Buffer {
	return Buffer.from(JSON.stringify(msg))
}

/** Decode a swarm protocol message */
export function decodeMessage(buf: Buffer): SwarmMessage | null {
	try {
		return JSON.parse(buf.toString()) as SwarmMessage
	} catch {
		return null
	}
}
