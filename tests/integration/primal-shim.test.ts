import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { PrimalShim } from '../../src/primal-shim/server.js'
import { PRIMAL_KIND, SETTINGS_APP } from '../../src/primal-shim/synth.js'
import type { NostrSwarm } from '../../src/relay.js'
import type { NostrEvent } from '../../src/util/types.js'
import {
	connectClient,
	createRelay,
	createSignedEvent,
	destroyTestnet,
	sendAndCollect,
	tempStorage,
} from '../helpers.js'

/** Rate limits high enough that the shim's fan-out never trips them */
const FAST_LIMITS = { eventRatePerSec: 1000, reqRatePerSec: 1000 }

let relay: NostrSwarm
let shim: PrimalShim
let shimPort: number
let client: WebSocket
let subCounter = 0

// Test identities
const alice = { sk: undefined as Uint8Array | undefined, pubkey: '' }
const bob = { sk: undefined as Uint8Array | undefined, pubkey: '' }
let aliceNote: NostrEvent
let aliceUnicornNote: NostrEvent
let bobReply: NostrEvent

/** Send one cache REQ and collect this subId's frames through its EOSE */
function cacheReq(verb: string, payload?: unknown): Promise<unknown[][]> {
	const subId = `t_${subCounter++}`
	const filter = { cache: payload === undefined ? [verb] : [verb, payload] }
	return new Promise((resolve, reject) => {
		const frames: unknown[][] = []
		const timer = setTimeout(() => {
			client.removeListener('message', onMsg)
			reject(new Error(`timeout waiting for EOSE on ${verb}`))
		}, 10_000)
		function onMsg(data: WebSocket.Data) {
			const msg = JSON.parse(data.toString()) as unknown[]
			// The shim multiplexes many subs on one socket — only collect ours
			if (msg[1] !== subId) return
			frames.push(msg)
			if (msg[0] === 'EOSE') {
				clearTimeout(timer)
				client.removeListener('message', onMsg)
				resolve(frames)
			}
		}
		client.on('message', onMsg)
		client.send(JSON.stringify(['REQ', subId, filter]))
	})
}

function eventsOf(frames: unknown[][], kind?: number): NostrEvent[] {
	return frames
		.filter((f) => f[0] === 'EVENT')
		.map((f) => f[2] as NostrEvent)
		.filter((e) => kind === undefined || e.kind === kind)
}

async function publishToRelay(ws: WebSocket, event: NostrEvent): Promise<void> {
	const frames = await sendAndCollect(ws, ['EVENT', event], 'OK')
	const ok = frames.find((f) => f[0] === 'OK')
	expect(ok?.[2], `relay should accept event: ${ok?.[3]}`).toBe(true)
}

function connectShim(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`)
		ws.on('error', reject)
		ws.on('open', () => resolve(ws))
	})
}

beforeAll(async () => {
	relay = await createRelay({ relay: FAST_LIMITS })

	// Seed: alice posts two notes, bob replies to and likes the first
	const now = Math.floor(Date.now() / 1000)
	const a = createSignedEvent({ kind: 0, content: '{"name":"alice"}', created_at: now - 500 })
	alice.sk = a.sk
	alice.pubkey = a.pubkey
	const note1 = createSignedEvent({
		sk: alice.sk,
		content: 'first post on the swarm',
		created_at: now - 400,
	})
	aliceNote = note1.event
	const note2 = createSignedEvent({
		sk: alice.sk,
		content: 'a note about a unicorn',
		created_at: now - 300,
	})
	aliceUnicornNote = note2.event

	const b = createSignedEvent({ kind: 0, content: '{"name":"bob"}', created_at: now - 500 })
	bob.sk = b.sk
	bob.pubkey = b.pubkey
	const reply = createSignedEvent({
		sk: bob.sk,
		content: 'welcome alice',
		tags: [
			['e', aliceNote.id, '', 'root'],
			['p', alice.pubkey],
		],
		created_at: now - 200,
	})
	bobReply = reply.event
	const reaction = createSignedEvent({
		sk: bob.sk,
		kind: 7,
		content: '+',
		tags: [
			['e', aliceNote.id],
			['p', alice.pubkey],
		],
		created_at: now - 100,
	})

	const seedClient = await connectClient(relay.config.port)
	for (const event of [a.event, aliceNote, aliceUnicornNote, b.event, bobReply, reaction.event]) {
		await publishToRelay(seedClient, event)
	}
	seedClient.close()

	shimPort = 10000 + Math.floor(Math.random() * 50000)
	shim = new PrimalShim({
		port: shimPort,
		host: '127.0.0.1',
		relayUrl: `ws://127.0.0.1:${relay.config.port}`,
		publicRelayUrl: `ws://127.0.0.1:${relay.config.port}`,
		dataDir: tempStorage(),
		upstreamSockets: 2,
		statsTtlMs: 50, // near-zero so seeded interactions are always re-counted
		statsCacheSize: 1000,
		maxMessageSize: 131072,
		queryTimeoutMs: 10_000,
	})
	await shim.start()
	client = await connectShim(shimPort)
}, 60_000)

