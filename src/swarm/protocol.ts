/**
 * Swarm protocol extensions.
 *
 * For v1, Corestore replication handles all data sync.
 * This module is a placeholder for future protocol extensions
 * like event_notify for low-latency subscription updates.
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
