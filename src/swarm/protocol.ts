/**
 * Swarm protocol extensions.
 *
 * In v1, Autobase replication (`store.base.replicate(socket)`) handles all
 * data sync, and writer admission is operator-driven (`--admit`, restart).
 * This module carries the complete contract for the v2 in-band admission
 * channel (docs/design/multiwriter-sync.md §3.6) so a later release can
 * implement it without redesign:
 *
 * ## v2 admission channel: 'nostr-swarm/admission@1'
 *
 * Transport: a protomux channel named 'nostr-swarm/admission@1' opened via
 * `Protomux.from(socket)` on the existing swarm connection, coexisting with
 * Autobase replication on the same muxer. Implementation hazards:
 * - `createChannel` returns null when the channel already exists on the
 *   muxer (duplicate open) — this MUST be handled, not assumed non-null.
 * - Every message handler MUST be wrapped in try/catch: an uncaught throw
 *   destroys the whole connection, including replication.
 *
 * Handshake message (JSON), joiner -> granter:
 *
 *   {
 *     v: 1,                       // protocol version
 *     writerKey: <hex64>,         // joiner's base.local.key
 *     wants: 'writer' | 'reader', // 'reader' = announce-only, no admission
 *     proof: <hex64>              // see below
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
 *    handshakeHash;
 * 2. writers-sub dedup (already-admitted keys reply admitted: true, no op);
 * 3. the 64-writer cap (MAX_WRITERS in storage/store.ts);
 * 4. a per-admitter token bucket of 16 admissions/hour.
 *
 * The joiner then simply watches its base's 'writable' event — admission
 * replicates like any other op, exactly as in the v1 --admit flow.
 */

import type { SwarmMessage } from '../util/types.js'

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
