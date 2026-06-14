# nostr-swarm Architecture

This document describes the internal architecture of nostr-swarm: how events flow through the system, how peers replicate data, how the storage layer indexes and queries events, and how the whole thing fits together for both WebSocket clients and native Pear Runtime apps.

## Overview

nostr-swarm is a Nostr relay where every instance is a peer, not a server. There is no central coordinator. One node per swarm (the **founder**) creates a multi-writer Autobase; every other node (a **joiner**) is configured with the founder's bootstrap key -- shared as a checksummed `nsw1…` invite -- and deterministically opens the same base. Peers discover each other on a shared Hyperswarm topic and replicate the base over encrypted peer-to-peer connections, and Autobase linearizes all admitted writers' operations into a single deterministic Hyperbee view. Every node of one base converges to the same indexed database of Nostr events; convergence holds by construction, independent of the runtime order in which nodes start or connect (a joiner may even start before the founder is reachable). Reads need no admission -- any replica fully materializes the view -- while write access is granted manually by the operator of any existing writer (`--admit`).

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

1. **Bootstrap resolution** (constructor) -- `resolveBootstrap(storagePath, config.bootstrap)` (`src/storage/bootstrap.ts`) runs before the EventStore exists. It parses the configured `nsw1…` invite or 64-hex base key (a malformed value is a fatal error -- never a silently re-founded empty node), checks it against `<storage>/bootstrap-key` (a mismatch with the recorded base is fatal), and returns the base key to open -- or `null`, which means this node founds a new base.

2. **EventStore.ready()** -- Opens the Corestore, initializes the Autobase (with the resolved bootstrap, or as founder) and its linearized Hyperbee view. On ready, the relay logs the invite (`nsw1…`), raw base key, and this node's writer key (`base.local.key`), records the base identity in `<storage>/bootstrap-key`, and writes `<storage>/keys.json` (surfaced by Start9 properties). If light client mode is enabled, `LightStore.ready()` wraps this step and also builds the initial WoT graph.

3. **Writer admissions** -- Each key in `config.admitWriters` (`--admit` / `ADMIT_WRITERS`) is appended as an `add_writer` op -- immediately if this node is already writable (founder or admitted writer), otherwise as soon as its own `'writable'` event fires. Already-admitted keys are skipped, so the flags are safe to leave in place.

4. **WoT graph build** (optional) -- If `WOT_OWNER_PUBKEY` is set, the `WotGraph` scans kind 3 and kind 10000 events to build the trust graph via BFS from the owner pubkey. Periodic refresh begins (default: every 5 minutes). See [Web of Trust](web-of-trust.md) for details.

5. **RelayServer.start()** -- Starts an HTTP server on the configured port/host. The HTTP server serves NIP-11 relay information on `GET` with `Accept: application/nostr+json`, and upgrades WebSocket connections for the Nostr relay protocol.

6. **SwarmNetwork.start()** -- Derives a topic buffer from `sha256("nostr-swarm:" + topic)`, joins the Hyperswarm DHT as both server and client, and begins accepting peer connections. Every incoming peer socket is handed to `store.base.replicate(socket)` -- replication goes through the Autobase (not the raw Corestore) so the protomux-wakeup protocol announces writer heads to the peer.

Shutdown is the reverse: stop WoT refresh, close all WebSocket connections, leave the swarm, close the Autobase and Corestore.

## The Holepunch stack

nostr-swarm builds on four Holepunch primitives. Understanding their roles is key to understanding the system.

### Corestore

`Corestore` manages a collection of Hypercores (append-only logs) under a single storage directory. Each peer has its own local Hypercore (writable into the base only once admitted), plus read-only replicas of other writers' cores. The Hypercore replication protocol -- exchanging core keys, syncing missing blocks, verifying integrity via Merkle trees -- runs over each peer socket; nostr-swarm drives it through `store.base.replicate(socket)` so Autobase can announce writer heads on the same connection.

Storage path is configured via `--storage` or `STORAGE_PATH` (default: `./nostr-swarm-data`).

### Autobase

