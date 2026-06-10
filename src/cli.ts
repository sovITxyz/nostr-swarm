#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { NostrSwarm } from './relay.js'
import { setLogLevel } from './util/logger.js'

const { values } = parseArgs({
	options: {
		port: { type: 'string', short: 'p' },
		storage: { type: 'string', short: 's' },
		topic: { type: 'string', short: 't' },
		bootstrap: { type: 'string' },
		admit: { type: 'string', multiple: true },
		'relay-name': { type: 'string' },
		'relay-contact': { type: 'string' },
		'wot-pubkey': { type: 'string' },
		'wot-depth': { type: 'string' },
		'light-client': { type: 'boolean' },
		'no-discovery': { type: 'boolean' },
		'discovery-ttl': { type: 'string' },
		'discovery-max-events': { type: 'string' },
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
      --bootstrap <invite>    Join an existing base: paste the founder's
                              'nsw1…' invite (or a raw 64-hex base key).
                              Omit to found a new base.
      --admit <hex64>         Writer key to admit (repeatable). Run on any
                              existing writer to grant write access.
      --relay-name <name>     Relay name for NIP-11
      --relay-contact <addr>  Admin contact for NIP-11
      --wot-pubkey <hex>      Owner pubkey for Web of Trust filtering
      --wot-depth <number>    Max WoT hops (default: 3)
      --light-client          Enable light client mode (WoT filtering + pruning)
      --no-discovery          Disable discovery tier for unknown pubkeys
      --discovery-ttl <secs>  TTL for discovery events (default: 7200 = 2 hours)
      --discovery-max-events <n>  Max events per unknown pubkey (default: 5)
  -v, --verbose               Enable debug logging
  -h, --help                  Show this help

Multi-writer workflow (founder/joiner):
  1. Exactly one node per swarm starts WITHOUT --bootstrap. It founds the
     shared base and logs its invite (nsw1…) on startup.
  2. Every other node starts WITH --bootstrap <invite>. Joiners replicate and
     serve reads immediately, but stay read-only until admitted; each joiner
     logs its own writer key on startup.
  3. To admit a joiner, send its writer key to the operator of any existing
     writer, who restarts with --admit <writerKeyHex>. The joiner becomes
     writable as soon as the admission replicates — no restart on its side.

Environment variables:
  WS_PORT, WS_HOST, STORAGE_PATH, SWARM_TOPIC,
  BOOTSTRAP_KEY (invite or 64-hex; same as --bootstrap),
  ADMIT_WRITERS (comma-separated 64-hex writer keys; same as --admit),
  RELAY_NAME, RELAY_DESCRIPTION, RELAY_CONTACT, RELAY_PUBKEY,
  MAX_MESSAGE_SIZE, MAX_SUBS, MAX_FILTERS,
  EVENT_RATE, REQ_RATE,
  WOT_OWNER_PUBKEY, WOT_MAX_DEPTH, WOT_REFRESH_MS,
  WOT_DISCOVERY, WOT_DISCOVERY_TTL, WOT_DISCOVERY_MAX_EVENTS,
  LIGHT_CLIENT, LIGHT_MAX_STORAGE, LIGHT_PRUNE_MS

Note: environment variables take precedence over CLI flags (BOOTSTRAP_KEY
beats --bootstrap, ADMIT_WRITERS beats --admit).
`)
	process.exit(0)
}

if (values.verbose) {
	setLogLevel('debug')
}

const relayOverrides: Record<string, unknown> = {}
if (values.port) relayOverrides.port = Number.parseInt(values.port, 10)
if (values.storage) relayOverrides.storagePath = values.storage
if (values.topic) relayOverrides.topic = values.topic
if (values.bootstrap) relayOverrides.bootstrap = values.bootstrap
if (values.admit && values.admit.length > 0) relayOverrides.admitWriters = values.admit
if (values['relay-name']) relayOverrides.relayName = values['relay-name']
if (values['relay-contact']) relayOverrides.relayContact = values['relay-contact']

const wotOverrides: Record<string, unknown> = {}
if (values['wot-pubkey']) wotOverrides.ownerPubkey = values['wot-pubkey']
if (values['wot-depth']) wotOverrides.maxDepth = Number.parseInt(values['wot-depth'], 10)
if (values['no-discovery']) wotOverrides.discoveryEnabled = false
if (values['discovery-ttl'])
	wotOverrides.discoveryTtl = Number.parseInt(values['discovery-ttl'], 10)
if (values['discovery-max-events'])
	wotOverrides.discoveryMaxEventsPerPubkey = Number.parseInt(values['discovery-max-events'], 10)

const lightOverrides: Record<string, unknown> = {}
if (values['light-client']) lightOverrides.enabled = true

const relay = new NostrSwarm({
	relay: relayOverrides,
	wot: wotOverrides,
	light: lightOverrides,
})

relay.start().catch((err) => {
	console.error('Failed to start:', err)
	process.exit(1)
})
