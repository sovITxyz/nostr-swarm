import { EventEmitter } from 'node:events'
import type { IndexSubs } from '../storage/indexes.js'
import { eventKey } from '../util/keys.js'
import { logger } from '../util/logger.js'
import type { NostrEvent, TrustScore, WotConfig } from '../util/types.js'

/**
 * Builds and maintains a Web of Trust graph from kind 3 (contact list)
 * and kind 10000 (mute list) events stored in the Autobase view.
 *
 * The graph is rooted at the owner's pubkey and uses BFS to compute
 * degrees of separation. Trust scores decay with distance.
 */
export class WotGraph extends EventEmitter {
	private readonly config: WotConfig
	/** pubkey → set of followed pubkeys */
	private follows = new Map<string, Set<string>>()
	/** pubkey → set of muted pubkeys */
	private mutes = new Map<string, Set<string>>()
	/** pubkey → degree of separation from owner */
	private degrees = new Map<string, number>()
	/** Precomputed trust scores */
	private scores = new Map<string, TrustScore>()
	private refreshTimer: ReturnType<typeof setInterval> | null = null

	constructor(config: WotConfig) {
		super()
		this.config = config
	}

	/** Build the graph from the current index state */
	async rebuild(indexes: IndexSubs): Promise<void> {
		const startTime = Date.now()
		this.follows.clear()
		this.mutes.clear()

		// Scan kind 3 (contact lists) — these are replaceable, so only the latest per pubkey exists
		await this.scanContactLists(indexes)

		// Scan kind 10000 (mute lists) — also replaceable
		await this.scanMuteLists(indexes)

		// BFS from owner to compute degrees
		this.computeDegrees()

		// Compute trust scores
		this.computeScores()

		const elapsed = Date.now() - startTime
		logger.info('WoT graph rebuilt', {
			follows: this.follows.size,
			mutes: this.mutes.size,
			trusted: this.scores.size,
			elapsed: `${elapsed}ms`,
		})

		this.emit('rebuilt')
	}

	/** Start periodic refresh of the trust graph */
	startRefresh(indexes: IndexSubs): void {
		if (this.refreshTimer) return
		this.refreshTimer = setInterval(
			() =>
				this.rebuild(indexes).catch((err) =>
					logger.error('WoT refresh failed', { error: String(err) }),
				),
			this.config.refreshIntervalMs,
		)
	}