`Autobase` sits on top of Corestore and solves the multi-writer problem. Each admitted writer appends operations (`put`, `delete`, or `add_writer`) to its own local Hypercore. Autobase reads all writers' cores, applies a deterministic linearization algorithm, and feeds the ordered operations into an `apply` function that builds the materialized view. Non-writers replicate the same cores and run the same apply, so they materialize the full view read-only.

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
  optimistic: true,   // enables self-verifying optimistic writes (v2; see below)
})
```

- **open** -- Creates the materialized view. In our case, a Hyperbee (sorted B-tree over a Hypercore).
- **apply** -- The deterministic function that processes linearized operations and writes to the view (see "The apply function" below -- it is a versioned consensus protocol).
- **ackInterval** -- How often the indexer acknowledges it has seen the latest state. Acks are themselves operations that advance the linearization.
- **bootstrap** -- The key of the founder's Autobase, resolved by `resolveBootstrap` from the configured invite or the `<storage>/bootstrap-key` file. `null` means this node founds a new base.
- **optimistic** -- Enables the v2 self-verifying-write path. A non-admitted peer (read invite only) may append a single optimistic block; `apply` accepts it only if it is a signature-valid `put`, the base's `accept_optimistic` consensus flag is set (founder `--accept-optimistic`), and it passes the normal put rules — then it is made durable via `host.ackWriter` **without** admitting the peer as a writer. With the flag off, optimistic blocks are rolled back, as in v1. It is constructor-gated because it cannot be retrofitted without a consensus bump.

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

The EventStore wraps Autobase and exposes its write operations:

- **putEvent(event)** -- Appends a `{ type: 'put', event }` operation to the local Hypercore.
- **deleteEvent(event)** -- Appends a `{ type: 'delete', event }` operation (for NIP-09 kind 5 deletion events).
- **admitWriter(keyHex)** -- Appends a `{ type: 'add_writer', key }` operation for an operator-approved joiner. Throws if this node is not writable; returns `'appended'`, `'already-admitted'`, or `'cap-reached'` as a fast pre-check (`apply()` is authoritative).

These operations are not applied immediately. They go into the local append-only log and are linearized by Autobase across all writers. The `apply` function is called with batches of linearized operations.

The EventStore also exposes the multi-writer surface: `writable` (can this node append?), `localWriterKey` (`base.local.key` -- what an operator sends out-of-band to get admitted), `isFounder`, and `listWriters()`. It re-emits the base's `'writable'` (this node's admission was applied -- no restart needed) and `'update'` events, and emits `event:stored` when a new event is committed to the view (deduped through a bounded 4096-id LRU, since reorgs re-run apply). The WebSocket handler listens for `event:stored` to push live subscription updates to connected clients.

### The apply function

The apply function (`EventStore.apply`) is the core of the consensus model -- a **versioned consensus protocol** (`CONSENSUS_VERSION = 1`). Every rule is deterministic and config-free, because all peers of one base re-run it over the same ops and must materialize identical views. All peers of one base must run the same software version; ops carrying a consensus version higher than the local one halt the node (`host.interrupt`) rather than diverge.

```
Operations from all writers
        │
        ▼
┌─────────────────┐
│   Autobase       │
│  linearization   │
└────────┬────────┘
         │ ordered batch
         ▼
