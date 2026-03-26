import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { EventStore } from '../storage/store.js'
import { logger } from '../util/logger.js'
import type { RelayConfig, RelayInfo } from '../util/types.js'
import { Connection } from './connection.js'
import { MessageHandler } from './handler.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function getVersion(): string {
	try {
		const __dirname = dirname(fileURLToPath(import.meta.url))
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'))
		return pkg.version ?? '0.0.0'
	} catch {
		return '0.0.0'
	}
}

export class RelayServer {
	private readonly config: RelayConfig
	private readonly store: EventStore
	private readonly connections = new Set<Connection>()
	private readonly handler: MessageHandler
	private readonly httpServer: ReturnType<typeof createServer>
	private readonly wss: WebSocketServer

	constructor(store: EventStore, config: RelayConfig) {
		this.config = config
		this.store = store
		this.handler = new MessageHandler(store, config, this.connections)

		this.httpServer = createServer((req, res) => this.handleHttp(req, res))
		this.wss = new WebSocketServer({ server: this.httpServer })
		this.wss.on('connection', (ws) => this.handleConnection(ws))
	}

	async start(): Promise<void> {
		return new Promise((resolve) => {
			this.httpServer.listen(this.config.port, this.config.host, () => {
				logger.info('Relay server listening', {
					port: this.config.port,
					host: this.config.host,
				})
				resolve()
			})
		})
	}

	async stop(): Promise<void> {
		// Close all connections
		for (const conn of this.connections) {
			conn.close()
		}
		this.connections.clear()

		// Close servers
		this.wss.close()
		return new Promise((resolve) => {
			this.httpServer.close(() => resolve())
		})
	}

	get connectionCount(): number {
		return this.connections.size
	}

	/** NIP-11: respond with relay information document on HTTP GET */
	private handleHttp(req: IncomingMessage, res: ServerResponse): void {
		// CORS headers for NIP-11
		res.setHeader('Access-Control-Allow-Origin', '*')
		res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', 'Accept')

		if (req.method === 'OPTIONS') {
			res.writeHead(204)
			res.end()
			return
		}

		const accept = req.headers.accept ?? ''
		if (req.method === 'GET' && accept.includes('application/nostr+json')) {
			const info: RelayInfo = {
				name: this.config.relayName,
				description: this.config.relayDescription,
				pubkey: this.config.relayPubkey,
				contact: this.config.relayContact,
				supported_nips: [1, 9, 11, 40, 42, 45, 70],
				software: 'nostr-swarm',
				version: getVersion(),
				limitation: {
					max_message_length: this.config.maxMessageSize,
					max_subscriptions: this.config.maxSubscriptionsPerConn,
					max_filters: this.config.maxFiltersPerReq,
					auth_required: false,
					payment_required: false,
				},
			}
			res.writeHead(200, { 'Content-Type': 'application/nostr+json' })
			res.end(JSON.stringify(info))
			return
		}

		// Default: simple info page
		res.writeHead(200, { 'Content-Type': 'text/plain' })
		res.end(`${this.config.relayName} - nostr-swarm relay\n\nConnect via WebSocket.`)
	}

	private handleConnection(ws: WebSocket): void {
		const conn = new Connection(ws, this.config)
		this.connections.add(conn)

		logger.info('Client connected', { connId: conn.id })

		// Send AUTH challenge (NIP-42)
		conn.sendAuth()

		ws.on('message', (data) => {
			const raw = typeof data === 'string' ? data : data.toString()
			this.handler.handle(conn, raw).catch((err) => {
				logger.error('Unhandled error in message handler', { error: String(err) })
			})
		})

		ws.on('close', () => {
			this.connections.delete(conn)
			conn.subscriptions.clear()
			logger.info('Client disconnected', { connId: conn.id })
		})

		ws.on('error', (err) => {
			logger.error('WebSocket error', { connId: conn.id, error: String(err) })
			this.connections.delete(conn)
		})
	}
}
