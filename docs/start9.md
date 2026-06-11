# Start9 Deployment

nostr-swarm can be packaged as a Start9 (StartOS) service, turning any Start9 server into a sovereign always-on Nostr relay peer.

## What it does

A Start9 nostr-swarm node is a **full archive relay peer** that:

1. Stays connected to the Hyperswarm 24/7
2. Founds its own shared event store (base), or joins another relay's by pasting that relay's `nsw1…` invite into the **Bootstrap Key (Invite)** config field
3. Keeps a complete replica of all events in its base
4. Exposes a WebSocket endpoint for traditional Nostr clients (over Tor and LAN) -- full reads always; writes once the node is an admitted writer (a founder is born writable; a joiner must be admitted by an existing writer's operator)
5. Acts as a reliable seed peer for phone and desktop Pear Runtime clients that hold the same invite
6. Optionally filters events using Web of Trust

This is the "home base" in the nostr-swarm architecture. Phone clients are intermittent -- they sleep, lose connectivity, switch networks. Your Start9 box is always reachable, always replicating. If it founds the base it is also the base's sole indexer, so keep backups (see Storage below).

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
| Bootstrap Key (Invite) | Another relay's `nsw1…` invite (or 64-hex base key) to **join** its shared event store; leave empty to **found** a new one. Set once: after first start the store identity is pinned to the data volume | (empty -- found) |
| Admit Writers | Comma-separated 64-hex writer keys to admit as writers. Paste a joiner's Local Writer Key here; already-admitted keys are skipped, so entries can stay in place | (empty) |
| WoT Owner Pubkey | Enable WoT filtering (your pubkey) | (empty -- disabled) |
| WoT Depth | Trust graph hops | `3` |
| Max Message Size | Max event size in bytes | `131072` |
| Max Subscriptions | Per-connection subscription limit | `20` |
| Event Rate | Events/sec rate limit | `10` |
| Request Rate | REQs/sec rate limit | `20` |

Config changes trigger a service restart (SIGTERM + relaunch) -- which is exactly how Admit Writers takes effect: save the config, the service restarts, and the admission is appended on startup.

The service properties expose two copyable values read from `keys.json`: **Relay Invite** (share with operators/clients who should join your store) and **Local Writer Key** (send to an existing writer's operator to get write access when you joined someone else's store).

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
- `bootstrap-key` (pins this volume to its base) and `keys.json` (the invite + writer key shown in properties)
- The Start9 config file

Backups are handled by StartOS's built-in backup system using duplicity. A full backup captures the entire data volume, so restoring a backup restores the relay to its exact prior state. If your node **founded** its store, it is the sole indexer for every peer that joined -- losing it stalls checkpointing for the whole group (writes still merge, but cold joins slow down), so backups of a founder are operationally critical.

## Health checks

The health check procedure makes an HTTP request to the relay's NIP-11 endpoint (`Accept: application/nostr+json`). If the relay responds with a 200 status, the service is healthy. StartOS shows this status in the UI.

## Connecting clients

Once running, add your relay to any Nostr client:

- **Tor**: Use the `.onion` address shown in your StartOS service properties
- **LAN**: Use `wss://<hostname>.local`
- **Pear Runtime**: Phone/desktop Pear clients discover your Start9 box automatically on the same swarm topic, but to replicate your data they also need your **Relay Invite** (copy it from the service properties into the client). They are read-mostly peers: they sync your store locally and publish through your WebSocket endpoint.

## Peering with other Start9 nodes

Multiple Start9 users can form a private peer-to-peer relay network that converges on one shared event store. The topic gets nodes *connected*; sharing one base is an explicit invite-and-admit workflow:

1. **Pick a founder.** Exactly one node leaves **Bootstrap Key (Invite)** empty -- it founds the shared store. Everyone uses the same Swarm Topic so the nodes can find each other.
2. **Share the invite.** The founder's operator copies **Relay Invite** (`nsw1…`) from their service properties and sends it to the other operators.
3. **Join.** Each joining operator pastes the invite into **Bootstrap Key (Invite)** and saves. Their node restarts, replicates the store, and serves reads immediately -- but is read-only for now.
4. **Admit.** Each joiner copies their **Local Writer Key** from their own service properties and sends it to the founder's operator (or any already-admitted writer's operator), who pastes it into **Admit Writers** and saves. The config restart performs the admission; the joiner becomes writable automatically once it replicates -- no action on the joiner's side.

Notes:

- Nodes on the same topic but different bases exchange connections, not data. A node that founded its own store cannot be re-pointed at another one: the data volume is pinned to its base (a changed bootstrap key is a fatal startup error). To merge an already-populated node into another store, use the `export`/`import` CLI tooling on a fresh volume.
- Writer admission is operator-vetted on purpose: any writer can admit, writers are capped at 64 per store, and re-saving the same Admit Writers list is harmless (duplicates are skipped).

For a private group relay, choose a unique topic:

```
Swarm Topic: my-family-2026
```

All nodes using `my-family-2026` will find each other; those that share the founder's invite converge on the same events. Nodes on different topics are completely isolated.