┌─────────────────┐
│  apply function  │──► Hyperbee view (11 sub-databases)
└─────────────────┘
```

For each operation in the batch (null-valued ack nodes are skipped):

**Version gate** -- `op.v > CONSENSUS_VERSION` interrupts the node ("unsupported op version").

**Put operations:**
1. **Re-validation** -- `validateEventStructure` + `verifyEventSignature`, or the op is skipped. Replicated ops are never trusted: an admitted writer cannot bypass the WS-edge validation, so even a rogue writer can only inject validly signed Nostr events.
2. **NIP-70 skip** -- protected (`["-"]`-tagged) events are skipped unconditionally; a replicated store cannot honor "don't propagate".
3. **Dedup** -- Skip if an event with this ID already exists in the events sub-db.
4. **Tombstone check** -- Skip if this event ID has a tombstone *authored by the same pubkey*. Tombstones are `{ id: <kind5 id>, pubkey: <deleter> }`; a forged tombstone from another pubkey never censors a legitimate put, and delete-before-put ordering is safe. Legacy string tombstones (pre-multi-writer single-node data) block unconditionally, preserving old local behavior.
5. **Replaceable handling** (kinds 0, 3, 10000-19999) -- Check if a newer event already exists for this pubkey+kind. If the incoming event is newer, remove the old event's indexes and update the replaceable pointer.
6. **Addressable handling** (kinds 30000-39999) -- Same as replaceable, but keyed by pubkey+kind+d-tag.
7. **Ephemeral skip** (kinds 20000-29999) -- Ephemeral events are never stored.
8. **Write event** to the primary events sub-db.
9. **Write secondary indexes** -- kind, author, author+kind, created_at, tags, expiration.

**Delete operations** (NIP-09):
1. **Re-validation** -- the kind 5 event itself must be structurally valid and signed, or the op is skipped (this also drops legacy forged prune ops).
2. For each `e` tag, look up the target event. If stored, remove it (and its indexes) only when `target.pubkey === deletion.pubkey` -- only authors delete their own events.
3. **Always** record the tombstone `{ id, pubkey }` in the deletion sub-db; its blocking power is scoped to the deleter's own pubkey (see put rule 4).
4. Store the deletion event itself via the put path (re-validated there too).

**add_writer operations:**
1. The key must match `/^[0-9a-f]{64}$/` and not be the founder's own key (implicit, never in the sub).
2. Duplicates (already in the `writers` sub) are no-ops; the sub is capped at **64 writers**, enforced deterministically (the count is part of the view).
3. `host.addWriter(key, { indexer: false })` -- **every admission is a non-indexer**. The founder stays the sole indexer, so checkpoint/fast-forward liveness never depends on churny peers. The trade-off: founder loss stalls checkpoints (writes still merge; cold joins linearize slowly), which is why founder storage backups are operationally critical.
4. The admission is recorded in the `writers` sub as `{ addedBy: <appender's writer key> }`.

When the apply rules change (as they did when multi-writer shipped), already-materialized views are not retroactively rewritten: a joiner adopting a legacy founder's base relies on Autobase fast-forward (default on) to inherit the founder's signed view, and only the short un-indexed tail re-applies under the new rules. The cleanest shared bases start from a fresh founder.

`removeIndexes` deletes the replaceable/addressable pointer only when it still references the deleted event id -- deleting a superseded version must not orphan the pointer to its replacement.

### Index schema

The Hyperbee view is divided into 11 sub-databases, each a separate key-value namespace:

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
| `deletion` | `event_id` | `{ id: kind5_id, pubkey: deleter }` | Deletion tombstones (pubkey-scoped; legacy values are plain strings) |
| `writers` | `writer_key_hex` | `{ addedBy: writer_key_hex }` | Admitted writers (founder implicit, never listed) |

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
5. NIP-70 check: protected events (`-` tag) are rejected unconditionally -- a replicated store cannot honor "don't propagate"
6. Ephemeral kinds (20000-29999): broadcast to matching subscriptions but don't store
7. Read-only gate: if this node is not (yet) an admitted writer, reply `["OK", id, false, "blocked: read-only replica awaiting writer admission"]` -- reads (REQ/COUNT) are unaffected
8. Kind classification:
   - Deletion (kind 5): route to `store.deleteEvent()`
   - All others: route to `store.putEvent()`
9. Send OK response

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
- Records a tombstone `{ id, pubkey }` in the deletion sub-db; the tombstone blocks re-insertion only of events authored by the deleter's own pubkey (a forged tombstone cannot censor someone else's event)
- Stores the deletion event itself

### NIP-11: Relay information

HTTP GET with `Accept: application/nostr+json` returns a JSON document with relay metadata, supported NIPs, and limitations (max message size, max subscriptions, max filters).

### NIP-40: Expiration

Events with an `expiration` tag are:
- Rejected on ingestion if already expired
- Indexed in the expiration sub-db (keyed by expiry ascending) and filtered at query time
- Reclaimed from storage by a periodic founder job (v2): it range-scans the expiration sub for passed expiries and appends founder-authored `expiry_delete` consensus ops, so every peer converges. apply has no wall-clock, so the "is it expired" judgment is the founder's; apply only honors a present op and only for events that actually declared an expiration (so it cannot censor).

### NIP-42: Authentication

Challenge-response authentication:
1. Relay sends `["AUTH", challenge]` on connection
2. Client signs a kind 22242 event with the challenge and relay URL
3. Relay verifies the signature, challenge, relay tag, and timestamp
4. On success, the connection's `authPubkey` is set

