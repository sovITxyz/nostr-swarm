import { verifyEvent } from 'nostr-tools/pure'
import type { EventKind, NostrEvent } from '../util/types.js'

/** Classify an event kind per NIP-01 */
export function classifyKind(kind: number): EventKind {
	if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return 'replaceable'
	if (kind >= 20000 && kind < 30000) return 'ephemeral'
	if (kind >= 30000 && kind < 40000) return 'addressable'
	return 'regular'
}

/** Check if an event is a deletion request (NIP-09) */
export function isDeletion(kind: number): boolean {
	return kind === 5
}

/** Get the 'd' tag value for addressable events */
export function getDTag(event: NostrEvent): string {
	const tag = event.tags.find((t) => t[0] === 'd')
	return tag?.[1] ?? ''
}

/** Get the expiration timestamp from an event (NIP-40) */
export function getExpiration(event: NostrEvent): number | null {
	const tag = event.tags.find((t) => t[0] === 'expiration')
	if (!tag?.[1]) return null
	const exp = Number.parseInt(tag[1], 10)
	return Number.isNaN(exp) ? null : exp
}

/** Check if an event is expired (NIP-40) */
export function isExpired(event: NostrEvent): boolean {
	const exp = getExpiration(event)
	if (exp === null) return false
	return exp <= Math.floor(Date.now() / 1000)
}

/** Check if an event is protected (NIP-70, has "-" tag) */
export function isProtected(event: NostrEvent): boolean {
	return event.tags.some((t) => t[0] === '-')
}

/** Get all indexable single-letter tags from an event */
export function getIndexableTags(event: NostrEvent): Array<{ name: string; value: string }> {
	const tags: Array<{ name: string; value: string }> = []
	for (const tag of event.tags) {
		const name = tag[0]
		const value = tag[1]
		// Only index single-letter tags per NIP-01 filter spec
		if (name && name.length === 1 && value) {
			tags.push({ name, value })
		}
	}
	return tags
}

/** Validate a Nostr event structure */
export function validateEventStructure(event: unknown): event is NostrEvent {
	if (typeof event !== 'object' || event === null) return false
	const e = event as Record<string, unknown>
	return (
		typeof e.id === 'string' &&
		e.id.length === 64 &&
		typeof e.pubkey === 'string' &&
		e.pubkey.length === 64 &&
		typeof e.created_at === 'number' &&
		Number.isInteger(e.created_at) &&
		typeof e.kind === 'number' &&
		Number.isInteger(e.kind) &&
		e.kind >= 0 &&
		Array.isArray(e.tags) &&
		typeof e.content === 'string' &&
		typeof e.sig === 'string' &&
		e.sig.length === 128
	)
}

/** Verify an event's signature using nostr-tools */
export function verifyEventSignature(event: NostrEvent): boolean {
	return verifyEvent(event as Parameters<typeof verifyEvent>[0])
}

/** Determine if event A should replace event B (both must share the same replaceable/addressable key) */
export function shouldReplace(existing: NostrEvent, incoming: NostrEvent): boolean {
	if (incoming.created_at > existing.created_at) return true
	if (incoming.created_at === existing.created_at && incoming.id < existing.id) return true
	return false
}
