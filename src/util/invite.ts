/**
 * Invite codec for sharing an Autobase bootstrap key operator-to-operator.
 *
 * Wire format (docs/design/multiwriter-sync.md §3.1):
 *
 *   invite  = 'nsw1' + z32encode(payload)
 *   payload = version(1 byte, 0x01) || baseKey(32 bytes) || sha256(version || baseKey)[0..4)
 *
 * The checksum makes invites typo-proof: a corrupted bootstrap value is a hard
 * startup error, never a silently re-founded empty node. Raw 64-hex base keys
 * remain accepted for scripting.
 */

import { createHash } from 'node:crypto'
import z32 from 'z32'

const PREFIX = 'nsw1'
const VERSION = 0x01
const KEY_LENGTH = 32
const CHECKSUM_LENGTH = 4
const PAYLOAD_LENGTH = 1 + KEY_LENGTH + CHECKSUM_LENGTH
const HEX64 = /^[0-9a-f]{64}$/i

/** First 4 bytes of sha256(version || baseKey) */
function checksum(versionAndKey: Buffer): Buffer {
	return createHash('sha256').update(versionAndKey).digest().subarray(0, CHECKSUM_LENGTH)
}

/** Encode a 32-byte Autobase key as a checksummed 'nsw1…' invite */
export function encodeInvite(baseKey: Buffer): string {
	if (baseKey.length !== KEY_LENGTH) {
		throw new Error(`invalid base key: expected ${KEY_LENGTH} bytes, got ${baseKey.length}`)
	}
	const versionAndKey = Buffer.concat([Buffer.from([VERSION]), baseKey])
	const payload = Buffer.concat([versionAndKey, checksum(versionAndKey)])
	return PREFIX + z32.encode(payload)
}

/**
 * Decode an 'nsw1…' invite back to the 32-byte base key.
 * Throws on bad prefix, unsupported version, wrong length, or checksum mismatch.
 */
export function decodeInvite(code: string): Buffer {
	if (!code.startsWith(PREFIX)) {
		throw new Error(`invalid invite: missing '${PREFIX}' prefix`)
	}
	let payload: Buffer
	try {
		payload = z32.decode(code.slice(PREFIX.length))
	} catch (err) {
		throw new Error(`invalid invite: ${err instanceof Error ? err.message : String(err)}`)
	}
	if (payload.length !== PAYLOAD_LENGTH) {
		throw new Error(
			`invalid invite: wrong length (expected ${PAYLOAD_LENGTH} payload bytes, got ${payload.length})`,
		)
	}
	if (payload[0] !== VERSION) {
		throw new Error(`invalid invite: unsupported version ${payload[0]}`)
	}
	const versionAndKey = payload.subarray(0, 1 + KEY_LENGTH)
	const expected = checksum(Buffer.from(versionAndKey))
	const actual = payload.subarray(1 + KEY_LENGTH)
	if (!expected.equals(actual)) {
		throw new Error('invalid invite: checksum mismatch (typo in the pasted code?)')
	}
	return Buffer.from(payload.subarray(1, 1 + KEY_LENGTH))
}

/**
 * Parse a configured bootstrap value into a 32-byte base key.
 *
 * - ''            -> null (this node founds a new base)
 * - 'nsw1…'       -> decodeInvite (throws on any corruption)
 * - 64 hex chars  -> raw base key (scripting escape hatch)
 * - anything else -> throw (fatal at startup, never silently re-found)
 */
export function parseBootstrap(value: string): Buffer | null {
	if (value === '') return null
	if (value.startsWith(PREFIX)) return decodeInvite(value)
	if (HEX64.test(value)) return Buffer.from(value.toLowerCase(), 'hex')
	throw new Error(
		`invalid bootstrap value: expected an '${PREFIX}…' invite or a 64-hex base key, got '${value}'`,
	)
}