afterAll(async () => {
	client?.close()
	await shim?.stop()
	await relay?.stop()
	await destroyTestnet()
})

describe('primal-shim integration', () => {
	it('acks the set_primal_protocol handshake with bare EOSE', async () => {
		const frames = await cacheReq('set_primal_protocol', { compression: 'zlib' })
		expect(frames).toEqual([['EOSE', expect.any(String)]])
	})

	it('answers unknown verbs with bare EOSE and stays healthy', async () => {
		const frames = await cacheReq('membership_legends_leaderboard', { limit: 10 })
		expect(frames.filter((f) => f[0] === 'EVENT')).toHaveLength(0)
		const again = await cacheReq('set_primal_protocol', { compression: 'zlib' })
		expect(again.at(-1)?.[0]).toBe('EOSE')
	})

	it('serves the all-notes feed with profiles, stats and a RANGE', async () => {
		const frames = await cacheReq('multi_kind_mega_feed_directive', {
			spec: '{"id":"all-notes","kind":"notes"}',
			limit: 20,
			offset: 0,
			kinds: [1, 6, 1068, 6969],
		})
		const notes = eventsOf(frames, 1)
		const noteIds = notes.map((n) => n.id)
		expect(noteIds).toContain(aliceNote.id)
		expect(noteIds).toContain(aliceUnicornNote.id)
		expect(noteIds).toContain(bobReply.id)

		const profiles = eventsOf(frames, 0)
		expect(profiles.map((p) => p.pubkey)).toEqual(
			expect.arrayContaining([alice.pubkey, bob.pubkey]),
		)

		const stats = eventsOf(frames, PRIMAL_KIND.eventStats).map(
			(e) => JSON.parse(e.content) as { event_id: string; likes: number; replies: number },
		)
		const note1Stats = stats.find((s) => s.event_id === aliceNote.id)
		expect(note1Stats).toMatchObject({ likes: 1, replies: 1 })

		const ranges = eventsOf(frames, PRIMAL_KIND.feedRange)
		expect(ranges).toHaveLength(1)
		const range = JSON.parse(ranges[0]?.content ?? '{}')
		expect(range.order_by).toBe('created_at')
		expect(range.elements).toEqual(noteIds)
		// Feed order: newest first
		expect(noteIds[0]).toBe(bobReply.id)
	})

	it('serves the following feed from the kind-3 contact list', async () => {
		const contacts = createSignedEvent({
			sk: bob.sk,
			kind: 3,
			content: '',
			tags: [['p', alice.pubkey]],
		})
		const ws = await connectClient(relay.config.port)
		await publishToRelay(ws, contacts.event)
		ws.close()

		const frames = await cacheReq('multi_kind_mega_feed_directive', {
			spec: '{"id":"latest","kind":"notes"}',
			limit: 20,
			offset: 0,
			kinds: [1, 6],
			user_pubkey: bob.pubkey,
		})
		const noteIds = eventsOf(frames, 1).map((n) => n.id)
		expect(noteIds).toContain(aliceNote.id)
		// Bob follows only alice — bob's own reply must not appear
		expect(noteIds).not.toContain(bobReply.id)
	})

	it('serves a thread with parent chain and replies', async () => {
		const frames = await cacheReq('multi_kind_thread_view', {
			event_id: aliceNote.id,
			limit: 100,
			kinds: [1, 6, 1068, 6969],
			user_pubkey: bob.pubkey,
		})
		const noteIds = eventsOf(frames, 1).map((n) => n.id)
		expect(noteIds).toContain(aliceNote.id)
		expect(noteIds).toContain(bobReply.id)
		// Bob replied to this note: his note-actions flag must say so
		const actions = eventsOf(frames, PRIMAL_KIND.noteActions).map(
			(e) => JSON.parse(e.content) as { event_id: string; replied: boolean },
		)
		expect(actions.find((a) => a.event_id === aliceNote.id)?.replied).toBe(true)
	})

	it('resolves user_profile with counted stats', async () => {
		const frames = await cacheReq('user_profile', { pubkey: alice.pubkey })
		const profile = eventsOf(frames, 0)[0]
		expect(profile?.pubkey).toBe(alice.pubkey)
		const stats = eventsOf(frames, PRIMAL_KIND.userStats).map(
			(e) => JSON.parse(e.content) as { note_count: number; followers_count: number },
		)
		expect(stats[0]?.note_count).toBeGreaterThanOrEqual(2)
		expect(stats[0]?.followers_count).toBeGreaterThanOrEqual(1)
	})

	it('searches note content through NIP-50', async () => {
		const frames = await cacheReq('search', { query: 'unicorn', limit: 20 })
		const noteIds = eventsOf(frames, 1).map((n) => n.id)
		expect(noteIds).toEqual([aliceUnicornNote.id])
		expect(eventsOf(frames, PRIMAL_KIND.feedRange)).toHaveLength(1)
	})

	it('finds profiles via user_search', async () => {
		const frames = await cacheReq('user_search', { query: 'alice', limit: 10 })
		const profiles = eventsOf(frames, 0)
		expect(profiles.map((p) => p.pubkey)).toContain(alice.pubkey)
	})

	it('broadcast_events publishes to the relay and acks before EOSE', async () => {
		const carol = createSignedEvent({ content: 'published through the shim proxy' })
		const frames = await cacheReq('broadcast_events', {
			events: [carol.event],
			relays: [`ws://127.0.0.1:${relay.config.port}`],
		})
		// Client contract: at least one EVENT before EOSE signals success
		const acks = eventsOf(frames, PRIMAL_KIND.broadcastResponse)
		expect(acks).toHaveLength(1)

		// The event must now be queryable from the relay over plain NIP-01
		const ws = await connectClient(relay.config.port)
		const result = await sendAndCollect(
			ws,
			['REQ', `verify-${subCounter++}`, { ids: [carol.event.id] }],
			'EOSE',
		)
		ws.close()
		expect(eventsOf(result).map((e) => e.id)).toContain(carol.event.id)
	})

	it('rejects broadcast_events carrying an invalid signature', async () => {
		const forged = { ...createSignedEvent({ content: 'evil' }).event, content: 'tampered' }
		const frames = await cacheReq('broadcast_events', { events: [forged] })
		expect(frames.some((f) => f[0] === 'NOTICE')).toBe(true)
		expect(eventsOf(frames)).toHaveLength(0)
	})

	it('roundtrips app settings through the relay as kind 30078', async () => {
		const settings = JSON.stringify({ theme: 'midnight', description: 'Sync app settings' })
		const settingsEvent = createSignedEvent({
			sk: alice.sk,
			kind: 30078,
			content: settings,
			tags: [['d', SETTINGS_APP]],
		})
		const setFrames = await cacheReq('set_app_settings', { settings_event: settingsEvent.event })
		expect(setFrames.some((f) => f[0] === 'NOTICE')).toBe(false)

		const requestEvent = createSignedEvent({
			sk: alice.sk,
			kind: 30078,
			content: '{ "description": "Sync app settings" }',
			tags: [['d', SETTINGS_APP]],
		})
		const getFrames = await cacheReq('get_app_settings', { event_from_user: requestEvent.event })
		const stored = eventsOf(getFrames, 30078)
		expect(stored.some((e) => e.content === settings)).toBe(true)
	})

	it('serves defaults for users with no stored settings', async () => {
		const stranger = createSignedEvent({ kind: 30078, content: '{}' })
		const frames = await cacheReq('get_app_settings', { event_from_user: stranger.event })
		const settings = eventsOf(frames, 30078)
		expect(settings).toHaveLength(1)
		const parsed = JSON.parse(settings[0]?.content ?? '{}')
		expect(parsed.notifications).toBeDefined()
		expect(parsed.zapDefault).toBeDefined()
	})

	it('synthesizes notifications for replies and likes, gated by seen-state', async () => {
		const frames = await cacheReq('get_notifications', { pubkey: alice.pubkey, limit: 100 })
		const notifications = eventsOf(frames, PRIMAL_KIND.notification).map(
			(e) => JSON.parse(e.content) as { type: number; your_post?: string },
		)
		const types = notifications.map((n) => n.type)
		expect(types).toContain(4) // YOUR_POST_WAS_LIKED
		expect(types).toContain(6) // YOUR_POST_WAS_REPLIED_TO
		expect(notifications.every((n) => n.your_post === aliceNote.id)).toBe(true)
		// Bob's profile rides along for the notification rows
		expect(eventsOf(frames, 0).map((p) => p.pubkey)).toContain(bob.pubkey)

		// Mark seen "now": the seen timestamp round-trips
		const seenEvent = createSignedEvent({ sk: alice.sk, kind: 30078, content: '{}' })
		await cacheReq('set_notifications_seen', { event_from_user: seenEvent.event })
		const seenFrames = await cacheReq('get_notifications_seen', { pubkey: alice.pubkey })
		const seen = eventsOf(seenFrames, PRIMAL_KIND.seenUntil)
		expect(Number.parseInt(seen[0]?.content ?? '0', 10)).toBe(seenEvent.event.created_at)
	})

	it('serves boot documents: default relays, home feeds, releases', async () => {
		const relays = await cacheReq('get_default_relays')
		const relayDoc = eventsOf(relays, PRIMAL_KIND.defaultRelays)[0]
		expect(JSON.parse(relayDoc?.content ?? '[]')).toEqual([
			`ws://127.0.0.1:${relay.config.port}`,
		])

		const feeds = await cacheReq('get_home_feeds')
		const feedDoc = eventsOf(feeds, PRIMAL_KIND.homeFeeds)[0]
		const parsed = JSON.parse(feedDoc?.content ?? '[]') as Array<{ spec: string }>
		expect(parsed.length).toBeGreaterThanOrEqual(2)

		const releases = await cacheReq('get_app_releases')
		expect(eventsOf(releases)).toHaveLength(1)
	})

	it('supports concurrent REQs on one socket without crosstalk', async () => {
		const [feed, profile, searchRes] = await Promise.all([
			cacheReq('multi_kind_mega_feed_directive', {
				spec: '{"id":"all-notes","kind":"notes"}',
				limit: 5,
				offset: 0,
				kinds: [1, 6],
			}),
			cacheReq('user_profile', { pubkey: bob.pubkey }),
			cacheReq('search', { query: 'unicorn', limit: 5 }),
		])
		// Every response carries its own subId consistently
		for (const frames of [feed, profile, searchRes]) {
			const subIds = new Set(frames.map((f) => f[1]))
			expect(subIds.size).toBe(1)
		}
	})

	it('import_events ingests direct-published events idempotently', async () => {
		const note = createSignedEvent({ sk: alice.sk, content: `imported ${randomBytes(4).toString('hex')}` })
		const first = await cacheReq('import_events', { events: [note.event] })
		const ack = eventsOf(first, PRIMAL_KIND.importResponse)[0]
		expect(JSON.parse(ack?.content ?? '{}')).toEqual({ imported: 1, errors: 0 })
		// Replay: duplicate OKs still count as success
		const second = await cacheReq('import_events', { events: [note.event] })
		const ack2 = eventsOf(second, PRIMAL_KIND.importResponse)[0]
		expect(JSON.parse(ack2?.content ?? '{}')).toEqual({ imported: 1, errors: 0 })
	})
})
