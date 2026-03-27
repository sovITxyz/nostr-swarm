# nostr-swarm

A fully peer-to-peer Nostr relay that syncs events over Hyperswarm. Every peer is equal -- no central server required.

Built on the [Holepunch](https://holepunch.to) stack: Hyperswarm for connectivity, Autobase for multi-writer consensus, and Hyperbee for indexed storage.

## How it works

- Peers join a shared Hyperswarm topic and replicate a Corestore over encrypted connections
- Autobase linearizes writes from all peers into a deterministic Hyperbee view
- Every peer sees the same data -- events, indexes, deletions -- regardless of join order
- A WebSocket server exposes the standard Nostr relay protocol (NIP-01) for traditional clients
- Pear Runtime apps can connect directly over Hyperswarm with no WebSocket layer

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
# Run with defaults (port 3000, storage ./nostr-swarm-data)
nostr-swarm

# Custom options
nostr-swarm --port 4000 --storage ./data --topic my-relay

# Development (from source)
npm run dev
```

### CLI options

```
-p, --port <number>         WebSocket port (default: 3000)
-s, --storage <path>        Storage directory (default: ./nostr-swarm-data)
-t, --topic <name>          Swarm topic (default: nostr)
    --relay-name <name>     Relay name for NIP-11
    --relay-contact <addr>  Admin contact for NIP-11
    --wot-pubkey <hex>      Owner pubkey for Web of Trust filtering
    --wot-depth <number>    Max WoT hops (default: 3)
    --light-client          Enable light client mode (WoT + pruning)
    --no-discovery          Disable discovery tier for unknown pubkeys
    --discovery-ttl <secs>  TTL for discovery events (default: 7200)
    --discovery-max-events <n>  Max events per unknown pubkey (default: 5)
-v, --verbose               Enable debug logging
-h, --help                  Show help
```

### Environment variables

All config can also be set via environment variables:

| Variable | Description | Default |
|---|---|---|
| `WS_PORT` | WebSocket port | `3000` |
| `WS_HOST` | Bind address | `0.0.0.0` |
| `STORAGE_PATH` | Data directory | `./nostr-swarm-data` |
| `SWARM_TOPIC` | Swarm topic name | `nostr` |
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
| `LIGHT_MAX_STORAGE` | Max storage before pruning (bytes) | `524288000` |
| `LIGHT_PRUNE_MS` | Pruning interval (ms) | `600000` |

## Deployment

### Peer-to-peer (native)

Since nostr-swarm uses Hyperswarm for NAT hole-punching, every node is a peer -- no server infrastructure, TLS, or reverse proxy required. Just run the process:

```bash
nostr-swarm --topic my-relay --storage /var/lib/nostr-swarm
```

Multiple nodes joining the same topic will automatically discover each other and replicate.

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

Your Start9 node becomes an always-on relay peer with Tor and LAN access. It automatically discovers and replicates with other peers on the same swarm topic.

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

Pear apps connect directly to the swarm -- no WebSocket layer, no server. Each Pear client is a full peer that replicates the Autobase.

```js
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import { createHash } from 'crypto'

const store = new Corestore('./pear-nostr-data')
const swarm = new Hyperswarm()

// Same topic derivation as the relay
const topic = createHash('sha256').update('nostr-swarm:nostr').digest()

// Join and replicate
swarm.on('connection', (socket) => store.replicate(socket))
swarm.join(topic, { server: true, client: true })

// Open the shared Autobase view
const base = new Autobase(store, bootstrapKey, {
  open: (store) => new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  }),
  apply,
  valueEncoding: 'json',
})
await base.ready()

// Now read/write Nostr events through base.view (Hyperbee)
```

The bootstrap key from the first Autobase instance needs to be shared so peers can join the same multi-writer base. This can be passed as config or discovered over the swarm protocol.

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

- **EventStore** -- Autobase-backed Hyperbee with secondary indexes for kind, author, tags, and timestamps
- **SwarmNetwork** -- joins a Hyperswarm topic and replicates the Corestore over encrypted connections
- **WS Server** -- standard Nostr relay WebSocket interface (NIP-01, NIP-09, NIP-11, NIP-40, NIP-42, NIP-70)

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

## Documentation

- [Architecture](docs/architecture.md) -- Internal design, storage layer, replication, and protocol details
- [Client Architecture](docs/clients.md) -- How WebSocket clients and Pear Runtime clients connect and differ
- [Web of Trust](docs/web-of-trust.md) -- Trust graph filtering, scoring tiers, and pruning
- [Start9 Deployment](docs/start9.md) -- Packaging and running on StartOS

## Supported NIPs

- **NIP-01** -- Basic protocol flow (events, subscriptions, filters)
- **NIP-09** -- Event deletion
- **NIP-11** -- Relay information document
- **NIP-40** -- Expiration timestamp
- **NIP-42** -- Authentication
- **NIP-70** -- Protected events

## License

MIT
