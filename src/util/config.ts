import type { LightClientConfig, PrimalShimConfig, RelayConfig, WotConfig } from './types.js'

const defaults: RelayConfig = {
	port: 3000,
	host: '0.0.0.0',
	storagePath: './nostr-swarm-data',
	topic: 'nostr',
	bootstrap: '',
	admitWriters: [],
	requestWriter: false,
	autoAdmit: false,
	acceptOptimistic: false,
	relayName: 'nostr-swarm',
	relayDescription: 'A peer-to-peer Nostr relay over Hyperswarm',
	relayContact: '',
	relayPubkey: '',
	maxMessageSize: 131072, // 128 KB
	maxSubscriptionsPerConn: 20,
	maxFiltersPerReq: 10,
	eventRatePerSec: 10,
	reqRatePerSec: 20,
	expirationCleanupIntervalMs: 60_000,
}

const wotDefaults: WotConfig = {
	ownerPubkey: '',
	maxDepth: 3,
	trustByDegree: { 0: 1.0, 1: 0.8, 2: 0.4, 3: 0.1 },
	ttlByDegree: { 0: 0, 1: 0, 2: 604800, 3: 86400 }, // 0=forever, 7 days, 1 day
	refreshIntervalMs: 300_000, // 5 minutes
	discoveryEnabled: true,
	discoveryTtl: 7200, // 2 hours
	discoveryMaxEventsPerPubkey: 5,
}

const lightDefaults: LightClientConfig = {
	enabled: false,
	maxStorageBytes: 500 * 1024 * 1024, // 500 MB
	pruneIntervalMs: 600_000, // 10 minutes
}

function envInt(name: string, fallback: number): number {
	const val = process.env[name]
	if (val === undefined) return fallback
	const parsed = Number.parseInt(val, 10)
	return Number.isNaN(parsed) ? fallback : parsed
}

function envStr(name: string, fallback: string): string {
	return process.env[name] ?? fallback
}

function envBool(name: string, fallback: boolean): boolean {
	const val = process.env[name]
	if (val === undefined) return fallback
	return val === '1' || val.toLowerCase() === 'true'
}

