# Client Architecture

nostr-swarm supports two fundamentally different client architectures: **WebSocket clients** (traditional Nostr apps) and **Pear Runtime clients** (native P2P peers). This document explains how each works, what they require, and when to use which.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Hyperswarm DHT                           │
│                                                                 │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐       │
│   │  Relay Node  │◄─►│  Relay Node  │◄─►│  Pear Client │       │
│   │  (full peer) │   │  (full peer) │   │  (full peer) │       │
│   └──────┬───────┘   └──────────────┘   └──────────────┘       │
│          │                                                      │
│          │ WebSocket                                            │
│          │                                                      │
│   ┌──────┴───────┐                                              │
│   │  Web Client  │                                              │
│   │  (consumer)  │                                              │
│   └──────────────┘                                              │
└─────────────────────────────────────────────────────────────────┘
```

Relay nodes and Pear clients are peers -- configured with the same base (the founder's `nsw1…` invite), they replicate the full Autobase and read the full view locally. Writing into the base requires operator admission of a node's writer key (`--admit`); Pear/light clients are never admitted in this release, so they are **read-mostly** peers that publish through a relay's WebSocket endpoint. Web clients are consumers that depend on a relay node as their gateway into the swarm.

## WebSocket client (traditional)

A WebSocket client treats nostr-swarm like any other Nostr relay. It speaks standard NIP-01 over a WebSocket connection and has no awareness of the P2P layer underneath.

### How it connects

```
Browser / Nostr app
      │
      │  ws:// or wss:// (via reverse proxy for TLS)
      │
      ▼
  nostr-swarm relay node
      │
      │  Hyperswarm replication
      │
      ▼
  other peers (relay nodes + Pear clients)
```

The client connects to a single relay node over WebSocket. That node is its gateway -- all reads and writes go through it. The relay node handles replication with other peers transparently.

### Protocol

Standard NIP-01 JSON messages. No extensions required:

```js
const ws = new WebSocket('wss://relay.example.com')

// Subscribe to events
ws.send(JSON.stringify(['REQ', 'sub1', { kinds: [1], limit: 50 }]))

// Publish an event
ws.send(JSON.stringify(['EVENT', signedEvent]))

// Receive events and control messages
ws.onmessage = (msg) => {
  const [type, ...rest] = JSON.parse(msg.data)
  switch (type) {
    case 'EVENT': // [subId, event]
    case 'EOSE':  // [subId] -- end of stored events
    case 'OK':    // [eventId, success, message]
    case 'AUTH':  // [challenge] -- NIP-42
  }
}
```

### What the relay handles for you

The relay node handles everything the web client cannot do itself:

- **Storage** -- Events are stored in the Autobase-backed Hyperbee. The web client keeps nothing locally.
- **Replication** -- The relay syncs with all peers of its base over Hyperswarm. Events written through other admitted nodes appear on the WebSocket as live subscription updates.
- **Writer admission** -- Publishing only succeeds if the relay node itself is an admitted writer. A joiner that has not been admitted yet serves full reads but answers `EVENT` with `["OK", id, false, "blocked: read-only replica awaiting writer admission"]`.
- **Indexing** -- The relay maintains secondary indexes (kind, author, tags, timestamps) for efficient filter queries.
- **Rate limiting** -- Token bucket rate limiters protect the relay from abuse (configurable via `EVENT_RATE` and `REQ_RATE`).
- **Authentication** -- NIP-42 challenge-response auth is available (no feature currently requires it; protected events per NIP-70 are rejected outright -- a replicated relay cannot honor "don't propagate").

### Limitations

- **Single point of failure** -- If the relay node the client is connected to goes down, the client must reconnect to a different node (or wait).
- **No offline support** -- The client cannot read or write without an active WebSocket connection.
- **Network latency** -- Every query is a network round-trip to the relay node.
- **No data sovereignty** -- The client trusts the relay to store and serve events correctly. It has no way to independently verify the Autobase state.

### When to use

- Browser-based Nostr apps
- Mobile apps that don't want to carry Holepunch dependencies
- Lightweight clients that don't need offline support
- Any existing Nostr client -- no code changes needed

## Pear Runtime client (native P2P)

A Pear Runtime client is a read-mostly peer in the swarm. It joins the Hyperswarm topic, replicates the base, and runs its own Autobase instance over the founder's bootstrap key. It reads events directly from the local Hyperbee -- no WebSocket, no relay dependency for reads. Publishing goes through an admitted relay's WebSocket endpoint, because light/Pear clients are never admitted as writers in this release.

### How it connects

```
Pear app (desktop / mobile via Pear Runtime)
      │
      │  Hyperswarm (Noise-encrypted, NAT hole-punched)
      │
      ├──► relay node A
      ├──► relay node B
      └──► other Pear clients
