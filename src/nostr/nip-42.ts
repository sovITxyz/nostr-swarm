import type { NostrEvent } from '../util/types.js'
import { verifyEventSignature } from './events.js'

export interface AuthResult {
	ok: boolean
	pubkey?: string
	message: string
}

/** Validate a NIP-42 AUTH response event */
export function validateAuth(
	event: NostrEvent,
	expectedChallenge: string,
): AuthResult {
	// Must be kind 22242
	if (event.kind !== 22242) {
		return { ok: false, message: 'invalid: auth event must be kind 22242' }
	}

	// Verify signature
	if (!verifyEventSignature(event)) {
		return { ok: false, message: 'invalid: bad signature' }
	}

	// Check challenge tag
	const challengeTag = event.tags.find((t) => t[0] === 'challenge')
	if (challengeTag?.[1] !== expectedChallenge) {
		return { ok: false, message: 'invalid: wrong challenge' }
	}

	// Check relay tag exists
	const relayTag = event.tags.find((t) => t[0] === 'relay')
	if (!relayTag?.[1]) {
		return { ok: false, message: 'invalid: missing relay tag' }
	}

	// Check timestamp is recent (within 10 minutes)
	const now = Math.floor(Date.now() / 1000)
	if (Math.abs(now - event.created_at) > 600) {
		return { ok: false, message: 'invalid: auth event too old or too new' }
	}

	return { ok: true, pubkey: event.pubkey, message: '' }
}
