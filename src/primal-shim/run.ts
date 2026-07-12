import { parseArgs } from 'node:util'
import goodbye from 'graceful-goodbye'
import { loadShimConfig } from '../util/config.js'
import { setLogLevel } from '../util/logger.js'
import type { PrimalShimConfig } from '../util/types.js'
import { PrimalShim } from './server.js'

/** CLI entry for `nostr-swarm primal-shim`. Runs until terminated. */
export async function runPrimalShim(args: string[]): Promise<never> {
	const { values } = parseArgs({
		args,
		options: {
			relay: { type: 'string', short: 'r' },
			port: { type: 'string', short: 'p' },
			host: { type: 'string' },
			'data-dir': { type: 'string', short: 'd' },
			'public-relay': { type: 'string' },
			verbose: { type: 'boolean', short: 'v' },
			help: { type: 'boolean', short: 'h' },
		},
		strict: true,
	})

	if (values.help) {
		console.log(`
nostr-swarm primal-shim - Primal cache protocol adapter

Serves the WebSocket protocol the open-source Primal web app expects
(PRIMAL_CACHE_URL) and answers it from a nostr-swarm relay over NIP-01.

Usage: nostr-swarm primal-shim [options]

Options:
  -r, --relay <ws-url>        Upstream relay to query (default: ws://127.0.0.1:3000)
  -p, --port <number>         Shim WebSocket port (default: 8801)
      --host <address>        Bind address (default: 0.0.0.0)
  -d, --data-dir <path>       Shim state directory (default: ./primal-shim-data)
      --public-relay <url>    Relay URL advertised to browsers via
                              get_default_relays (default: derived from --relay)
  -v, --verbose               Enable debug logging
  -h, --help                  Show this help

Environment variables (take precedence over flags):
  SHIM_PORT, SHIM_HOST, SHIM_RELAY_URL, SHIM_PUBLIC_RELAY_URL, SHIM_DATA_DIR,
  SHIM_UPSTREAM_SOCKETS, SHIM_STATS_TTL_MS, SHIM_STATS_CACHE_SIZE,
  SHIM_MAX_MESSAGE_SIZE, SHIM_QUERY_TIMEOUT_MS

Point the Primal web app at the shim:
  .env:  PRIMAL_CACHE_URL = "ws://localhost:8801"
  or at runtime: localStorage.setItem('cacheServer', 'ws://localhost:8801')
`)
		process.exit(0)
	}

	if (values.verbose) {
		setLogLevel('debug')
	}

	const overrides: Partial<PrimalShimConfig> = {}
	if (values.relay) overrides.relayUrl = values.relay
	if (values.port) overrides.port = Number.parseInt(values.port, 10)
	if (values.host) overrides.host = values.host
	if (values['data-dir']) overrides.dataDir = values['data-dir']
	if (values['public-relay']) overrides.publicRelayUrl = values['public-relay']

	const shim = new PrimalShim(loadShimConfig(overrides))
	try {
		await shim.start()
	} catch (err) {
		console.error('Failed to start primal-shim:', err instanceof Error ? err.message : err)
		process.exit(1)
	}

	goodbye(async () => {
		await shim.stop()
	})

	// Long-running service: keep the CLI from falling through to relay startup
	return new Promise<never>(() => {})
}
