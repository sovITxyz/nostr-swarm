# nostr-swarm Architecture

This document describes the internal architecture of nostr-swarm: how events flow through the system, how peers replicate data, how the storage layer indexes and queries events, and how the whole thing fits together for both WebSocket clients and native Pear Runtime apps.

## Overview

nostr-swarm is a Nostr relay where every instance is a peer, not a server. There is no central coordinator. Multiple relay nodes join a shared Hyperswarm topic, replicate their Corestore over encrypted peer-to-peer connections, and Autobase linearizes all writes into a single deterministic Hyperbee view. The result is that every peer ends up with the same indexed database of Nostr events, regardless of join order or network partitions.

On top of the P2P layer, each node also runs a standard WebSocket server that speaks the Nostr relay protocol (NIP-01), so existing Nostr clients can connect over `ws://` or `wss://` without knowing anything about Hyperswarm.

```
┌──────────────────────────────────────────────────────────┐
│                      NostrSwarm                          │
│                     (src/relay.ts)                        │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ RelayServer  │  │  EventStore  │  │ SwarmNetwork  │  │
│  │  (ws/)       │  │  (storage/)  │  │  (swarm/)     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  │
│         │                 │                  │           │
│         │    ┌────────────┴──────────┐       │           │
│         │    │       Autobase        │       │           │
│         │    │  (multi-writer CRDT)  │       │           │
│         │    └────────────┬──────────┘       │           │
│         │                 │                  │           │
│         │    ┌────────────┴──────────┐       │           │
│         │    │       Hyperbee        │       │           │
│         │    │  (indexed B-tree)     │       │           │
│         │    └────────────┬──────────┘       │           │
│         │                 │                  │           │
│         │    ┌────────────┴──────────┐       │           │
│         │    │       Corestore       │◄──────┘           │
│         │    │  (hypercore storage)  │  replicates over  │
│         │    └───────────────────────┘  swarm sockets    │
│         │                                                │
│    WebSocket clients                Hyperswarm peers     │
│    (Nostr NIP-01)                   (Pear apps, other    │
│                                      relay nodes)        │
└──────────────────────────────────────────────────────────┘
```

## Startup sequence

The `NostrSwarm` class (`src/relay.ts`) orchestrates startup:

1. **EventStore.ready()** -- Opens the Corestore, initializes the Autobase with its linearized Hyperbee view, and creates all sub-database indexes. The Autobase key is generated on first run and persisted in the Corestore. If light client mode is enabled, `LightStore.ready()` wraps this step and also builds the initial WoT graph.

2. **WoT graph build** (optional) -- If `WOT_OWNER_PUBKEY` is set, the `WotGraph` scans kind 3 and kind 10000 events to build the trust graph via BFS from the owner pubkey. Periodic refresh begins (default: every 5 minutes). See [Web of Trust](web-of-trust.md) for details.

3. **RelayServer.start()** -- Starts an HTTP server on the configured port/host. The HTTP server serves NIP-11 relay information on `GET` with `Accept: application/nostr+json`, and upgrades WebSocket connections for the Nostr relay protocol.

4. **SwarmNetwork.start()** -- Derives a topic buffer from `sha256("nostr-swarm:" + topic)`, joins the Hyperswarm DHT as both server and client, and begins accepting peer connections. Every incoming peer socket is handed to `corestore.replicate(socket)`.

Shutdown is the reverse: stop WoT refresh, close all WebSocket connections, leave the swarm, close the Autobase and Corestore.

## The Holepunch stack

nostr-swarm builds on four Holepunch primitives. Understanding their roles is key to understanding the system.

### Corestore

`Corestore` manages a collection of Hypercores (append-only logs) under a single storage directory. Each peer has its own writable Hypercore for appending operations, plus read-only replicas of other peers' cores. When two peers connect, `corestore.replicate(socket)` handles the entire replication protocol -- exchanging core keys, syncing missing blocks, and verifying integrity via Merkle trees.

Storage path is configured via `--storage` or `STORAGE_PATH` (default: `./nostr-swarm-data`).

### Autobase

`Autobase` sits on top of Corestore and solves the multi-writer problem. Each peer appends operations (`put` or `delete`) to their own local Hypercore. Autobase reads all peers' cores, applies a deterministic linearization algorithm, and feeds the ordered operations into an `apply` function that builds the materialized view.

