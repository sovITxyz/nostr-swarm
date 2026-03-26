/**
 * Hyperbee composite key encoding/decoding.
 *
 * Key design principles:
 * - Inverted timestamps: 0xFFFFFFFF - created_at so lexicographic sort = newest-first
 * - '!' (0x21) separator between fields — sorts before any hex char
 * - Event ID suffix on every index key for uniqueness/tiebreaking
 */

const SEPARATOR = '!'
const MAX_U32 = 0xffffffff

/** Invert a unix timestamp for descending sort order in Hyperbee */
export function invertTimestamp(ts: number): string {
	const inverted = (MAX_U32 - ts) >>> 0
	return inverted.toString(16).padStart(8, '0')
}

/** Recover the original timestamp from an inverted hex string */
export function recoverTimestamp(hex: string): number {
	const inverted = Number.parseInt(hex, 16)
	return (MAX_U32 - inverted) >>> 0
}

/** Encode a kind number as 8-char zero-padded hex (4 bytes big-endian) */
export function encodeKind(kind: number): string {
	return (kind >>> 0).toString(16).padStart(8, '0')
}

/** Decode a hex-encoded kind back to a number */
export function decodeKind(hex: string): number {
	return Number.parseInt(hex, 16)
}

/** Join key parts with the separator */
function joinKey(...parts: string[]): string {
	return parts.join(SEPARATOR)
}

/** Split a composite key into its parts */
export function splitKey(key: string): string[] {
	return key.split(SEPARATOR)
}

// ─── Index Key Builders ──────────────────────────────────────────

/** Primary event store: event_id → event JSON */
export const eventKey = (eventId: string): string => eventId

/** kind index: kind!inv_time!event_id */
export const kindKey = (kind: number, createdAt: number, eventId: string): string =>
	joinKey(encodeKind(kind), invertTimestamp(createdAt), eventId)

/** author index: pubkey!inv_time!event_id */
export const authorKey = (pubkey: string, createdAt: number, eventId: string): string =>
	joinKey(pubkey, invertTimestamp(createdAt), eventId)

/** author+kind index: pubkey!kind!inv_time!event_id */
export const authorKindKey = (
	pubkey: string,
	kind: number,
	createdAt: number,
	eventId: string,
): string => joinKey(pubkey, encodeKind(kind), invertTimestamp(createdAt), eventId)

/** tag index: tag_name!tag_value!inv_time!event_id */
export const tagKey = (
	tagName: string,
	tagValue: string,
	createdAt: number,
	eventId: string,
): string => joinKey(tagName, tagValue, invertTimestamp(createdAt), eventId)

/** created_at index: inv_time!event_id */
export const createdAtKey = (createdAt: number, eventId: string): string =>
	joinKey(invertTimestamp(createdAt), eventId)

/** replaceable event lookup: pubkey!kind */
export const replaceableKey = (pubkey: string, kind: number): string =>
	joinKey(pubkey, encodeKind(kind))

/** addressable event lookup: pubkey!kind!d_tag */
export const addressableKey = (pubkey: string, kind: number, dTag: string): string =>
	joinKey(pubkey, encodeKind(kind), dTag)

/** expiration index: expiry!event_id */
export const expirationKey = (expiry: number, eventId: string): string =>
	joinKey(invertTimestamp(MAX_U32 - expiry), eventId)

/** deletion tracking: deleted_event_id → kind5_event_id */
export const deletionKey = (deletedEventId: string): string => deletedEventId

// ─── Range Bound Helpers ─────────────────────────────────────────

/** Get range bounds for scanning a prefix (gte/lt) */
export function prefixRange(prefix: string): { gte: string; lt: string } {
	return {
		gte: prefix + SEPARATOR,
		lt: prefix + '~', // '~' (0x7E) sorts after all hex + separator chars
	}
}

/** Get range bounds for a time window within a prefix */
export function timeRange(
	prefix: string,
	since?: number,
	until?: number,
): { gte: string; lt?: string; lte?: string } {
	// Inverted timestamps flip since/until:
	// since (oldest) → upper bound on inverted time (lte)
	// until (newest) → lower bound on inverted time (gte)
	const bounds: { gte: string; lt?: string; lte?: string } = {
		gte: prefix + SEPARATOR,
	}

	if (until !== undefined) {
		// until is the newest timestamp we want — it becomes the gte bound (smallest inverted value)
		bounds.gte = prefix + SEPARATOR + invertTimestamp(until)
	}

	if (since !== undefined) {
		// since is the oldest timestamp we want — it becomes the lte bound (largest inverted value)
		bounds.lte = prefix + SEPARATOR + invertTimestamp(since) + '~'
	} else {
		bounds.lt = prefix + '~'
	}

	return bounds
}
