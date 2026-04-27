import { describe, expect, it } from 'vitest'
import { WotGraph } from '../../src/wot/graph.js'
import type { WotConfig } from '../../src/util/types.js'

// Regression: WotGraph.computeDegrees() entered an infinite loop whenever a
// queued pubkey had no kind 3 contact list (extremely common, including the
// owner on first boot), or when a node hit the maxDepth boundary. Both guard
// `continue;` statements re-entered the loop with the same `current` because
// the cursor was only advanced on the happy path.

const owner = 'a'.repeat(64)
const aPub = 'b'.repeat(64)
const bPub = 'c'.repeat(64)
const trustByDegree: Record<number, number> = { 0: 1, 1: 0.7, 2: 0.4, 3: 0.1 }

function newGraph(overrides: Partial<WotConfig> = {}): WotGraph {
	return new WotGraph({
		ownerPubkey: owner,
		maxDepth: 3,
		trustByDegree,
		refreshIntervalMs: 60_000,
		...overrides,
	} as WotConfig)
}

// Reach into the private `follows`/`degrees` maps for the regression — exposed
// only via this typed cast so tests can seed graph state without spinning up
// the storage indexes.
type GraphInternals = {
	follows: Map<string, Set<string>>
	degrees: Map<string, number>
	computeDegrees: () => void
}

describe('WotGraph.computeDegrees regression (sparse follows)', () => {
	it('returns when owner itself has no follows entry', { timeout: 1000 }, () => {
		const graph = newGraph() as unknown as GraphInternals
		const t0 = Date.now()
		graph.computeDegrees()
		expect(Date.now() - t0).toBeLessThan(100)
		expect(graph.degrees.get(owner)).toBe(0)
	})

	it('returns when a followed pubkey has no follows entry', { timeout: 1000 }, () => {
		const graph = newGraph() as unknown as GraphInternals
		graph.follows.set(owner, new Set([aPub]))
		const t0 = Date.now()
		graph.computeDegrees()
		expect(Date.now() - t0).toBeLessThan(100)
		expect(graph.degrees.get(owner)).toBe(0)
		expect(graph.degrees.get(aPub)).toBe(1)
	})

	it('returns when traversal hits the maxDepth boundary', { timeout: 1000 }, () => {
		const graph = newGraph({ maxDepth: 1 }) as unknown as GraphInternals
		graph.follows.set(owner, new Set([aPub]))
		graph.follows.set(aPub, new Set([bPub]))
		const t0 = Date.now()
		graph.computeDegrees()
		expect(Date.now() - t0).toBeLessThan(100)
		expect(graph.degrees.get(owner)).toBe(0)
		expect(graph.degrees.get(aPub)).toBe(1)
		expect(graph.degrees.has(bPub)).toBe(false)
	})
})