The critical property: **every peer running the same apply function on the same set of inputs produces the exact same view**, regardless of the order they received the data. This is what makes the system eventually consistent without any coordination protocol.

Configuration in `src/storage/store.ts`:

```typescript
this.base = new Autobase(this.corestore, bootstrap, {
  open: (store) => new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  }),
  apply: this.apply.bind(this),
  valueEncoding: 'json',
  ackInterval: 1000,  // ack every second to advance the view
})
```

- **open** -- Creates the materialized view. In our case, a Hyperbee (sorted B-tree over a Hypercore).
- **apply** -- The deterministic function that processes linearized operations and writes to the view.
- **ackInterval** -- How often this peer acknowledges it has seen the latest state. Acks are themselves operations that advance the linearization.
- **bootstrap** -- The key of the first Autobase instance. Other peers need this to join the same multi-writer base.

### Hyperbee

`Hyperbee` is a sorted key-value B-tree built on top of a Hypercore. It supports `get`, `put`, `del`, range scans via `createReadStream`, and sub-databases via `sub()`. All keys are UTF-8 strings, all values are JSON.

nostr-swarm uses Hyperbee sub-databases extensively for indexing (see Storage section below).

### Hyperswarm

`Hyperswarm` is a DHT-based networking layer that handles peer discovery and NAT hole-punching. Peers join a topic (a 32-byte hash), and the DHT connects them directly -- no relay server, no TURN, no central infrastructure. All connections are encrypted with the Noise protocol.

Topic derivation in `src/swarm/network.ts`:

```typescript
this.topicBuffer = createHash('sha256')
  .update(`nostr-swarm:${topic}`)
  .digest()
```

The default topic string is `"nostr"`, so the default topic hash is `sha256("nostr-swarm:nostr")`. Any peer (relay node or Pear client) that joins the same topic hash will discover and connect to other peers on that topic.

## Storage layer

### EventStore (`src/storage/store.ts`)

The EventStore wraps Autobase and exposes two write operations:

- **putEvent(event)** -- Appends a `{ type: 'put', event }` operation to the local Hypercore.
- **deleteEvent(event)** -- Appends a `{ type: 'delete', event }` operation (for NIP-09 kind 5 deletion events).

These operations are not applied immediately. They go into the local append-only log and are linearized by Autobase across all peers. The `apply` function is called with batches of linearized operations.

The EventStore also emits `event:stored` when a new event is committed to the view. The WebSocket handler listens for this to push live subscription updates to connected clients.

### The apply function

The apply function (`EventStore.apply`) is the core of the consensus model. It receives an ordered batch of operations from Autobase's linearization and writes to the Hyperbee view:

```
Operations from all peers
        │
        ▼
┌─────────────────┐
│   Autobase       │
│  linearization   │
└────────┬────────┘
         │ ordered batch
         ▼
┌─────────────────┐
│  apply function  │──► Hyperbee view (10 sub-databases)
└─────────────────┘
```

For each operation in the batch:

**Put operations:**
1. **Dedup** -- Skip if an event with this ID already exists in the events sub-db.
2. **Deletion check** -- Skip if this event ID was previously marked as deleted.
3. **Replaceable handling** (kinds 0, 3, 10000-19999) -- Check if a newer event already exists for this pubkey+kind. If the incoming event is newer, remove the old event's indexes and update the replaceable pointer.
4. **Addressable handling** (kinds 30000-39999) -- Same as replaceable, but keyed by pubkey+kind+d-tag.
5. **Ephemeral skip** (kinds 20000-29999) -- Ephemeral events are never stored.
6. **Write event** to the primary events sub-db.
7. **Write secondary indexes** -- kind, author, author+kind, created_at, tags, expiration.

**Delete operations** (NIP-09):
1. For each `e` tag in the kind 5 deletion event, look up the target event.
2. Only the original author can delete their events (pubkey check).
3. Remove the target event and all its secondary indexes.
4. Record the deletion in the deletion sub-db (prevents the deleted event from being re-inserted by a late-arriving peer).
5. Store the deletion event itself as a regular event.

### Index schema

The Hyperbee view is divided into 10 sub-databases, each a separate key-value namespace:

