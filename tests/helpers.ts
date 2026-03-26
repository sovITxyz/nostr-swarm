import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { NostrSwarm } from '../src/relay.js'
import type { NostrEvent } from '../src/util/types.js'
import WebSocket from 'ws'

/** Generate a valid signed Nostr event */
export function createSignedEvent(overrides: {
	kind?: number
	content?: string
	tags?: string[][]
	created_at?: number
	sk?: Uint8Array
} = {}): { event: NostrEvent; sk: Uint8Array; pubkey: string } {
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

/** Create and start a NostrSwarm instance on a random port */
export async function createRelay(overrides?: Record<string, unknown>): Promise<NostrSwarm> {
	const port = 10000 + Math.floor(Math.random() * 50000)
	const relay = new NostrSwarm({
		port,
		host: '127.0.0.1',
		storagePath: tempStorage(),
		topic: `test-${randomBytes(8).toString('hex')}`,
		...overrides,
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
