# nostr-swarm

A fully peer-to-peer Nostr relay that syncs events over Hyperswarm. Every peer is equal -- no central server required.

Built on the [Holepunch](https://holepunch.to) stack: Hyperswarm for connectivity, Autobase for multi-writer consensus, and Hyperbee for indexed storage.

## How it works

- One node per swarm (the **founder**) starts without `--bootstrap`, creates the shared multi-writer Autobase, and logs a checksummed invite (`nsw1…`) at startup
- Every other node (a **joiner**) starts with `--bootstrap <invite>` and deterministically opens the founder's base -- peers discover each other on a shared Hyperswarm topic and replicate over encrypted connections
- Joiners replicate and serve full reads immediately, but stay **read-only until admitted**: the operator of any existing writer runs `--admit <writerKey>` to grant write access
- Autobase linearizes all admitted writers' operations into a deterministic Hyperbee view -- every node of one base converges to the same events, indexes, and deletions
- A WebSocket server exposes the standard Nostr relay protocol (NIP-01) for traditional clients
- Pear Runtime apps can replicate directly over Hyperswarm as read-mostly peers (writes go through a relay's WebSocket endpoint)

## Requirements

- Node.js >= 20

## Install

```bash
# Run directly (no install needed)
npx nostr-swarm

# Or install globally
npm install -g nostr-swarm
nostr-swarm

# Or as a library
npm install nostr-swarm
```

### From source

```bash
git clone https://github.com/sovITxyz/nostr-swarm.git
cd nostr-swarm
npm install
npm run build
```

## Usage

```bash
# Run with defaults (port 3000, storage ./nostr-swarm-data) -- founds a new base
nostr-swarm

# Custom options
nostr-swarm --port 4000 --storage ./data --topic my-relay

# Join an existing relay's shared base (paste its nsw1… invite)
nostr-swarm --bootstrap nsw1...

# Admit a joiner as a writer (run on any existing writer)
nostr-swarm --admit <joinerWriterKeyHex>

# Development (from source)
npm run dev
```

### Multi-writer workflow (founder/joiner)

Two nodes only converge on the same data when they share one Autobase. That is explicit, not automatic:

1. **Found** -- exactly one node per swarm starts *without* `--bootstrap`. It founds the shared base and logs its invite (`nsw1…`), raw base key, and local writer key at startup (also written to `<storage>/keys.json`).
2. **Join** -- every other node starts *with* `--bootstrap <invite>` (or the raw 64-hex base key). A joiner replicates and serves reads immediately, but stays **read-only** -- `EVENT` gets `["OK", id, false, "blocked: read-only replica awaiting writer admission"]` -- until admitted. Each joiner logs its own writer key at startup.
3. **Admit** -- send the joiner's writer key (out-of-band) to the operator of any existing writer, who restarts with `--admit <writerKeyHex>`. Once the admission replicates, the joiner becomes writable automatically -- no restart on its side.

Safety properties:

- The invite is checksummed: a typo'd `--bootstrap` is a hard startup error, never a silently re-founded empty node.
- The base identity is pinned per storage directory (`<storage>/bootstrap-key`): once a node has started, configuring a *different* bootstrap key is a fatal error. To join a different base, use a fresh storage path and migrate events with `export`/`import`.
- Writers are capped at 64 per base; duplicate admissions are no-ops, so `--admit` flags can be left in place across restarts.
- The founder is the sole indexer -- keep backups of its storage directory (writes still merge if it is lost, but checkpoints stall).

To merge two relays that were *both* founded independently (each owning its own base): `nostr-swarm export --storage <old-dir> > events.jsonl`, restart one of them on a fresh storage path with `--bootstrap`, get it admitted, then `nostr-swarm import --url ws://127.0.0.1:3000 < events.jsonl`. Events are self-certifying and deduped by id, so re-running the import is safe.

### CLI options

```
-p, --port <number>         WebSocket port (default: 3000)
-s, --storage <path>        Storage directory (default: ./nostr-swarm-data)
-t, --topic <name>          Swarm topic (default: nostr)
    --bootstrap <invite>    Join an existing base: the founder's nsw1… invite
                            or a raw 64-hex base key (omit to found a new base)
    --admit <hex64>         Writer key to admit (repeatable); run on any
                            existing writer to grant write access
    --relay-name <name>     Relay name for NIP-11
    --relay-contact <addr>  Admin contact for NIP-11
    --wot-pubkey <hex>      Owner pubkey for Web of Trust filtering
    --wot-depth <number>    Max WoT hops (default: 3)
    --light-client          Enable light client mode (WoT filtering)
    --no-discovery          Disable discovery tier for unknown pubkeys
    --discovery-ttl <secs>  TTL for discovery events (default: 7200)
    --discovery-max-events <n>  Max events per unknown pubkey (default: 5)
-v, --verbose               Enable debug logging
-h, --help                  Show help
```

Subcommands: `nostr-swarm export --storage <dir>` (dump all valid events as JSONL to stdout) and `nostr-swarm import --url <ws-url>` (replay JSONL from stdin through the normal validated WebSocket path).

### Environment variables

All config can also be set via environment variables. Note: environment variables take precedence over CLI flags (`BOOTSTRAP_KEY` beats `--bootstrap`, `ADMIT_WRITERS` beats `--admit`).

| Variable | Description | Default |
|---|---|---|
| `WS_PORT` | WebSocket port | `3000` |
| `WS_HOST` | Bind address | `0.0.0.0` |
| `STORAGE_PATH` | Data directory | `./nostr-swarm-data` |
| `SWARM_TOPIC` | Swarm topic name | `nostr` |
| `BOOTSTRAP_KEY` | `nsw1…` invite or 64-hex base key to join (empty = found) | (empty) |
| `ADMIT_WRITERS` | Comma-separated 64-hex writer keys to admit | (empty) |
| `RELAY_NAME` | Relay name (NIP-11) | `nostr-swarm` |
| `RELAY_DESCRIPTION` | Relay description (NIP-11) | |
| `RELAY_CONTACT` | Admin contact (NIP-11) | |
| `RELAY_PUBKEY` | Admin pubkey (NIP-11) | |
| `MAX_MESSAGE_SIZE` | Max message bytes | `131072` |
| `MAX_SUBS` | Max subscriptions per connection | `20` |
| `MAX_FILTERS` | Max filters per REQ | `10` |
| `EVENT_RATE` | Events per second limit | `10` |
| `REQ_RATE` | REQs per second limit | `20` |
| `WOT_OWNER_PUBKEY` | Owner pubkey for WoT (enables filtering) | |
| `WOT_MAX_DEPTH` | Trust graph max hops | `3` |
| `WOT_REFRESH_MS` | WoT graph refresh interval (ms) | `300000` |
| `WOT_DISCOVERY` | Enable discovery tier for unknown pubkeys | `true` |
| `WOT_DISCOVERY_TTL` | TTL for discovery events (seconds) | `7200` |
| `WOT_DISCOVERY_MAX_EVENTS` | Max events per unknown pubkey | `5` |
| `LIGHT_CLIENT` | Enable light client mode | `false` |
| `LIGHT_MAX_STORAGE` | Max storage target (bytes) -- **not enforced this release**, logs a warning | `524288000` |
| `LIGHT_PRUNE_MS` | Pruning interval (ms) -- pruning is currently a warn-once no-op | `600000` |

Note: light-client TTL pruning is disabled this release. It used to append forged, unsigned deletion ops, which the consensus `apply()` now (correctly) drops -- and in a shared multi-writer base they would otherwise act as global deletions. True local pruning is deferred; until then `LIGHT_MAX_STORAGE` degrades to a warning.

## Deployment

### Peer-to-peer (native)

Since nostr-swarm uses Hyperswarm for NAT hole-punching, every node is a peer -- no server infrastructure, TLS, or reverse proxy required. Just run the process:

```bash
# First node: founds the base, logs its nsw1… invite
nostr-swarm --topic my-relay --storage /var/lib/nostr-swarm

# Every other node: joins with the founder's invite
nostr-swarm --topic my-relay --storage /var/lib/nostr-swarm --bootstrap nsw1...
```

Nodes on the same topic automatically discover each other and replicate connections, but they only share one database when they share one base: pass the founder's invite via `--bootstrap` on every other node, then admit each joiner's writer key with `--admit` (see the multi-writer workflow above). A node started without `--bootstrap` founds its own independent base.

### Process manager

```bash
# pm2
npx pm2 start nostr-swarm -- --port 3000

# systemd
sudo systemctl enable --now nostr-swarm
```

Example systemd unit (`/etc/systemd/system/nostr-swarm.service`):

```ini
[Unit]
Description=nostr-swarm relay
After=network.target

[Service]
Type=simple
User=nostr
WorkingDirectory=/opt/nostr-swarm
ExecStart=/usr/bin/env nostr-swarm
Environment=WS_PORT=3000
Environment=STORAGE_PATH=/var/lib/nostr-swarm
Restart=always

[Install]
WantedBy=multi-user.target
```

### Start9 (StartOS)

nostr-swarm includes a Start9 service package for sovereign self-hosting. See [Start9 Deployment](docs/start9.md) for full details.

```bash
cd start9
make
# Produces nostr-swarm.s9pk for sideloading or marketplace submission
```

Your Start9 node becomes an always-on relay peer with Tor and LAN access. To join another relay's base, paste its `nsw1…` invite into the **Bootstrap Key (Invite)** config field; your node's own invite and writer key are shown in the service properties for sharing. Writer admission is done by pasting a joiner's writer key into **Admit Writers** (saving config restarts the service, which performs the admission).

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
VOLUME /data
CMD ["node", "dist/cli.js", "--storage", "/data"]
```

### Traditional WebSocket clients

If you need `wss://` for browser-based Nostr clients, put the relay behind a reverse proxy with TLS:

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## Pear Runtime client

Pear apps connect directly to the swarm -- no WebSocket layer, no server. A Pear client is a **read-mostly peer**: it replicates the shared base and reads the full view locally, but it is not admitted as a writer -- writes go through a relay's WebSocket endpoint.

```js
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import { createHash } from 'crypto'
// decodeInvite turns the relay's nsw1… invite into the 32-byte base key
// (see src/util/invite.ts -- 'nsw1' + z32(version || key || checksum))
import { decodeInvite } from 'nostr-swarm'

const store = new Corestore('./pear-nostr-data')
const swarm = new Hyperswarm()

// Same topic derivation as the relay
const topic = createHash('sha256').update('nostr-swarm:nostr').digest()

// The invite comes from a relay operator (logged at startup / keys.json /
// Start9 properties). Pasting it is what joins this peer to the shared base.
const baseKey = decodeInvite('nsw1...')

// Open the shared Autobase view
const base = new Autobase(store, baseKey, {
  open: (store) => new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  }),
  apply,   // must match the relay's apply exactly (src/storage/store.ts)
  valueEncoding: 'json',
})
await base.ready()

// Join and replicate through the base (not the raw corestore)
swarm.on('connection', (socket) => base.replicate(socket))
swarm.join(topic, { server: true, client: true })

// Read Nostr events locally through base.view (Hyperbee).
// To publish, send EVENT to any admitted relay's WebSocket endpoint.
```

The invite is shared operator-to-operator: it is checksummed (a typo fails loudly instead of silently founding an empty base) and the raw 64-hex base key is also accepted for scripting. Light/Pear clients are never admitted as writers in this release -- appending directly to the base would be rolled back as un-admitted. A future release adds an in-band admission channel (the contract is fully specified in `src/swarm/protocol.ts`).

## Architecture

```
Nostr clients (WebSocket)
        |
   [WS Server] --- NIP-01 protocol
        |
   [EventStore] --- Autobase + Hyperbee (indexed storage)
        |
   [SwarmNetwork] --- Hyperswarm (P2P replication)
        |
   Other relay peers / Pear clients
```

- **EventStore** -- Autobase-backed Hyperbee with secondary indexes for kind, author, tags, and timestamps. Its `apply()` function is a versioned, deterministic consensus protocol: it re-verifies every event's structure and signature, scopes deletion tombstones to the deleter's own pubkey, and processes operator-approved `add_writer` admissions (capped at 64 writers, founder stays sole indexer).
- **SwarmNetwork** -- joins a Hyperswarm topic and replicates the Autobase over encrypted connections
- **WS Server** -- standard Nostr relay WebSocket interface (NIP-01, NIP-09, NIP-11, NIP-40, NIP-42, NIP-45). Protected events (NIP-70) are rejected, and writes are gated until this node is an admitted writer.

## Web of Trust

Enable WoT filtering to keep your relay focused on socially relevant content:

```bash
nostr-swarm --wot-pubkey <your-64-char-hex-pubkey>
```

The relay builds a trust graph from follow lists (kind 3) and mute lists (kind 10000), then filters events by social distance:

| Degree | Who | Kept for |
|--------|-----|----------|
| 0 | You | Forever |
| 1 | Direct follows | Forever |
| 2 | Follows-of-follows | 7 days |
| 3 | Third degree | 1 day |
| -- | Unknown (discovery) | 2 hours (cap: 5 events) |
| -- | Muted | Rejected |

See [Web of Trust](docs/web-of-trust.md) for full details on scoring, muting, discovery, and customization.

## Key Management with keytr

[keytr](https://github.com/sovITxyz/keytr) provides passkey-based Nostr private key management. Instead of copying nsec strings between devices, keytr encrypts your private key with a WebAuthn passkey (Face ID, fingerprint, or hardware key) and publishes the encrypted blob as a kind:30079 event to Nostr relays -- including nostr-swarm peers.

### How it works with nostr-swarm

1. **Register** -- keytr encrypts your nsec using a passkey and publishes a kind:30079 event to a writable (admitted) nostr-swarm node
2. **Store** -- every node sharing that relay's base replicates and stores the encrypted event
3. **Login** -- on any device with the synced passkey, fetch the event from any node of the base and decrypt your nsec

Since every node of a shared base replicates all of its events (including read-only joiners), your encrypted key blob is available from any of them -- no single relay dependency within the base.

### Setup

```bash
npm install @sovit.xyz/keytr
```

```typescript
import { setupKeytr, publishKeytrEvent } from '@sovit.xyz/keytr'
import { finalizeEvent } from 'nostr-tools'

// Generate a new nsec and encrypt it with a passkey
const { credential, encryptedBlob, eventTemplate, nsecBytes, npub } = await setupKeytr({
  userName: 'alice',
  userDisplayName: 'Alice',
})

// Publish the encrypted key event to your nostr-swarm relay
const signedEvent = finalizeEvent(eventTemplate, nsecBytes)
await publishKeytrEvent(signedEvent, ['ws://localhost:3000'])
```

### Login from another device

```typescript
import { loginWithKeytr, fetchKeytrEvents } from '@sovit.xyz/keytr'

// Fetch your encrypted key event from the swarm relay
const events = await fetchKeytrEvents(pubkey, ['ws://localhost:3000'])

// Authenticate with your passkey to decrypt
const { nsecBytes, npub } = await loginWithKeytr(events)
```

### NIP-07 signing with keytr-connect

[keytr-connect](https://github.com/sovITxyz/keytr-connect) bridges keytr to any Nostr client that supports `window.nostr` (NIP-07):

```typescript
import { KeytrProvider } from '@sovit.xyz/keytr-connect'

const provider = new KeytrProvider({
  relayUrls: ['ws://localhost:3000'],
  rpId: 'keytr.org'
})

await provider.signup({ userName: 'alice', userDisplayName: 'Alice' })
provider.install() // Sets window.nostr -- clients can now sign events via passkey
```

### Backup and recovery

Register backup passkeys on separate gateways (e.g., keytr.org and nostkey.org) so losing one device doesn't mean losing your key. See the [keytr docs](https://github.com/sovITxyz/keytr) for details on the federated gateway model and recovery flows.

## Documentation

- [Architecture](docs/architecture.md) -- Internal design, storage layer, replication, and protocol details
- [Client Architecture](docs/clients.md) -- How WebSocket clients and Pear Runtime clients connect and differ
- [Web of Trust](docs/web-of-trust.md) -- Trust graph filtering, scoring tiers, and pruning
- [Start9 Deployment](docs/start9.md) -- Packaging and running on StartOS

## Supported NIPs

- **NIP-01** -- Basic protocol flow (events, subscriptions, filters)
- **NIP-09** -- Event deletion (author-scoped: only the original author's deletions remove or block their events)
- **NIP-11** -- Relay information document
- **NIP-40** -- Expiration timestamp
- **NIP-42** -- Authentication
- **NIP-45** -- Event counts (COUNT)

**NIP-70 (protected events) is deliberately not supported.** A replicated multi-writer store cannot honor "don't propagate", so events carrying the `["-"]` tag are rejected at the WebSocket edge (`blocked: protected events (NIP-70) are not accepted by replicated relays`) and skipped by the consensus apply function -- never accept-then-drop. NIP-70 explicitly blesses rejection. This applies to single-node deployments too.

## License

MIT