function envList(name: string, fallback: string[]): string[] {
	const val = process.env[name]
	if (val === undefined) return fallback
	return val
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

export function loadConfig(overrides?: Partial<RelayConfig>): RelayConfig {
	return {
		port: envInt('WS_PORT', overrides?.port ?? defaults.port),
		host: envStr('WS_HOST', overrides?.host ?? defaults.host),
		storagePath: envStr('STORAGE_PATH', overrides?.storagePath ?? defaults.storagePath),
		topic: envStr('SWARM_TOPIC', overrides?.topic ?? defaults.topic),
		bootstrap: envStr('BOOTSTRAP_KEY', overrides?.bootstrap ?? defaults.bootstrap),
		admitWriters: envList('ADMIT_WRITERS', overrides?.admitWriters ?? defaults.admitWriters),
		requestWriter: envBool('REQUEST_WRITER', overrides?.requestWriter ?? defaults.requestWriter),
		autoAdmit: envBool('AUTO_ADMIT', overrides?.autoAdmit ?? defaults.autoAdmit),
		acceptOptimistic: envBool(
			'ACCEPT_OPTIMISTIC',
			overrides?.acceptOptimistic ?? defaults.acceptOptimistic,
		),
		relayName: envStr('RELAY_NAME', overrides?.relayName ?? defaults.relayName),
		relayDescription: envStr(
			'RELAY_DESCRIPTION',
			overrides?.relayDescription ?? defaults.relayDescription,
		),
		relayContact: envStr('RELAY_CONTACT', overrides?.relayContact ?? defaults.relayContact),
		relayPubkey: envStr('RELAY_PUBKEY', overrides?.relayPubkey ?? defaults.relayPubkey),
		maxMessageSize: envInt(
			'MAX_MESSAGE_SIZE',
			overrides?.maxMessageSize ?? defaults.maxMessageSize,
		),
		maxSubscriptionsPerConn: envInt(
			'MAX_SUBS',
			overrides?.maxSubscriptionsPerConn ?? defaults.maxSubscriptionsPerConn,
		),
		maxFiltersPerReq: envInt(
			'MAX_FILTERS',
			overrides?.maxFiltersPerReq ?? defaults.maxFiltersPerReq,
		),
		eventRatePerSec: envInt('EVENT_RATE', overrides?.eventRatePerSec ?? defaults.eventRatePerSec),
		reqRatePerSec: envInt('REQ_RATE', overrides?.reqRatePerSec ?? defaults.reqRatePerSec),
		expirationCleanupIntervalMs: envInt(
			'EXPIRATION_CLEANUP_MS',
			overrides?.expirationCleanupIntervalMs ?? defaults.expirationCleanupIntervalMs,
		),
	}
}

export function loadWotConfig(overrides?: Partial<WotConfig>): WotConfig {
	return {
		ownerPubkey: envStr('WOT_OWNER_PUBKEY', overrides?.ownerPubkey ?? wotDefaults.ownerPubkey),
		maxDepth: envInt('WOT_MAX_DEPTH', overrides?.maxDepth ?? wotDefaults.maxDepth),
		trustByDegree: overrides?.trustByDegree ?? wotDefaults.trustByDegree,
		ttlByDegree: overrides?.ttlByDegree ?? wotDefaults.ttlByDegree,
		refreshIntervalMs: envInt(
			'WOT_REFRESH_MS',
			overrides?.refreshIntervalMs ?? wotDefaults.refreshIntervalMs,
		),
		discoveryEnabled: envBool(
			'WOT_DISCOVERY',
			overrides?.discoveryEnabled ?? wotDefaults.discoveryEnabled,
		),
		discoveryTtl: envInt('WOT_DISCOVERY_TTL', overrides?.discoveryTtl ?? wotDefaults.discoveryTtl),
		discoveryMaxEventsPerPubkey: envInt(
			'WOT_DISCOVERY_MAX_EVENTS',
			overrides?.discoveryMaxEventsPerPubkey ?? wotDefaults.discoveryMaxEventsPerPubkey,
		),
	}
}

const shimDefaults: PrimalShimConfig = {
	port: 8801,
	host: '0.0.0.0',
	relayUrl: 'ws://127.0.0.1:3000',
	publicRelayUrl: '',
	dataDir: './primal-shim-data',
	upstreamSockets: 4,
	statsTtlMs: 30_000,
	statsCacheSize: 10_000,
	maxMessageSize: 131072, // 128 KB, matches the relay default
	queryTimeoutMs: 15_000,
}

export function loadShimConfig(overrides?: Partial<PrimalShimConfig>): PrimalShimConfig {
	const relayUrl = envStr('SHIM_RELAY_URL', overrides?.relayUrl ?? shimDefaults.relayUrl)
	// Browsers can't reach 0.0.0.0/127.x through the page origin's eyes in all
	// setups; advertise a localhost URL unless explicitly overridden.
	const publicFallback = relayUrl
		.replace('://127.0.0.1', '://localhost')
		.replace('://0.0.0.0', '://localhost')
	return {
		port: envInt('SHIM_PORT', overrides?.port ?? shimDefaults.port),
		host: envStr('SHIM_HOST', overrides?.host ?? shimDefaults.host),
		relayUrl,
		publicRelayUrl: envStr('SHIM_PUBLIC_RELAY_URL', overrides?.publicRelayUrl ?? publicFallback),
		dataDir: envStr('SHIM_DATA_DIR', overrides?.dataDir ?? shimDefaults.dataDir),
		upstreamSockets: envInt(
			'SHIM_UPSTREAM_SOCKETS',
			overrides?.upstreamSockets ?? shimDefaults.upstreamSockets,
		),
		statsTtlMs: envInt('SHIM_STATS_TTL_MS', overrides?.statsTtlMs ?? shimDefaults.statsTtlMs),
		statsCacheSize: envInt(
			'SHIM_STATS_CACHE_SIZE',
			overrides?.statsCacheSize ?? shimDefaults.statsCacheSize,
		),
		maxMessageSize: envInt(
			'SHIM_MAX_MESSAGE_SIZE',
			overrides?.maxMessageSize ?? shimDefaults.maxMessageSize,
		),
		queryTimeoutMs: envInt(
			'SHIM_QUERY_TIMEOUT_MS',
			overrides?.queryTimeoutMs ?? shimDefaults.queryTimeoutMs,
		),
	}
}

export function loadLightConfig(overrides?: Partial<LightClientConfig>): LightClientConfig {
	return {
		enabled: envBool('LIGHT_CLIENT', overrides?.enabled ?? lightDefaults.enabled),
		maxStorageBytes: envInt(
			'LIGHT_MAX_STORAGE',
			overrides?.maxStorageBytes ?? lightDefaults.maxStorageBytes,
		),
		pruneIntervalMs: envInt(
			'LIGHT_PRUNE_MS',
			overrides?.pruneIntervalMs ?? lightDefaults.pruneIntervalMs,
		),
	}
}
