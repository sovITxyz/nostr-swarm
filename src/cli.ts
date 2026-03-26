#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { NostrSwarm } from './relay.js'
import { setLogLevel } from './util/logger.js'

const { values } = parseArgs({
	options: {
		port: { type: 'string', short: 'p' },
		storage: { type: 'string', short: 's' },
		topic: { type: 'string', short: 't' },
		'relay-name': { type: 'string' },
		'relay-contact': { type: 'string' },
		verbose: { type: 'boolean', short: 'v' },
		help: { type: 'boolean', short: 'h' },
	},
	strict: true,
})

if (values.help) {
	console.log(`
nostr-swarm - A peer-to-peer Nostr relay over Hyperswarm

Usage: nostr-swarm [options]

Options:
  -p, --port <number>         WebSocket port (default: 3000)
  -s, --storage <path>        Storage directory (default: ./nostr-swarm-data)
  -t, --topic <name>          Swarm topic (default: nostr)
      --relay-name <name>     Relay name for NIP-11
      --relay-contact <addr>  Admin contact for NIP-11
  -v, --verbose               Enable debug logging
  -h, --help                  Show this help

Environment variables:
  WS_PORT, WS_HOST, STORAGE_PATH, SWARM_TOPIC,
  RELAY_NAME, RELAY_DESCRIPTION, RELAY_CONTACT, RELAY_PUBKEY,
  MAX_MESSAGE_SIZE, MAX_SUBS, MAX_FILTERS,
  EVENT_RATE, REQ_RATE
`)
	process.exit(0)
}

if (values.verbose) {
	setLogLevel('debug')
}

const overrides: Record<string, unknown> = {}
if (values.port) overrides.port = Number.parseInt(values.port, 10)
if (values.storage) overrides.storagePath = values.storage
if (values.topic) overrides.topic = values.topic
if (values['relay-name']) overrides.relayName = values['relay-name']
if (values['relay-contact']) overrides.relayContact = values['relay-contact']

const relay = new NostrSwarm(overrides)

relay.start().catch((err) => {
	console.error('Failed to start:', err)
	process.exit(1)
})