```

The Pear client connects to every available peer on the topic. There is no special "server" -- the client replicates data from whichever peers of its base are online.

### Setup

A Pear client needs four things from the Holepunch stack, plus the relay's invite:

1. **Corestore** -- Local storage for all Hypercores (replicas of every writer's log).
2. **Hyperswarm** -- Peer discovery and encrypted connections.
3. **Autobase** -- Multi-writer consensus. Linearizes all admitted writers' operations into a deterministic order.
4. **Hyperbee** -- The materialized view. A sorted B-tree of all Nostr events and indexes.
5. **The invite** (`nsw1…`) -- obtained from a relay operator (see Bootstrap key below). It decodes to the founder's 32-byte base key.

```js
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import { createHash } from 'crypto'
import { decodeInvite } from 'nostr-swarm'   // src/util/invite.ts

// Local storage -- this peer keeps a full copy of all data
const store = new Corestore('./my-nostr-data')

// Join the same swarm topic as the relay nodes
const swarm = new Hyperswarm()
const topic = createHash('sha256').update('nostr-swarm:nostr').digest()

// The invite is checksummed: a typo throws here instead of silently
// opening a different (empty) base.
const baseKey = decodeInvite('nsw1...')

// Open the shared Autobase
const base = new Autobase(store, baseKey, {
  open: (store) => new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  }),
  apply,          // must be the same deterministic function as the relay
  valueEncoding: 'json',
})
await base.ready()

// Replicate through the base with every peer that connects
swarm.on('connection', (socket) => base.replicate(socket))
swarm.join(topic, { server: true, client: true })
```

### Reading events

The Pear client reads directly from the local Hyperbee. No network round-trip, no REQ/EOSE protocol:

```js
// Direct key lookup
const entry = await base.view.get('e!' + eventId)
const event = entry?.value

// Range scan (e.g. all kind 1 events, newest first)
// Keys use inverted timestamps so lexicographic order = newest first
const stream = base.view.sub('kind').createReadStream({
  gte: '00000001!',          // kind 1
  lt:  '00000001!~',         // kind 1 upper bound
  limit: 50,
})

