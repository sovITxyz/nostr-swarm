import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import WebSocket from 'ws'
import { NostrSwarm } from '../src/relay.js'
import type { LightClientConfig, NostrEvent, RelayConfig, WotConfig } from '../src/util/types.js'

// Env vars beat constructor overrides in loadConfig, so a polluted shell would
// silently break test isolation. Scrub everything the tests control explicitly.
for (const name of ['SWARM_TOPIC', 'WS_PORT', 'STORAGE_PATH', 'BOOTSTRAP_KEY', 'ADMIT_WRITERS']) {
	delete process.env[name]
}

type Testnet = Awaited<ReturnType<typeof createTestnet>>

let testnetPromise: Promise<Testnet> | null = null

/**
 * Suite-singleton local hyperdht testnet (3 nodes on loopback UDP).
 * Tests must NEVER touch the public DHT. Call destroyTestnet() in afterAll —
 * the nodes bind real sockets and vitest leaks handles otherwise.
 */
export function getTestnet(): Promise<Testnet> {
	if (!testnetPromise) {
		testnetPromise = createTestnet(3)
	}
	return testnetPromise
}

/** Destroy the suite's testnet (afterAll, after every relay has stopped) */
export async function destroyTestnet(): Promise<void> {
	if (!testnetPromise) return
	const tn = await testnetPromise
	testnetPromise = null
	await tn.destroy()
}

/** Poll a predicate until it returns true or the timeout elapses */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	opts: { timeout?: number; interval?: number } = {},
): Promise<void> {
	const timeout = opts.timeout ?? 10_000
	const interval = opts.interval ?? 50
	const deadline = Date.now() + timeout
	for (;;) {
		if (await predicate()) return
		if (Date.now() >= deadline) {
			throw new Error(`waitFor: condition not met within ${timeout}ms`)
		}
		await new Promise((resolve) => setTimeout(resolve, interval))
	}
}

/** Generate a valid signed Nostr event */
export function createSignedEvent(
	overrides: {
		kind?: number
		content?: string
		tags?: string[][]
		created_at?: number
		sk?: Uint8Array
	} = {},
): { event: NostrEvent; sk: Uint8Array; pubkey: string } {
	const sk = overrides.sk ?? generateSecretKey()
	const pubkey = getPublicKey(sk)

	const template = {
		kind: overrides.kind ?? 1,
		content: overrides.content ?? 'hello nostr',
		tags: overrides.tags ?? [],
		created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
	}

	const event = finalizeEvent(template, sk) as unknown as NostrEvent
	return { event, sk, pubkey }
}

/** Create a temporary storage directory */
export function tempStorage(): string {
	return mkdtempSync(join(tmpdir(), 'nostr-swarm-test-'))
}

/**
 * Create and start a NostrSwarm instance on a random port with isolated storage and topic.
 * Always wired to the local testnet via the bootstrap-array form — never share a
 * Testnet node via opts.dht (Hyperswarm.destroy() force-destroys injected DHTs).
 */
export async function createRelay(overrides?: {
	relay?: Partial<RelayConfig>
	wot?: Partial<WotConfig>
	light?: Partial<LightClientConfig>
}): Promise<NostrSwarm> {
	const tn = await getTestnet()
	const port = 10000 + Math.floor(Math.random() * 50000)
	const relay = new NostrSwarm({
		...overrides,
		relay: {
			port,
			host: '127.0.0.1',
			storagePath: tempStorage(),
			topic: `test-${randomBytes(8).toString('hex')}`,
			...overrides?.relay,
		},
		network: { dhtBootstrap: tn.bootstrap },
	})
	await relay.start()
	return relay
}

/** Connect a WebSocket client to a relay and drain the initial AUTH challenge */
export function connectClient(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`)
		ws.on('error', reject)
		// Listen for the first message (AUTH challenge) before resolving
		ws.on('message', function onFirstMsg() {
			ws.removeListener('message', onFirstMsg)
			resolve(ws)
		})
	})
}

/** Send a message and collect responses until a specific message type is received */
export function sendAndCollect(
	ws: WebSocket,
	msg: unknown[],
	until: string,
	timeout = 5000,
): Promise<unknown[][]> {
	return new Promise((resolve, reject) => {
		const results: unknown[][] = []
		const timer = setTimeout(() => {
			ws.removeListener('message', onMsg)
			reject(new Error(`Timeout waiting for ${until}`))
		}, timeout)

		function onMsg(data: WebSocket.Data) {
			const parsed = JSON.parse(data.toString())
			results.push(parsed)
			if (parsed[0] === until) {
				clearTimeout(timer)
				ws.removeListener('message', onMsg)
				resolve(results)
			}
		}

		ws.on('message', onMsg)
		ws.send(JSON.stringify(msg))
	})
}

/** Wait for the next message from a WebSocket */
export function waitForMessage(ws: WebSocket, timeout = 5000): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.removeListener('message', onMsg)
			reject(new Error('Timeout waiting for message'))
		}, timeout)

		function onMsg(data: WebSocket.Data) {
			clearTimeout(timer)
			ws.removeListener('message', onMsg)
			resolve(JSON.parse(data.toString()))
		}

		ws.on('message', onMsg)
	})
}

/** Drain the AUTH challenge that comes on connect */
export async function drainAuth(ws: WebSocket): Promise<unknown[]> {
	return waitForMessage(ws, 2000)
}
