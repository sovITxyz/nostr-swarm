import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { type WebSocket, WebSocketServer } from 'ws'
import { logger } from '../util/logger.js'
import type { PrimalShimConfig } from '../util/types.js'
import { JsonDmReadStore } from './dm-read.js'
import { ShimMessageHandler } from './handler.js'
import { JsonSeenStore } from './seen.js'
import { Session } from './session.js'
import { StatsService } from './stats.js'
import { RelayClient } from './upstream.js'
import { buildLiveVerbRegistry, buildVerbRegistry } from './verbs/index.js'

/**
 * WebSocket service impersonating Primal's caching service so the open-source
 * Primal web app can run against a nostr-swarm relay. Speaks the cache REQ
 * protocol on the client side and plain NIP-01 upstream.
 */
/** Ping clients this often; a socket that misses two intervals is terminated */
const HEARTBEAT_INTERVAL_MS = 30_000

export class PrimalShim {
	private readonly config: PrimalShimConfig
	private readonly relay: RelayClient
	private readonly handler: ShimMessageHandler
	private readonly sessions = new Set<Session>()
	/** Sockets that have not answered our ping since the last sweep */
	private readonly awaitingPong = new WeakSet<WebSocket>()
	private readonly httpServer: ReturnType<typeof createServer>
	private readonly wss: WebSocketServer
	private heartbeat: ReturnType<typeof setInterval> | null = null

	constructor(config: PrimalShimConfig) {
		this.config = config
		this.relay = new RelayClient(config.relayUrl, {
			sockets: config.upstreamSockets,
			queryTimeoutMs: config.queryTimeoutMs,
		})
		this.handler = new ShimMessageHandler(
			{
				relay: this.relay,
				stats: new StatsService(this.relay, {
					ttlMs: config.statsTtlMs,
					maxEntries: config.statsCacheSize,
				}),
				seen: new JsonSeenStore(config.dataDir),
				dmRead: new JsonDmReadStore(config.dataDir),
				config,
			},
			buildVerbRegistry(),
			buildLiveVerbRegistry(),
		)

		this.httpServer = createServer((req, res) => this.handleHttp(req, res))
		this.wss = new WebSocketServer({ server: this.httpServer })
		this.wss.on('connection', (ws) => this.handleConnection(ws))
	}

	async start(): Promise<void> {
		await this.relay.connect()
		logger.info('Connected to upstream relay', { url: this.config.relayUrl })
		// Reap dead (half-open) client sockets so their sessions, polling
		// intervals and relay-side sub slots don't leak indefinitely
		this.heartbeat = setInterval(() => this.sweepIdle(), HEARTBEAT_INTERVAL_MS)
		this.heartbeat.unref()
		return new Promise((resolve, reject) => {
			this.httpServer.once('error', reject)
			this.httpServer.listen(this.config.port, this.config.host, () => {
				this.httpServer.removeListener('error', reject)
				logger.info('Primal cache shim listening', {
					port: this.config.port,
					host: this.config.host,
				})
				resolve()
			})
		})
	}

	private sweepIdle(): void {
		for (const session of this.sessions) {
			const ws = session.socket
			if (this.awaitingPong.has(ws)) {
				// No pong since the last sweep — the socket is dead
				this.awaitingPong.delete(ws)
				ws.terminate()
				continue
			}
			this.awaitingPong.add(ws)
			try {
				ws.ping()
			} catch {
				// send failed; the close/error handler will clean up
			}
		}
	}

	async stop(): Promise<void> {
		if (this.heartbeat) {
			clearInterval(this.heartbeat)
			this.heartbeat = null
		}
		for (const session of this.sessions) {
			session.close()
			// Don't wait on a graceful close handshake for a possibly-dead client
			session.socket.terminate()
		}
		this.sessions.clear()
		this.wss.close()
		await this.relay.close()
		return new Promise((resolve) => {
			this.httpServer.close(() => resolve())
		})
	}

	get connectionCount(): number {
		return this.sessions.size
	}

	private handleHttp(req: IncomingMessage, res: ServerResponse): void {
		res.setHeader('Access-Control-Allow-Origin', '*')
		res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', 'Accept')
		if (req.method === 'OPTIONS') {
			res.writeHead(204)
			res.end()
			return
		}
		res.writeHead(200, { 'Content-Type': 'text/plain' })
		res.end('nostr-swarm primal-shim - Primal cache protocol adapter\n\nConnect via WebSocket.')
	}

	private handleConnection(ws: WebSocket): void {
		const session = new Session(ws)
		this.sessions.add(session)
		logger.info('Primal client connected', { sessionId: session.id })

		// Any pong or inbound frame proves the socket is alive this interval
		ws.on('pong', () => this.awaitingPong.delete(ws))

		ws.on('message', (data) => {
			this.awaitingPong.delete(ws)
			const raw = typeof data === 'string' ? data : data.toString()
			this.handler.handle(session, raw).catch((err) => {
				logger.error('Unhandled error in shim message handler', { error: String(err) })
			})
		})

		ws.on('close', () => {
			this.sessions.delete(session)
			session.close()
			logger.info('Primal client disconnected', { sessionId: session.id })
		})

		ws.on('error', (err) => {
			logger.error('Shim WebSocket error', { sessionId: session.id, error: String(err) })
			this.sessions.delete(session)
			session.close()
		})
	}
}