for await (const entry of stream) {
  const eventId = entry.value
  const event = await base.view.sub('events').get('e!' + eventId)
  // use event.value
}
```

For a full client, reuse the query engine and index schema from the relay codebase (`src/storage/query.ts`, `src/util/keys.ts`). The same functions work on any Hyperbee built by the same apply function.

### Writing events

Writes require admission. Appending into the base only takes effect for **admitted writers** -- nodes whose writer key (`base.local.key`) an operator of an existing writer has admitted via `--admit`. Light/Pear clients are never admitted in this release (a documented rule), so an un-admitted append is rolled back, not merged.

A Pear client publishes the normal Nostr way instead -- send `EVENT` to any admitted relay's WebSocket endpoint and wait for the `OK`:

```js
const ws = new WebSocket('ws://relay.local:3000')
ws.send(JSON.stringify(['EVENT', signedEvent]))   // also kind-5 deletions
```

The relay validates the event (structure, signature, NIP-40, NIP-70) and appends it to the shared base; replication then carries it to every peer, including this client's local view.

For completeness, an admitted relay node writes by Autobase append (same schema as `src/util/types.ts` `StoreOp`):

```js
await base.append({ type: 'put', event: signedEvent })
await base.append({ type: 'delete', event: signedKind5Event })
```

### The apply function

The apply function **must be identical** across all peers -- relay nodes and Pear clients alike. It is what guarantees that every peer produces the same Hyperbee from the same set of inputs. The canonical implementation is in `src/storage/store.ts` (`EventStore.apply`): a versioned consensus protocol (`CONSENSUS_VERSION = 2`) that re-verifies every event signature, scopes deletion tombstones to the deleter's pubkey, skips NIP-70 protected events, processes `add_writer` admissions, applies the founder-only `expiry_delete` / `prune_delete` / `set_config` ops, and honors self-verifying optimistic puts when the base's `accept_optimistic` flag is set. All peers of one base must run the same consensus version -- ops from a newer version halt the node rather than diverge.

If a Pear client uses a different apply function, its view will diverge from the relay nodes. This is fine for read-only secondary views (e.g. a UI-specific index), but the primary Autobase apply must match.

### Offline and sync

Because the Pear client has its own Corestore, reads work offline: the full replicated view is on local disk. On reconnect, replication catches the client up with whatever peers are online -- no protocol round-trips, no re-querying.

For admitted writer nodes, offline writes also merge cleanly:

1. **Write while disconnected** -- Operations are appended to the local Hypercore. They exist only on this peer until reconnection.
2. **Reconnect** -- Replication syncs the local log with all peers.
3. **Linearize** -- Autobase incorporates the new operations and re-runs apply. All peers converge.

There is no conflict resolution protocol -- Autobase's deterministic linearization handles it. Two writers appending while partitioned will produce the same final view once they sync. A read-mostly Pear client that drafts events offline must hold them until it can reach a relay's WebSocket endpoint.

### What the Pear client does NOT need

The entire WebSocket layer is irrelevant:

| Relay component | Needed by Pear client? |
|---|---|
| `ws/server.ts` | No |
| `ws/handler.ts` | No |
| `ws/connection.ts` | No |
| `nostr/nip-11.ts` | No |
| `util/rate-limit.ts` | No |
| `storage/store.ts` (EventStore) | Yes -- or reuse the apply function directly |
| `storage/query.ts` | Optional -- useful for filter queries |
| `util/keys.ts` | Yes -- needed to read/write the index schema |
| `swarm/network.ts` | Conceptually yes, but a Pear app handles its own swarm |

### Web of Trust on Pear clients

Pear clients can use the `LightStore` (`src/light/store.ts`) to apply WoT-based filtering locally:

```js
import { LightStore } from 'nostr-swarm'

const lightStore = new LightStore(eventStore, {
  ownerPubkey: 'your-64-char-hex-pubkey',
  maxDepth: 3,
  trustByDegree: { 0: 1.0, 1: 0.8, 2: 0.4, 3: 0.1 },
  ttlByDegree: { 0: 0, 1: 0, 2: 604800, 3: 86400 },
  refreshIntervalMs: 300_000,
}, {
  enabled: true,
  maxStorageBytes: 500 * 1024 * 1024,
  pruneIntervalMs: 600_000,
})

await lightStore.ready()

