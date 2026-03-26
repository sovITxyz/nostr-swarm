import type { NostrEvent } from '../util/types.js'

/** Check if an event is protected per NIP-70 (has "-" tag) */
export function isProtectedEvent(event: NostrEvent): boolean {
	return event.tags.some((t) => t[0] === '-')
}

/** Check if a protected event should be rejected based on auth state */
export function shouldRejectProtected(
	event: NostrEvent,
	authPubkey: string | null,
): boolean {
	if (!isProtectedEvent(event)) return false
	return authPubkey !== event.pubkey
}
