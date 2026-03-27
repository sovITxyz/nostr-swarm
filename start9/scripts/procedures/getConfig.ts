// Start9 getConfig procedure
// Returns the config spec (form definition) and current values

export const getConfig = async (effects: any) => {
	let config: Record<string, unknown> = {}

	try {
		const raw = await effects.readFile({
			volumeId: 'main',
			path: 'start9/config.yaml',
		})
		// Simple YAML parse for flat key-value pairs
		for (const line of raw.split('\n')) {
			const match = line.match(/^([a-z-]+):\s*(.*)$/)
			if (match) {
				const key = match[1]!
				let value: string | number = match[2]!.replace(/^["']|["']$/g, '')
				if (/^\d+$/.test(value)) value = Number.parseInt(value, 10)
				config[key] = value
			}
		}
	} catch {
		// No config yet, use defaults
	}

	return {
		spec: {
			'relay-name': {
				type: 'string',
				name: 'Relay Name',
				description: 'Public name of your relay (shown in NIP-11)',
				nullable: false,
				default: config['relay-name'] ?? 'nostr-swarm',
			},
			'relay-description': {
				type: 'string',
				name: 'Relay Description',
				description: 'Public description of your relay',
				nullable: true,
				default: config['relay-description'] ?? 'A peer-to-peer Nostr relay over Hyperswarm',
			},
			'relay-contact': {
				type: 'string',
				name: 'Admin Contact',
				description: 'Contact info for the relay admin (email, npub, etc.)',
				nullable: true,
				default: config['relay-contact'] ?? '',
			},
			'relay-pubkey': {
				type: 'string',
				name: 'Admin Pubkey',
				description: 'Your Nostr public key (64-character hex)',
				nullable: true,
				default: config['relay-pubkey'] ?? '',
				pattern: '^[0-9a-f]{64}$',
				'pattern-description': 'Must be a 64-character hex string',
			},
			'swarm-topic': {
				type: 'string',
				name: 'Swarm Topic',
				description:
					'Topic name for peer discovery. All relays on the same topic share events. Change this for a private network.',
				nullable: false,
				default: config['swarm-topic'] ?? 'nostr',
			},
			'wot-owner-pubkey': {
				type: 'string',
				name: 'WoT Owner Pubkey',
				description:
					'Your Nostr pubkey (hex) to enable Web of Trust filtering. Leave empty to store all events.',
				nullable: true,
				default: config['wot-owner-pubkey'] ?? '',
				pattern: '^([0-9a-f]{64})?$',
				'pattern-description': 'Must be a 64-character hex string or empty',
			},
			'wot-max-depth': {
				type: 'number',
				name: 'WoT Depth',
				description: 'Max hops in the trust graph (1=direct follows only, 3=default)',
				nullable: false,
				default: config['wot-max-depth'] ?? 3,
				range: '[1,5]',
				integral: true,
			},
			'max-message-size': {
				type: 'number',
				name: 'Max Message Size',
				description: 'Maximum message size in bytes',
				nullable: false,
				default: config['max-message-size'] ?? 131072,
				range: '[1024,1048576]',
				integral: true,
			},
			'max-subscriptions': {
				type: 'number',
				name: 'Max Subscriptions',
				description: 'Maximum subscriptions per WebSocket connection',
				nullable: false,
				default: config['max-subscriptions'] ?? 20,
				range: '[1,100]',
				integral: true,
			},
			'event-rate': {
				type: 'number',
				name: 'Event Rate Limit',
				description: 'Max events per second per connection',
				nullable: false,
				default: config['event-rate'] ?? 10,
				range: '[1,1000]',
				integral: true,
			},
			'req-rate': {
				type: 'number',
				name: 'Request Rate Limit',
				description: 'Max REQ messages per second per connection',
				nullable: false,
				default: config['req-rate'] ?? 20,
				range: '[1,1000]',
				integral: true,
			},
		},
	}
}
