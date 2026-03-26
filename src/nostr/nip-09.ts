import type { NostrEvent } from '../util/types.js'

/** Extract target event IDs from a kind 5 deletion event (NIP-09) */
export function getDeletionTargets(event: NostrEvent): string[] {
	if (event.kind !== 5) return []
	return event.tags.filter((t) => t[0] === 'e' && t[1]).map((t) => t[1]!)
}

/** Validate that a deletion event has at least one 'e' tag */
export function isValidDeletion(event: NostrEvent): boolean {
	return event.kind === 5 && event.tags.some((t) => t[0] === 'e' && t[1])
}
