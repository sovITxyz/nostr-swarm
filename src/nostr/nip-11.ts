import type { RelayConfig, RelayInfo } from '../util/types.js'

/** Build a NIP-11 relay information document */
export function buildRelayInfo(config: RelayConfig, version: string): RelayInfo {
	return {
		name: config.relayName,
		description: config.relayDescription,
		pubkey: config.relayPubkey,
		contact: config.relayContact,
		supported_nips: [1, 9, 11, 40, 42, 45, 70],
		software: 'nostr-swarm',
		version,
		limitation: {
			max_message_length: config.maxMessageSize,
			max_subscriptions: config.maxSubscriptionsPerConn,
			max_filters: config.maxFiltersPerReq,
			auth_required: false,
			payment_required: false,
		},
	}
}
