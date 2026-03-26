import type { RelayConfig } from './types.js'

const defaults: RelayConfig = {
	port: 3000,
	host: '0.0.0.0',
	storagePath: './nostr-swarm-data',
	topic: 'nostr',
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

function envInt(name: string, fallback: number): number {
	const val = process.env[name]
	if (val === undefined) return fallback
	const parsed = Number.parseInt(val, 10)
	return Number.isNaN(parsed) ? fallback : parsed
}

function envStr(name: string, fallback: string): string {
	return process.env[name] ?? fallback
}

export function loadConfig(overrides?: Partial<RelayConfig>): RelayConfig {
	return {
		port: envInt('WS_PORT', overrides?.port ?? defaults.port),
		host: envStr('WS_HOST', overrides?.host ?? defaults.host),
		storagePath: envStr('STORAGE_PATH', overrides?.storagePath ?? defaults.storagePath),
		topic: envStr('SWARM_TOPIC', overrides?.topic ?? defaults.topic),
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
		eventRatePerSec: envInt(
			'EVENT_RATE',
			overrides?.eventRatePerSec ?? defaults.eventRatePerSec,
		),
		reqRatePerSec: envInt('REQ_RATE', overrides?.reqRatePerSec ?? defaults.reqRatePerSec),
		expirationCleanupIntervalMs: envInt(
			'EXPIRATION_CLEANUP_MS',
			overrides?.expirationCleanupIntervalMs ?? defaults.expirationCleanupIntervalMs,
		),
	}
}
