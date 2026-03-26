import type { NostrEvent } from '../util/types.js'
import { getExpiration } from './events.js'

/** Check if an event should be rejected due to expiration (NIP-40) */
export function shouldRejectExpired(event: NostrEvent): boolean {
	const exp = getExpiration(event)
	if (exp === null) return false
	return exp <= Math.floor(Date.now() / 1000)
}

/** Check if a stored event is expired and should not be sent to clients */
export function isEventExpired(event: NostrEvent): boolean {
	return shouldRejectExpired(event)
}
