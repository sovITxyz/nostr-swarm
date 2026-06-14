#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { NostrSwarm } from './relay.js'
import { runExport, runImport } from './tools/migrate.js'
import { setLogLevel } from './util/logger.js'

// Subcommand dispatch happens before parseArgs: 'export' and 'import' are the
// two-base merge tools (docs/design/multiwriter-sync.md §3.5) with their own flags.
const argv = process.argv.slice(2)
if (argv[0] === 'export' || argv[0] === 'import') {
	await runSubcommand(argv[0], argv.slice(1))
}

/** Run an export/import subcommand and exit the process (never returns) */
async function runSubcommand(command: 'export' | 'import', args: string[]): Promise<never> {
	try {
		if (command === 'export') {
			const parsed = parseArgs({
				args,
				options: { storage: { type: 'string', short: 's' } },
				strict: true,
			})
			const storage = parsed.values.storage
			if (!storage) {
				console.error('usage: nostr-swarm export --storage <dir>   (writes JSONL to stdout)')
				process.exit(1)
			}
			// JSONL goes to stdout — keep informational logs off it (warn/error use stderr)
			setLogLevel('warn')
			const result = await runExport(storage)
			console.error(
				`export: wrote ${result.exported} events (${result.skipped} invalid records skipped)`,
			)
			process.exit(0)
		}

		const parsed = parseArgs({
			args,
			options: { url: { type: 'string', short: 'u' } },
			strict: true,
		})
		const url = parsed.values.url
		if (!url) {
			console.error('usage: nostr-swarm import --url ws://host:port   (reads JSONL from stdin)')
			process.exit(1)
		}
		const result = await runImport(url)
		console.error(
			`import: ${result.imported} stored, ${result.duplicates} duplicates, ${result.rejected} rejected`,
		)
		process.exit(0)
	} catch (err) {
		console.error(`${command} failed:`, err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}

const { values } = parseArgs({
	options: {
		port: { type: 'string', short: 'p' },
		storage: { type: 'string', short: 's' },
		topic: { type: 'string', short: 't' },
		bootstrap: { type: 'string' },
		admit: { type: 'string', multiple: true },
		'request-writer': { type: 'boolean' },
		'auto-admit': { type: 'boolean' },
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
       nostr-swarm export --storage <dir>
       nostr-swarm import --url <ws-url>

Subcommands:
  export --storage <dir>      Dump every valid event from a storage directory
                              as JSONL on stdout (invalid records are skipped).
  import --url <ws-url>       Read JSONL on stdin and publish each event to a
                              relay over its normal validated WebSocket path.
                              Exits non-zero on connection failure; duplicate
                              OKs count as success (replay is idempotent).

Options:
  -p, --port <number>         WebSocket port (default: 3000)
  -s, --storage <path>        Storage directory (default: ./nostr-swarm-data)
  -t, --topic <name>          Swarm topic (default: nostr)
      --bootstrap <invite>    Join an existing base: paste the founder's
                              'nsw1…' invite (or a raw 64-hex base key).
                              Omit to found a new base.
      --admit <hex64>         Writer key to admit (repeatable). Run on any
                              existing writer to grant write access.
      --request-writer        Joiner: request writer admission in-band over the
                              swarm (proves invite possession), instead of
                              waiting for an operator --admit. No effect once
                              already writable.
      --auto-admit            Granter: honor in-band admission requests from
                              peers that prove they hold the invite. OPT-IN: it
                              turns the invite into a write capability, so only
                              enable it on a base whose invite you treat as a
                              shared writer secret. Off by default.
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

  In-band admission (optional, no key copying): start an existing writer with
  --auto-admit and the joiner with --request-writer. The joiner proves it holds
  the invite over the swarm and is admitted automatically. Treat --auto-admit as
  making the invite a write capability: only enable it when everyone you give
  the invite to is trusted to write.

Merging two existing relays (e.g. recovering from a two-founder split):
  1. Stop the node being merged in and dump its events:
       nostr-swarm export --storage ./old-data > events.jsonl
  2. Restart it on a FRESH storage path, joining the canonical base:
       nostr-swarm --storage ./new-data --bootstrap <invite>
  3. Get its writer key admitted (--admit on any existing writer's node).
  4. Replay the dump through the normal validated WS path:
       nostr-swarm import --url ws://127.0.0.1:3000 < events.jsonl
  Events are self-certifying and deduped by id, so re-running the import
  is safe (idempotent).

Environment variables:
  WS_PORT, WS_HOST, STORAGE_PATH, SWARM_TOPIC,
  BOOTSTRAP_KEY (invite or 64-hex; same as --bootstrap),
  ADMIT_WRITERS (comma-separated 64-hex writer keys; same as --admit),
  REQUEST_WRITER (1/true; same as --request-writer),
  AUTO_ADMIT (1/true; same as --auto-admit),
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
if (values['request-writer']) relayOverrides.requestWriter = true
if (values['auto-admit']) relayOverrides.autoAdmit = true
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