| Sub-database | Key format | Value | Purpose |
|---|---|---|---|
| `events` | `event_id` | Full event JSON | Primary store |
| `kind` | `kind!inv_time!event_id` | `event_id` | Filter by kind |
| `author` | `pubkey!inv_time!event_id` | `event_id` | Filter by author |
| `author_kind` | `pubkey!kind!inv_time!event_id` | `event_id` | Filter by author+kind |
| `tag` | `tag_name!tag_value!inv_time!event_id` | `event_id` | Filter by tag (#e, #p, etc.) |
| `created_at` | `inv_time!event_id` | `event_id` | Global time scan |
| `replaceable` | `pubkey!kind` | `event_id` | Latest replaceable event |
| `addressable` | `pubkey!kind!d_tag` | `event_id` | Latest addressable event |
| `expiration` | `inv_expiry!event_id` | `event_id` | NIP-40 expiration tracking |
| `deletion` | `event_id` | `kind5_event_id` | Deletion tombstones |

### Key encoding (`src/util/keys.ts`)

Keys are composite UTF-8 strings with `!` (0x21) as the separator. This separator is chosen because it sorts before all hex characters (0-9, a-f) in lexicographic order, ensuring clean prefix scans.

**Inverted timestamps** are used throughout: `0xFFFFFFFF - created_at`, zero-padded to 8 hex chars. This makes Hyperbee's lexicographic sort order equivalent to newest-first, which is what Nostr clients expect (most recent events first).

**Kind encoding** uses the same 8-char hex padding: `kind.toString(16).padStart(8, '0')`.

Example keys:
```
events:     "abc123def456..."           → full event JSON
kind:       "00000001!ff1a2b3c!abc..."  → kind 1, inverted timestamp, event ID
author:     "deadbeef...!ff1a2b3c!abc..." → pubkey, inverted timestamp, event ID
tag:        "p!deadbeef...!ff1a2b3c!abc..." → tag 'p', value, inv time, event ID
created_at: "ff1a2b3c!abc..."           → inverted timestamp, event ID
```

### Query engine (`src/storage/query.ts`)

The query engine implements NIP-01 filter semantics. It chooses the most selective index for each filter to minimize scanning:

1. **IDs provided** -- Direct lookup in the events sub-db. O(1) per ID.
2. **Authors + kinds** -- Scan the author_kind compound index. Most selective for targeted queries.
3. **Authors only** -- Scan the author index.
4. **Kinds only** -- Scan the kind index.
5. **Tag filters** -- Scan the tag index using the first tag filter as the primary.
6. **Fallback** -- Scan the global created_at index.

For each strategy, the engine:
- Computes range bounds (gte/lt) from the prefix and optional since/until time window
- Streams entries from the secondary index
- Resolves each event ID back to the full event from the events sub-db
- Post-filters against the full filter (to handle conditions not covered by the chosen index)
- Stops at the limit

Multiple filters in a single REQ are OR'd together, with deduplication by event ID. Final results are sorted newest-first.

## WebSocket layer

### Server (`src/ws/server.ts`)

The RelayServer wraps a Node.js HTTP server with a `ws` WebSocket server. It handles two protocols:

- **HTTP GET** with `Accept: application/nostr+json` -- Returns the NIP-11 relay information document (relay name, description, supported NIPs, limitations).
- **WebSocket upgrade** -- Creates a `Connection` object and wires it to the `MessageHandler`.

### Connection (`src/ws/connection.ts`)

Each WebSocket connection gets a `Connection` instance that tracks:

- **id** -- Random 16-hex-char identifier for logging.
- **subscriptions** -- A `Map<string, NostrFilter[]>` of active subscriptions (subscription ID to filter list).
- **eventLimiter / reqLimiter** -- Token bucket rate limiters. EVENT messages get `eventRatePerSec` tokens/sec with burst of 2x. REQ messages get `reqRatePerSec` tokens/sec with burst of 2x.
- **authPubkey** -- Set after successful NIP-42 authentication. `null` until then.
- **challenge** -- Random 32-hex-char NIP-42 challenge sent on connection.

The Connection also provides typed `send*` methods for all relay-to-client message types: `sendOk`, `sendEvent`, `sendEose`, `sendClosed`, `sendNotice`, `sendCount`, `sendAuth`.

### Message handler (`src/ws/handler.ts`)

The MessageHandler processes all client-to-relay messages:

**EVENT** -- The full event ingestion pipeline:
1. Rate limit check (token bucket)
2. Structural validation (correct field types and lengths)
3. Schnorr signature verification via `nostr-tools`
4. NIP-40 expiration check (reject already-expired events)
5. NIP-70 protected event check (require AUTH for events with `-` tag)
6. Kind classification:
   - Ephemeral (20000-29999): broadcast to matching subscriptions but don't store
   - Deletion (kind 5): route to `store.deleteEvent()`
   - All others: route to `store.putEvent()`
7. Send OK response

**REQ** -- Subscription creation:
1. Rate limit check
2. Validate subscription ID (string, 1-64 chars)
3. Check subscription count limit
4. Validate all filter objects
5. Store subscription for live updates
6. Query the EventStore for matching stored events
7. Send all matching events, then EOSE

**CLOSE** -- Remove a subscription by ID.

**COUNT** -- Like REQ but returns a count instead of events (NIP-45).

**AUTH** -- NIP-42 authentication:
1. Validate kind 22242 event structure
2. Verify Schnorr signature
3. Check challenge tag matches the one sent on connection
4. Check relay tag is present
5. Check created_at is within 10 minutes
6. Set `conn.authPubkey` on success

### Live subscriptions

When a new event is committed to the Autobase view, the EventStore emits `event:stored`. The MessageHandler listens for this and iterates all connections and their subscriptions, sending the event to any subscription whose filters match. This delivers real-time updates for events written by any peer, not just local WebSocket clients.

## Rate limiting (`src/util/rate-limit.ts`)

Rate limiting uses a token bucket algorithm:

- Each bucket has a **capacity** (max burst) and a **refill rate** (tokens per second).
- Tokens refill continuously based on elapsed time since last check.
- Each operation consumes one token. If the bucket is empty, the request is rejected.

Default rates (configurable via env vars):
- EVENT: 10/sec with burst of 20
- REQ: 20/sec with burst of 40

Rate limiting is per-connection, not per-IP or per-pubkey.

## Nostr protocol support

### NIP-01: Basic protocol

Full implementation of the Nostr relay protocol: EVENT, REQ, CLOSE, OK, EOSE, NOTICE, CLOSED messages. Filters support ids, authors, kinds, since, until, limit, and single-letter tag filters (#e, #p, etc.).

### NIP-09: Event deletion

Kind 5 events reference target events via `e` tags. The relay:
- Only allows the original author to delete their events (pubkey must match)
- Removes the target event and all its secondary indexes
- Records a tombstone in the deletion sub-db to prevent re-insertion
- Stores the deletion event itself

### NIP-11: Relay information

HTTP GET with `Accept: application/nostr+json` returns a JSON document with relay metadata, supported NIPs, and limitations (max message size, max subscriptions, max filters).

### NIP-40: Expiration

Events with an `expiration` tag are:
- Rejected on ingestion if already expired
- Indexed in the expiration sub-db for future cleanup
- Filtered at query time (v1 approach; periodic cleanup is stubbed for a future version)

### NIP-42: Authentication

Challenge-response authentication:
1. Relay sends `["AUTH", challenge]` on connection
2. Client signs a kind 22242 event with the challenge and relay URL
3. Relay verifies the signature, challenge, relay tag, and timestamp
4. On success, the connection's `authPubkey` is set

Authentication is optional -- it's only required for submitting NIP-70 protected events.

### NIP-70: Protected events

Events with a `-` tag can only be submitted by authenticated connections where `authPubkey` matches `event.pubkey`. This prevents unauthorized relays from replaying protected events.

## Peer-to-peer replication

### How peers sync

When two peers connect over Hyperswarm:

1. Hyperswarm handles peer discovery via the DHT and establishes an encrypted Noise protocol connection.
2. The socket is passed to `corestore.replicate(socket)`.
3. Corestore exchanges Hypercore keys and begins syncing all cores:
   - Each peer's local writable core (their append-only operation log)
   - The Autobase view core
   - Any other cores managed by the Autobase
4. As new blocks arrive, Autobase detects changes and re-linearizes.
5. The apply function runs on the new operations, updating the Hyperbee view.
6. The EventStore emits `event:stored` for any newly visible events.
7. The MessageHandler pushes those events to matching WebSocket subscriptions.

This means a WebSocket client connected to peer A will receive events that were originally submitted to peer B, with no explicit forwarding -- the data flows through Autobase replication.

### Bootstrap key problem

The first Autobase instance generates a key that identifies the multi-writer base. Other peers need this key to join the same base. Currently, this must be configured manually (passed as the `bootstrap` parameter to `EventStore`).

The `src/swarm/protocol.ts` module is a placeholder for a future protocol extension that could handle key discovery over the swarm -- for example, announcing the Autobase bootstrap key to peers that join the topic.

### Pear Runtime integration

A Pear Runtime app is a full peer, identical to a relay node from the replication perspective. It:

1. Opens its own Corestore
2. Joins the same Hyperswarm topic (`sha256("nostr-swarm:" + topic)`)
3. Replicates with all peers on the topic
4. Opens the same Autobase with the shared bootstrap key
5. Reads and writes events through the Hyperbee view

The Pear client does not need the WebSocket layer, the HTTP server, the NIP-11 endpoint, or any of the rate limiting. It operates directly on the shared data structure. It can use the same apply function and index schema, or implement its own read-only view optimized for its UI.

```
┌─────────────────────┐         ┌─────────────────────┐
│    Relay Node A      │         │    Relay Node B      │
│                      │         │                      │
│  WS ◄─► EventStore  │◄───────►│  EventStore ◄─► WS  │
│         Autobase     │ Swarm   │  Autobase            │
│         Corestore    │         │  Corestore           │
└──────────┬──────────┘         └──────────┬──────────┘
           │                               │
           │         Hyperswarm DHT        │
           │                               │
     ┌─────┴───────────────────────────────┴─────┐
     │                                           │
┌────┴────────────────┐         ┌────────────────┴───┐
│   Pear Client X      │         │   Pear Client Y     │
│                      │         │                      │
│  UI ◄─► Autobase    │◄───────►│  Autobase ◄─► UI   │
│         Corestore    │ Swarm   │  Corestore           │
└──────────────────────┘         └──────────────────────┘
```

All four nodes replicate the same Autobase. An event written by Pear Client X will appear on Relay Node B's WebSocket interface, and vice versa.

## Event kind classification

Nostr event kinds are classified into four categories that determine storage and replacement behavior:

| Category | Kind range | Behavior |
|---|---|---|
| Regular | 1, 2, 4-9999 | Stored permanently, no replacement |
| Replaceable | 0, 3, 10000-19999 | One per pubkey+kind, newer replaces older |
| Ephemeral | 20000-29999 | Never stored, broadcast only |
| Addressable | 30000-39999 | One per pubkey+kind+d-tag, newer replaces older |

Replacement tiebreaker: if two events have the same `created_at`, the one with the lexicographically lower `id` wins.

## Web of Trust

nostr-swarm includes an optional Web of Trust (WoT) module that filters events based on social graph distance from a configured owner pubkey. Full documentation is in [Web of Trust](web-of-trust.md). Summary:

- The `WotGraph` (`src/wot/graph.ts`) builds a trust graph from kind 3 (contact list) and kind 10000 (mute list) events via BFS from the owner pubkey.
- The `ReplicationPolicyEngine` (`src/wot/policy.ts`) evaluates each event: accept with a TTL, or reject.
- Trust decays with distance: direct follows are kept forever, follows-of-follows for 7 days, 3rd degree for 1 day, unknown pubkeys are rejected.
- Consensus muting: if 50%+ of your direct follows mute a pubkey, it's treated as muted.

WoT is enabled by setting `WOT_OWNER_PUBKEY`. It works in two modes:

- **Full relay mode** (default): WoT filters incoming events but the relay keeps everything it has already stored. Useful for spam prevention on always-on nodes.
- **Light client mode** (`LIGHT_CLIENT=true`): WoT filtering + periodic pruning. Events that exceed their trust tier TTL are removed. Designed for phones and constrained devices. See [Client Architecture](clients.md) for details.

## Configuration

All configuration flows through `src/util/config.ts`. Each setting has three layers of precedence:

1. **Environment variable** (highest priority)
2. **CLI flag / constructor override**
3. **Default value** (lowest priority)

| Setting | Env var | CLI flag | Default |
|---|---|---|---|
| WebSocket port | `WS_PORT` | `--port` | 3000 |
| Bind address | `WS_HOST` | -- | 0.0.0.0 |
| Storage path | `STORAGE_PATH` | `--storage` | ./nostr-swarm-data |
| Swarm topic | `SWARM_TOPIC` | `--topic` | nostr |
| Relay name | `RELAY_NAME` | `--relay-name` | nostr-swarm |
| Relay description | `RELAY_DESCRIPTION` | -- | A peer-to-peer Nostr relay over Hyperswarm |
| Admin contact | `RELAY_CONTACT` | `--relay-contact` | (empty) |
| Admin pubkey | `RELAY_PUBKEY` | -- | (empty) |
| Max message size | `MAX_MESSAGE_SIZE` | -- | 131072 (128 KB) |
| Max subscriptions | `MAX_SUBS` | -- | 20 |
| Max filters per REQ | `MAX_FILTERS` | -- | 10 |
| Event rate limit | `EVENT_RATE` | -- | 10/sec |
| REQ rate limit | `REQ_RATE` | -- | 20/sec |
| Expiration cleanup | `EXPIRATION_CLEANUP_MS` | -- | 60000 (1 min) |
| WoT owner pubkey | `WOT_OWNER_PUBKEY` | `--wot-pubkey` | (empty -- WoT disabled) |
| WoT max depth | `WOT_MAX_DEPTH` | `--wot-depth` | 3 |
| WoT refresh interval | `WOT_REFRESH_MS` | -- | 300000 (5 min) |
| Light client mode | `LIGHT_CLIENT` | `--light-client` | false |
| Light max storage | `LIGHT_MAX_STORAGE` | -- | 524288000 (500 MB) |
| Light prune interval | `LIGHT_PRUNE_MS` | -- | 600000 (10 min) |

## File map

```
src/
├── cli.ts                  Entry point (CLI argument parsing)
├── relay.ts                NostrSwarm orchestrator (startup/shutdown)
├── index.ts                Public API exports
├── ws/
│   ├── server.ts           HTTP + WebSocket server, NIP-11
│   ├── connection.ts       Per-connection state, rate limiters
│   └── handler.ts          Nostr message handling (EVENT/REQ/CLOSE/COUNT/AUTH)
├── storage/
│   ├── store.ts            EventStore (Autobase + apply function)
│   ├── indexes.ts          Hyperbee sub-database definitions
│   └── query.ts            Query engine (index selection, range scans)
├── swarm/
│   ├── network.ts          Hyperswarm connection + Corestore replication
│   └── protocol.ts         Swarm protocol extensions (placeholder)
├── wot/
│   ├── graph.ts            WoT trust graph (BFS, degree computation, muting)
│   ├── policy.ts           Replication policy engine (accept/reject, TTL)
│   └── index.ts            Barrel exports
├── light/
│   ├── store.ts            LightStore (WoT-filtered EventStore wrapper + pruning)
│   └── index.ts            Barrel exports
├── nostr/
│   ├── events.ts           Event validation, signature verification, classification
│   ├── filters.ts          Filter validation and matching
│   ├── nip-09.ts           Deletion helpers
│   ├── nip-11.ts           Relay info document builder
│   ├── nip-40.ts           Expiration helpers
│   ├── nip-42.ts           Authentication validation
│   └── nip-70.ts           Protected event helpers
├── util/
│   ├── types.ts            TypeScript interfaces (NostrEvent, NostrFilter, WotConfig, etc.)
│   ├── config.ts           Configuration loading (relay, WoT, light client)
│   ├── keys.ts             Hyperbee key encoding (inverted timestamps, composites)
│   ├── rate-limit.ts       Token bucket rate limiter
│   └── logger.ts           Structured logger
└── types/
    └── holepunch.d.ts      Type declarations for Holepunch modules

start9/                         Start9 (StartOS) service package
├── Dockerfile                  Multi-stage Node.js 22 build
├── Makefile                    Build targets for .s9pk packaging
├── manifest.yaml               Service metadata, interfaces, volumes
├── docker_entrypoint.sh        Reads config, sets env vars, starts relay
├── instructions.md             User-facing docs for StartOS UI
└── scripts/
    ├── embassy.ts              Barrel file for all procedures
    └── procedures/
        ├── getConfig.ts        Config form definition + current values
        ├── setConfig.ts        Writes config to data volume
        ├── health.ts           Health check (NIP-11 endpoint)
        ├── properties.ts       Dynamic properties for StartOS UI
        └── migrations.ts       Version migration logic
```
