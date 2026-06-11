declare module 'z32' {
	const z32: {
		/** Encode a buffer (or utf8 string) as z-base32 */
		encode(buf: Buffer | Uint8Array | string): string
		/** Decode a z-base32 string; throws on characters outside the alphabet */
		decode(s: string, out?: Buffer): Buffer
		ALPHABET: string
	}
	export default z32
}
