/** Core Nostr event as defined by NIP-01 */
export interface NostrEvent {
	id: string
	pubkey: string
	created_at: number
	kind: number
	tags: string[][]
	content: string
	sig: string
}

/** NIP-01 filter for querying events */
export interface NostrFilter {
	ids?: string[]
	authors?: string[]
	kinds?: number[]
	since?: number
	until?: number
	limit?: number
	search?: string
	[key: `#${string}`]: string[] | undefined
}

/** Classification of event kinds */
export type EventKind = 'regular' | 'replaceable' | 'ephemeral' | 'addressable'

/** Operations appended to Autobase */
export type StoreOp =
	| { type: 'put'; event: NostrEvent }
	| { type: 'delete'; event: NostrEvent }

/** Client-to-relay message types */
export type ClientMessage =
	| ['EVENT', NostrEvent]
	| ['REQ', string, ...NostrFilter[]]
	| ['CLOSE', string]
	| ['COUNT', string, ...NostrFilter[]]
	| ['AUTH', NostrEvent]

/** Relay-to-client message types */
export type RelayMessage =
	| ['EVENT', string, NostrEvent]
	| ['OK', string, boolean, string]
	| ['EOSE', string]
	| ['CLOSED', string, string]
	| ['NOTICE', string]
	| ['COUNT', string, { count: number }]
	| ['AUTH', string]

/** Relay configuration */
export interface RelayConfig {
	port: number
	host: string
	storagePath: string
	topic: string
	relayName: string
	relayDescription: string
	relayContact: string
	relayPubkey: string
	maxMessageSize: number
	maxSubscriptionsPerConn: number
	maxFiltersPerReq: number
	eventRatePerSec: number
	reqRatePerSec: number
	expirationCleanupIntervalMs: number
}

/** NIP-11 relay information document */
export interface RelayInfo {
	name: string
	description: string
	pubkey: string
	contact: string
	supported_nips: number[]
	software: string
	version: string
	limitation: {
		max_message_length: number
		max_subscriptions: number
		max_filters: number
		auth_required: boolean
		payment_required: boolean
	}
}

/** Swarm protocol messages between peers */
export type SwarmMessage =
	| { type: 'event_notify'; id: string }
	| { type: 'bootstrap_key'; key: string }

/** Web of Trust configuration */
export interface WotConfig {
	/** This relay's owner pubkey — the root of the trust graph */
	ownerPubkey: string
	/** Max hops from owner to consider trusted (default: 3) */
	maxDepth: number
	/** Trust scores by degree of separation */
	trustByDegree: Record<number, number>
	/** How long to keep events from each trust tier (seconds, 0 = forever) */
	ttlByDegree: Record<number, number>
	/** How often to rebuild the trust graph (ms) */
	refreshIntervalMs: number
	/** Enable discovery tier for unknown pubkeys (default: true when WoT is enabled) */
	discoveryEnabled: boolean
	/** TTL for events from unknown pubkeys, in seconds (default: 7200 = 2 hours) */
	discoveryTtl: number
	/** Max events stored per unknown pubkey (kind 0/3/10000 exempt) (default: 5) */
	discoveryMaxEventsPerPubkey: number
}

/** Trust tier for a pubkey */
export interface TrustScore {
	pubkey: string
	degree: number
	score: number
	/** Whether this pubkey is explicitly muted */
	muted: boolean
}

/** Replication policy decision */
export type ReplicationPolicy =
	| { action: 'accept'; ttl: number | null; discovery?: boolean }
	| { action: 'reject'; reason: string }

/** Light client configuration */
export interface LightClientConfig {
	/** Enable light client mode (sparse replication + WoT filtering) */
	enabled: boolean
	/** Max storage in bytes before pruning kicks in (default: 500MB) */
	maxStorageBytes: number
	/** How often to run the pruning job (ms) */
	pruneIntervalMs: number
}
