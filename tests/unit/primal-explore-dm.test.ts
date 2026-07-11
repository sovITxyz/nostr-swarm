import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DM_ALL_SENDERS, JsonDmReadStore } from '../../src/primal-shim/dm-read.js'
import {
	PRIMAL_KIND,
	encodeCustomFeedRange,
	encodeDirectMsgCount,
	encodeFollowerIncrease,
	encodePerSenderStats,
	encodeTopicStats,
} from '../../src/primal-shim/synth.js'

const pk = (n: number) => n.toString(16).padStart(64, '0')

describe('explore/dm synth encoders', () => {
	it('custom feed range carries explicit order + elements', () => {
		const range = JSON.parse(
			encodeCustomFeedRange({ elements: [pk(1), pk(2)], since: 100, until: 300, orderBy: 'followers_increase' })
				.content,
		)
		expect(range).toEqual({
			since: 100,
			until: 300,
			order_by: 'followers_increase',
			elements: [pk(1), pk(2)],
		})
	})

	it('topic stats is a hashtag->count dict', () => {
		const e = encodeTopicStats({ nostr: 5, bitcoin: 3 })
		expect(e.kind).toBe(PRIMAL_KIND.topicStats)
		expect(JSON.parse(e.content)).toEqual({ nostr: 5, bitcoin: 3 })
	})

	it('follower-increase carries the ranking in `increase`', () => {
		const e = encodeFollowerIncrease({ [pk(1)]: { increase: 12, ratio: 0, count: 40 } })
		expect(e.kind).toBe(PRIMAL_KIND.followerIncrease)
		expect(JSON.parse(e.content)[pk(1)]).toEqual({ increase: 12, ratio: 0, count: 40 })
	})

	it('per-sender DM stats map', () => {
		const e = encodePerSenderStats({ [pk(2)]: { cnt: 3, latest_at: 111, latest_event_id: pk(9) } })
		expect(e.kind).toBe(PRIMAL_KIND.perSenderStats)
		expect(JSON.parse(e.content)[pk(2)]).toEqual({ cnt: 3, latest_at: 111, latest_event_id: pk(9) })
	})

	it('directmsg count is a bare top-level {kind, cnt-as-string}', () => {
		const e = encodeDirectMsgCount(7)
		expect(e).toEqual({ kind: PRIMAL_KIND.directMsgCount, cnt: '7' })
		// Must NOT be a full event (no content/id/sig)
		expect(Object.keys(e)).not.toContain('content')
	})
})

describe('JsonDmReadStore watermarks', () => {
	function store() {
		return new JsonDmReadStore(mkdtempSync(join(tmpdir(), 'shim-dm-')))
	}

	it('starts at 0 and advances per sender', async () => {
		const s = store()
		expect(s.get(pk(1), pk(2))).toBe(0)
		await s.set(pk(1), pk(2), 1000)
		expect(s.get(pk(1), pk(2))).toBe(1000)
		// Never moves backward
		await s.set(pk(1), pk(2), 500)
		expect(s.get(pk(1), pk(2))).toBe(1000)
	})

	it('mark-all raises the floor for every sender', async () => {
		const s = store()
		await s.set(pk(1), pk(2), 100)
		await s.set(pk(1), DM_ALL_SENDERS, 5000)
		// The per-sender read is max(perSender, all)
		expect(s.get(pk(1), pk(2))).toBe(5000)
		expect(s.get(pk(1), pk(3))).toBe(5000)
	})

	it('is isolated per user', async () => {
		const s = store()
		await s.set(pk(1), pk(2), 1000)
		expect(s.get(pk(9), pk(2))).toBe(0)
	})

	it('persists across reloads of the same dir', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'shim-dm-'))
		const a = new JsonDmReadStore(dir)
		await a.set(pk(1), pk(2), 4242)
		const b = new JsonDmReadStore(dir)
		expect(b.get(pk(1), pk(2))).toBe(4242)
	})
})