	/** Stop periodic refresh */
	stopRefresh(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer)
			this.refreshTimer = null
		}
	}

	/** Get the trust score for a pubkey */
	getScore(pubkey: string): TrustScore {
		const cached = this.scores.get(pubkey)
		if (cached) return cached

		// Unknown pubkey — not in trust graph
		return {
			pubkey,
			degree: -1,
			score: 0,
			muted: this.isExplicitlyMuted(pubkey),
		}
	}

	/** Check if a pubkey is within the trusted set */
	isTrusted(pubkey: string): boolean {
		const score = this.getScore(pubkey)
		return score.score > 0 && !score.muted
	}

	/** Get the degree of separation for a pubkey (-1 if not in graph) */
	getDegree(pubkey: string): number {
		return this.degrees.get(pubkey) ?? -1
	}

	/** Check if a pubkey is explicitly muted by the owner or anyone in the trust graph */
	isExplicitlyMuted(pubkey: string): boolean {
		// Check if the owner mutes this pubkey
		const ownerMutes = this.mutes.get(this.config.ownerPubkey)
		if (ownerMutes?.has(pubkey)) return true

		// Check 1st degree follows' mute lists (consensus muting)
		const ownerFollows = this.follows.get(this.config.ownerPubkey)
		if (!ownerFollows) return false

		let muteCount = 0
		const threshold = Math.max(1, Math.floor(ownerFollows.size * 0.5))
		for (const follower of ownerFollows) {
			if (this.mutes.get(follower)?.has(pubkey)) {
				muteCount++
				if (muteCount >= threshold) return true
			}
		}

		return false
	}

	/** Get all trusted pubkeys as a set */
	getTrustedPubkeys(): Set<string> {
		const trusted = new Set<string>()
		for (const [pubkey, score] of this.scores) {
			if (score.score > 0 && !score.muted) {
				trusted.add(pubkey)
			}
		}
		return trusted
	}

	/** Get stats about the current graph */
	getStats(): { total: number; byDegree: Record<number, number>; muted: number } {
		const byDegree: Record<number, number> = {}
		let muted = 0

		for (const [, score] of this.scores) {
			if (score.muted) {
				muted++
			} else {
				byDegree[score.degree] = (byDegree[score.degree] ?? 0) + 1
			}
		}

		return { total: this.scores.size, byDegree, muted }
	}

	// ─── Internal ───────────────────────────────────────────────────

	private async scanContactLists(indexes: IndexSubs): Promise<void> {
		// Kind 3 is replaceable — scan the author_kind index for kind 3
		// This gives us the latest contact list for each pubkey
		const stream = indexes.authorKind.createReadStream({
			gte: '',
			lt: '~',
		})

		const seenAuthors = new Set<string>()

		for await (const entry of stream) {
			const eventId = entry.value as string
			const eventEntry = await indexes.events.get(eventKey(eventId))
			if (!eventEntry) continue

			const event = eventEntry.value as NostrEvent
			if (event.kind !== 3) continue

			// Only take the first (newest) contact list per author
			if (seenAuthors.has(event.pubkey)) continue
			seenAuthors.add(event.pubkey)

			const following = new Set<string>()
			for (const tag of event.tags) {
				if (tag[0] === 'p' && tag[1]) {
					following.add(tag[1])
				}
			}
			if (following.size > 0) {
				this.follows.set(event.pubkey, following)
			}
		}
	}

	private async scanMuteLists(indexes: IndexSubs): Promise<void> {
		// Kind 10000 is replaceable — scan similarly
		const stream = indexes.authorKind.createReadStream({
			gte: '',
			lt: '~',
		})

		const seenAuthors = new Set<string>()

		for await (const entry of stream) {
			const eventId = entry.value as string
			const eventEntry = await indexes.events.get(eventKey(eventId))
			if (!eventEntry) continue

			const event = eventEntry.value as NostrEvent
			if (event.kind !== 10000) continue

			if (seenAuthors.has(event.pubkey)) continue
			seenAuthors.add(event.pubkey)

			const muted = new Set<string>()
			for (const tag of event.tags) {
				if (tag[0] === 'p' && tag[1]) {
					muted.add(tag[1])
				}
			}
			if (muted.size > 0) {
				this.mutes.set(event.pubkey, muted)
			}
		}
	}

	/** BFS from owner pubkey to compute degrees of separation */
	private computeDegrees(): void {
		this.degrees.clear()
		const owner = this.config.ownerPubkey
		if (!owner) return

		const queue: Array<{ pubkey: string; depth: number }> = [{ pubkey: owner, depth: 0 }]
		this.degrees.set(owner, 0)

		let current = queue.shift()
		while (current) {
			if (current.depth >= this.config.maxDepth) {
				current = queue.shift()
				continue
			}

			const follows = this.follows.get(current.pubkey)
			if (!follows) {
				current = queue.shift()
				continue
			}

			for (const followed of follows) {
				if (this.degrees.has(followed)) continue // already visited at a shorter path
				this.degrees.set(followed, current.depth + 1)
				queue.push({ pubkey: followed, depth: current.depth + 1 })
			}

			current = queue.shift()
		}
	}

	/** Compute trust scores from degrees */
	private computeScores(): void {
		this.scores.clear()

		for (const [pubkey, degree] of this.degrees) {
			const muted = this.isExplicitlyMuted(pubkey)
			const score = muted ? 0 : (this.config.trustByDegree[degree] ?? 0)

			this.scores.set(pubkey, {
				pubkey,
				degree,
				score,
				muted,
			})
		}
	}
}
