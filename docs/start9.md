# Start9 Deployment

nostr-swarm can be packaged as a Start9 (StartOS) service, turning any Start9 server into a sovereign always-on Nostr relay peer.

## What it does

A Start9 nostr-swarm node is a **full archive relay peer** that:

1. Stays connected to the Hyperswarm 24/7
2. Keeps a complete replica of all events on your swarm topic
3. Exposes a WebSocket endpoint for traditional Nostr clients (over Tor and LAN)
4. Acts as a reliable seed peer for phone and desktop Pear Runtime clients
5. Optionally filters events using Web of Trust

This is the "home base" in the nostr-swarm architecture. Phone clients are intermittent -- they sleep, lose connectivity, switch networks. Your Start9 box is always reachable, always replicating.

## Architecture on Start9

```
┌──────────────────────────────────────────┐
│              StartOS                      │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │      nostr-swarm container         │  │
│  │                                    │  │
│  │  ┌──────────┐  ┌───────────────┐  │  │
│  │  │ WS Server│  │ SwarmNetwork  │  │  │
│  │  │ :3000    │  │ (Hyperswarm)  │  │  │
│  │  └────┬─────┘  └───────┬───────┘  │  │
│  │       │                │          │  │
│  │  ┌────┴────────────────┴───────┐  │  │
│  │  │        EventStore           │  │  │
│  │  │   Autobase + Hyperbee       │  │  │
│  │  └─────────────┬───────────────┘  │  │
│  │                │                  │  │
│  │         /data volume              │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Tor ──► .onion:80 ──► container:3000    │
│  LAN ──► :443 (SSL) ──► container:3000   │
└──────────────────────────────────────────┘
```

## Package structure

```
start9/
  Dockerfile                          # Multi-stage Node.js 22 build
  Makefile                            # Build targets for s9pk packaging
  manifest.yaml                       # Service metadata, interfaces, volumes
  docker_entrypoint.sh                # Reads Start9 config, starts the relay
  instructions.md                     # User-facing docs (shown in StartOS UI)
  scripts/
    embassy.ts                        # Barrel file for all procedures
    procedures/
      getConfig.ts                    # Config form definition + current values
      setConfig.ts                    # Writes config to data volume
      health.ts                       # Health check (HTTP to NIP-11 endpoint)
      properties.ts                   # Dynamic properties for StartOS UI
      migrations.ts                   # Version migration logic
```

## Building the package

### Prerequisites

- Docker with buildx
- [start-sdk](https://github.com/Start9Labs/start-os) (Rust CLI tool)
- [Deno](https://deno.land/) (for bundling TypeScript procedures)
- [yq](https://github.com/mikefarah/yq) (YAML processor)

### Build

```bash
cd start9

# Build for all architectures
make

# Build for x86_64 only
make docker-images/x86_64.tar
make scripts/embassy.js
start-sdk pack

# Install to a local StartOS device
make install
```

This produces `nostr-swarm.s9pk` which can be sideloaded into StartOS or submitted to the Start9 marketplace.

## Configuration

All configuration is managed through the StartOS UI. The config form includes:

| Setting | Description | Default |
|---------|-------------|---------|
| Relay Name | Public name for NIP-11 | `nostr-swarm` |
| Relay Description | Public description | `A peer-to-peer Nostr relay over Hyperswarm` |
| Admin Contact | Your contact info | (empty) |
| Admin Pubkey | Your 64-char hex Nostr pubkey | (empty) |
| Swarm Topic | Peer discovery topic | `nostr` |
| WoT Owner Pubkey | Enable WoT filtering (your pubkey) | (empty -- disabled) |
| WoT Depth | Trust graph hops | `3` |
| Max Message Size | Max event size in bytes | `131072` |
| Max Subscriptions | Per-connection subscription limit | `20` |
| Event Rate | Events/sec rate limit | `10` |
| Request Rate | REQs/sec rate limit | `20` |

Config changes trigger a service restart (SIGTERM + relaunch).

## Networking

### Tor (default)

StartOS automatically creates a `.onion` address for the relay. External port 80 maps to the container's port 3000. Nostr clients connect via:

```
ws://<onion-address>.onion
```

### LAN

StartOS terminates SSL on port 443 and forwards to the container's port 3000. Nostr clients on the local network connect via:

```
wss://<start9-hostname>.local
```

### Hyperswarm

The relay also joins the Hyperswarm DHT for peer-to-peer replication. This works automatically -- Hyperswarm handles NAT hole-punching. No port forwarding configuration needed.

## Storage

All data is stored in the `/data` volume, which maps to a persistent StartOS volume. This includes:

- The Corestore (all Hypercores -- your write log + replicas of peers)
- The Autobase state and materialized Hyperbee view
- The Start9 config file

Backups are handled by StartOS's built-in backup system using duplicity. A full backup captures the entire data volume, so restoring a backup restores the relay to its exact prior state.

## Health checks

The health check procedure makes an HTTP request to the relay's NIP-11 endpoint (`Accept: application/nostr+json`). If the relay responds with a 200 status, the service is healthy. StartOS shows this status in the UI.

## Connecting clients

Once running, add your relay to any Nostr client:

- **Tor**: Use the `.onion` address shown in your StartOS service properties
- **LAN**: Use `wss://<hostname>.local`
- **Pear Runtime**: Phone/desktop Pear clients sync directly via Hyperswarm -- they discover your Start9 box automatically on the same swarm topic

## Peering with other Start9 nodes

Multiple Start9 users can run nostr-swarm on the **same swarm topic** to form a private peer-to-peer relay network. Each node:

1. Discovers other nodes via the Hyperswarm DHT
2. Replicates all events over encrypted connections
3. Converges to the same database state via Autobase

No manual peering configuration needed -- just use the same topic string.

For a private group relay, choose a unique topic:

```
Swarm Topic: my-family-2026
```

All nodes using `my-family-2026` will find each other and share events. Nodes on different topics are completely isolated.