// Events from untrusted pubkeys are rejected at write time
const accepted = await lightStore.putEvent(signedEvent) // true or false
```

This is the recommended approach for phone clients. The light store:
- Builds and refreshes the trust graph from kind 3/10000 events
- Filters events at write time (rejects untrusted pubkeys)
- Always accepts kind 3 and kind 10000 events (needed for the WoT graph itself)

**Storage-budget pruning (v2)** enforces `maxStorageBytes` by evicting the oldest events (profiles/contact/mute lists exempt) via founder-authored `prune_delete` consensus ops, so the view stays convergent rather than diverging per peer. The old path that appended forged, unsigned kind-5 ops is gone (consensus apply drops unsigned deletions, and in a shared base they would have acted as *global* deletions). Because the eviction is a consensus op, `prune()` only acts on a **writable (founder/personal-relay) base**; on a read-only replica it is a no-op (the shared, autobase-materialized view cannot be soundly mutated locally), so there storage is bounded only by WoT ingest filtering.

Note that WoT filtering is **local policy only** -- it decides what this node appends and serves, never what the shared base accepts. See [Web of Trust](web-of-trust.md).

See [Web of Trust](web-of-trust.md) for full details on scoring, tiers, and configuration.

### When to use

- Desktop apps built on Pear Runtime
- Environments where offline reading matters
- Scenarios where you want full data sovereignty (local replica, no relay trust for reads)
- Apps that need low-latency reads (local disk, not network)
- Read-only mirrors with no WebSocket relay nodes at all (publishing always needs an admitted relay's WS endpoint)

## Start9 as a home relay

A Start9 box running nostr-swarm is the ideal companion for Pear clients. It acts as an always-on full archive peer that phones sync against. See [Start9 Deployment](start9.md) for packaging and configuration details.

```
┌─────────────────────────┐
│   Start9 box (24/7)      │
│   Full archive relay     │◄──── Pear phone clients sync here
│   WoT optional           │      when they come online
│   WebSocket for browsers │
└─────────────────────────┘
```

## Bootstrap key

Every peer type depends on the Autobase bootstrap key -- the public key of the founder's Autobase. This key identifies which base all peers replicate and (if admitted) write to.

### The invite codec

The key is shared operator-to-operator as a checksummed invite, never raw hex in UIs:

```
invite  = 'nsw1' + z32encode(payload)
payload = version(0x01) || baseKey(32 bytes) || sha256(version || baseKey)[0..4)
```

The founder logs its invite at startup and writes it to `<storage>/keys.json` (Start9 surfaces it as a copyable property). Joining is pasting that invite into `--bootstrap` / `BOOTSTRAP_KEY` (relay) or decoding it with `decodeInvite` (Pear client, exported from the `nostr-swarm` package). The checksum makes the value typo-proof: corruption is a hard error, never a silently founded empty base. Raw 64-hex keys remain accepted for scripting.

On relays, `<storage>/bootstrap-key` pins the storage directory to its base after first start -- reconfiguring a different bootstrap is a fatal error (the re-founding guard in `src/storage/bootstrap.ts`).

### In-band admission (v2)

The v2 in-band admission channel (`nostr-swarm/admission@1` over protomux, contract in `src/swarm/protocol.ts`, implementation in `src/swarm/admission.ts`) is implemented: a joiner started with `--request-writer` proves possession of the invite with an HMAC bound to the Noise session and requests admission in-band, and a writer started with `--auto-admit` grants it — removing the restart-to-admit step. Both sides are opt-in and default off, so the baseline flow remains the operator-driven `--admit`. Because `--auto-admit` makes the invite a write capability, enable it only when invite holders are trusted to write; admissions stay bounded by the 64-writer cap and a 16/hour rate limit.

## Comparison

| | WebSocket Client | Pear Runtime Client |
|---|---|---|
| **Connection** | WebSocket to one relay node | Hyperswarm to all peers of the base |
| **Protocol** | NIP-01 JSON messages | Autobase replication |
| **Data storage** | None (stateless) | Full local replica (or WoT-filtered subset) |
| **Reads** | Network round-trip per query | Local disk |
| **Writes** | Send EVENT, wait for OK (relay must be an admitted writer) | Send EVENT to an admitted relay's WS endpoint (never admitted itself) |
| **Offline** | No | Reads yes -- syncs on reconnect; writes need a reachable relay |
| **WoT filtering** | Handled by the relay node | Local via LightStore (storage-budget pruning on a writable/founder base) |
| **Dependencies** | WebSocket library | Holepunch stack (Hyperswarm, Corestore, Autobase, Hyperbee) |
| **Server dependency** | Needs a reachable relay node | Reads: none -- any peer seeds it; writes: an admitted relay |
| **Trust model** | Trusts the relay | Verifies locally |
| **Setup** | Connect to a URL | Invite (nsw1…) + local storage |
| **Best for** | Browsers, lightweight clients | Desktop apps, offline-first reading, sovereignty |