Authentication is optional -- no relay feature currently requires it.

### NIP-70: Protected events (rejected)

Events with a `-` tag are rejected unconditionally at the WebSocket edge (`blocked: protected events (NIP-70) are not accepted by replicated relays`) and skipped by the consensus apply function. A replicated multi-writer store cannot honor "don't propagate" -- any peer of the base would re-serve the event -- and NIP-70 explicitly blesses rejection. The relay never accepts-then-drops, and the behavior is never config-dependent (per-node config in a consensus rule would fork views). NIP-70 is not listed in `supported_nips`. This is a deliberate behavior change that applies to single-node deployments too.

## Peer-to-peer replication

### How peers sync

Two peers only sync the same database when they were configured onto the same base (founder/joiner, see below). When two such peers connect over Hyperswarm:

1. Hyperswarm handles peer discovery via the DHT and establishes an encrypted Noise protocol connection (mutually authenticated; possession of the base key is what grants read replication -- the DHT sees only hashes).
2. The socket is passed to `store.base.replicate(socket)` -- the Autobase replicates the underlying Corestore and additionally announces writer heads via the protomux-wakeup protocol.
3. Replication exchanges Hypercore keys and begins syncing all cores:
   - Each writer's core (their append-only operation log)
   - The Autobase view/system cores
4. As new blocks arrive, Autobase detects changes and re-linearizes.
5. The apply function runs on the new operations, updating the Hyperbee view. This includes `add_writer` ops: when a joiner sees its own admission applied, its base emits `'writable'` and it starts accepting writes -- no restart.
6. The EventStore emits `event:stored` for any newly visible events.
7. The MessageHandler pushes those events to matching WebSocket subscriptions.

This means a WebSocket client connected to peer A will receive events that were originally submitted to peer B, with no explicit forwarding -- the data flows through Autobase replication. Peers that merely share a *topic* but not a *base* exchange connections, not data: each keeps its own independent view.

### Bootstrap key (solved: invites + persistence guard)

The founder's Autobase key identifies the multi-writer base; every other node needs it to join. This used to be an undocumented manual step -- it is now an explicit, typo-proof workflow:

