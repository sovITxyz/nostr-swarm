/**
 * Minimal LRU cache with per-entry TTL. Map insertion order doubles as the
 * recency order: reads re-insert, eviction removes the oldest key first.
 */
export class LruCache<K, V> {
	private readonly entries = new Map<K, { value: V; expires: number }>()

	constructor(
		private readonly maxEntries: number,
		private readonly ttlMs: number,
	) {}

	get(key: K): V | undefined {
		const entry = this.entries.get(key)
		if (!entry) return undefined
		if (entry.expires <= Date.now()) {
			this.entries.delete(key)
			return undefined
		}
		this.entries.delete(key)
		this.entries.set(key, entry)
		return entry.value
	}

	set(key: K, value: V): void {
		this.entries.delete(key)
		this.entries.set(key, { value, expires: Date.now() + this.ttlMs })
		if (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next()
			if (!oldest.done) this.entries.delete(oldest.value)
		}
	}

	get size(): number {
		return this.entries.size
	}
}