- **Invite codec** (`src/util/invite.ts`): the base key is shared operator-to-operator as `'nsw1' + z32(version || baseKey || sha256-checksum)`. A corrupted `--bootstrap`/`BOOTSTRAP_KEY` value fails fast at startup -- it can never silently found a fresh, empty base. Raw 64-hex keys are still accepted for scripting. The invite (and this node's writer key) are logged at startup and written to `<storage>/keys.json`.
- **Persistence guard** (`src/storage/bootstrap.ts`): `resolveBootstrap` records the base identity in `<storage>/bootstrap-key` on first start. From then on the storage directory is pinned to that base: configuring a different bootstrap key is a fatal error, making accidental re-founding impossible. Joining a different base requires a fresh storage path (migrate events with `nostr-swarm export` / `import`).

Exactly one node per swarm starts without a bootstrap (the founder); a two-founder operator error creates a permanent split whose recovery is export/import. Baseline admission is operator-driven (`--admit`); the v2 in-band admission channel (`nostr-swarm/admission@1`, contract in `src/swarm/protocol.ts`, implementation in `src/swarm/admission.ts`) is now implemented as an opt-in (`--auto-admit` granter, `--request-writer` joiner) that lets an invite holder prove possession over the swarm and be admitted without a restart.

### Pear Runtime integration

A Pear Runtime app is a read-mostly peer: identical to a relay node from the replication perspective, but not an admitted writer. It:

1. Opens its own Corestore
2. Joins the same Hyperswarm topic (`sha256("nostr-swarm:" + topic)`)
3. Replicates with all peers on the topic
4. Opens the same Autobase with the founder's base key (decoded from the invite)
5. Reads the full view locally through the Hyperbee; writes go through a relay's WebSocket endpoint

The Pear client does not need the WebSocket *server* layer, the NIP-11 endpoint, or any of the rate limiting. It reads directly on the shared data structure. It can use the same apply function and index schema, or implement its own read-only secondary view optimized for its UI (the primary apply must match exactly).

```
┌─────────────────────┐         ┌─────────────────────┐
│  Relay Node A        │         │  Relay Node B        │
│  (founder/writer)    │         │  (admitted writer)   │
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
│  Pear Client X       │         │  Pear Client Y      │
│  (read-mostly)       │         │  (read-mostly)      │
│  UI ◄─► Autobase    │◄───────►│  Autobase ◄─► UI   │
│         Corestore    │ Swarm   │  Corestore           │
└──────────────────────┘         └──────────────────────┘
```

All four nodes replicate the same Autobase (same bootstrap). An event submitted to Relay Node A appears in Pear Client Y's local view, and an event a Pear client publishes via either relay's WebSocket endpoint reaches everyone. Light/Pear clients are never admitted as writers in this release, so they cannot append to the base directly -- un-admitted appends would be rolled back.

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
- **Light client mode** (`LIGHT_CLIENT=true`): WoT filtering at write time, plus storage-budget pruning (v2). When the base is writable (a founder/personal relay), `LightStore.prune` evicts the oldest events (profiles/contact/mute lists exempt) over `LIGHT_MAX_STORAGE` via founder-authored `prune_delete` consensus ops, keeping the view convergent. On a read-only replica it stays a no-op (the shared, autobase-materialized view cannot be soundly mutated locally). See [Client Architecture](clients.md) for details.

WoT is strictly a **local pre-append / serve-time policy** -- it is never part of the apply()/consensus rules, because per-node trust graphs would diverge views. See [Web of Trust](web-of-trust.md).

## Configuration

All configuration flows through `src/util/config.ts`. Each setting has three layers of precedence:

1. **Environment variable** (highest priority)
2. **CLI flag / constructor override**
3. **Default value** (lowest priority)

Note the foot-gun: env beats CLI for every knob, including `BOOTSTRAP_KEY` over `--bootstrap` and `ADMIT_WRITERS` over `--admit`. This is kept for consistency with every existing setting.

| Setting | Env var | CLI flag | Default |
|---|---|---|---|
| WebSocket port | `WS_PORT` | `--port` | 3000 |
| Bind address | `WS_HOST` | -- | 0.0.0.0 |
| Storage path | `STORAGE_PATH` | `--storage` | ./nostr-swarm-data |
| Swarm topic | `SWARM_TOPIC` | `--topic` | nostr |
| Bootstrap (invite or 64-hex base key) | `BOOTSTRAP_KEY` | `--bootstrap` | (empty -- found a new base) |
| Admit writers (comma-separated / repeatable) | `ADMIT_WRITERS` | `--admit` | (empty) |
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
| Light max storage (enforced on a writable/founder light client) | `LIGHT_MAX_STORAGE` | -- | 524288000 (500 MB) |
| Light prune interval | `LIGHT_PRUNE_MS` | -- | 600000 (10 min) |

## File map

```
src/
├── cli.ts                  Entry point (CLI parsing + export/import subcommands)
├── relay.ts                NostrSwarm orchestrator (startup/shutdown, admissions)
├── index.ts                Public API exports
├── ws/
│   ├── server.ts           HTTP + WebSocket server, NIP-11
│   ├── connection.ts       Per-connection state, rate limiters
│   └── handler.ts          Nostr message handling (EVENT/REQ/CLOSE/COUNT/AUTH)
├── storage/
│   ├── store.ts            EventStore (Autobase + versioned consensus apply)
│   ├── bootstrap.ts        Bootstrap-key persistence guard + keys.json writer
│   ├── indexes.ts          Hyperbee sub-database definitions
│   └── query.ts            Query engine (index selection, range scans)
├── swarm/
│   ├── network.ts          Hyperswarm connection + Autobase replication
│   ├── admission.ts        v2 in-band admission channel (joiner request + granter verify)
│   └── protocol.ts         v2 admission channel contract (proof + message codec)
├── tools/
│   └── migrate.ts          export/import merge tooling (JSONL over validated WS)
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
│   ├── types.ts            TypeScript interfaces (NostrEvent, NostrFilter, StoreOp, etc.)
│   ├── config.ts           Configuration loading (relay, WoT, light client)
│   ├── invite.ts           nsw1 invite codec (z32 + checksum) for bootstrap keys
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
