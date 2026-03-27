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

Relay nodes and Pear clients are peers -- they replicate the full Autobase and can read/write events directly. Web clients are consumers that depend on a relay node as their gateway into the swarm.

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
- **Replication** -- The relay syncs with all peers over Hyperswarm. Events from other nodes and Pear clients appear on the WebSocket as live subscription updates.
- **Indexing** -- The relay maintains secondary indexes (kind, author, tags, timestamps) for efficient filter queries.
- **Rate limiting** -- Token bucket rate limiters protect the relay from abuse (configurable via `EVENT_RATE` and `REQ_RATE`).
- **Authentication** -- NIP-42 challenge-response auth for protected events (NIP-70).

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

A Pear Runtime client is a full peer in the swarm. It joins the Hyperswarm topic, replicates the Corestore, and runs its own Autobase instance. It reads and writes events directly on the local Hyperbee -- no WebSocket, no relay dependency.

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

The Pear client connects to every available peer on the topic. There is no special "server" -- all peers are equal. The client replicates data from whoever is online.

### Setup

A Pear client needs four things from the Holepunch stack:

1. **Corestore** -- Local storage for all Hypercores (the client's own write log + replicas of every other peer's log).
2. **Hyperswarm** -- Peer discovery and encrypted connections.
3. **Autobase** -- Multi-writer consensus. Linearizes all peers' operations into a deterministic order.
4. **Hyperbee** -- The materialized view. A sorted B-tree of all Nostr events and indexes.

```js
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import { createHash } from 'crypto'

// Local storage -- this peer keeps a full copy of all data
const store = new Corestore('./my-nostr-data')

// Join the same swarm topic as the relay nodes
const swarm = new Hyperswarm()
const topic = createHash('sha256').update('nostr-swarm:nostr').digest()

// Replicate with every peer that connects
swarm.on('connection', (socket) => store.replicate(socket))
swarm.join(topic, { server: true, client: true })

// Open the shared Autobase
// bootstrapKey is the key from the first Autobase instance (see Bootstrap Key below)
const base = new Autobase(store, bootstrapKey, {
  open: (store) => new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  }),
  apply,          // must be the same deterministic function as the relay
  valueEncoding: 'json',
})
await base.ready()
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

Writing is an Autobase append. The operation goes into the local Hypercore and is replicated to all peers:

```js
// Append a put operation (same schema as src/util/types.ts StoreOp)
await base.append({ type: 'put', event: signedEvent })

// Append a deletion (NIP-09)
await base.append({ type: 'delete', event: signedKind5Event })
```

Autobase linearizes this operation with all other peers' operations and runs the apply function. The local Hyperbee view updates, and every other peer's view converges to the same state.

### The apply function

The apply function **must be identical** across all peers -- relay nodes and Pear clients alike. It is what guarantees that every peer produces the same Hyperbee from the same set of inputs. The canonical implementation is in `src/storage/store.ts` (`EventStore.apply`).

If a Pear client uses a different apply function, its view will diverge from the relay nodes. This is fine for read-only secondary views (e.g. a UI-specific index), but the primary Autobase apply must match.

### Offline and sync

Because the Pear client has its own Corestore, it works offline:

1. **Write while disconnected** -- Events are appended to the local Hypercore. They exist only on this peer until reconnection.
2. **Reconnect** -- Corestore replication syncs the local log with all peers.
3. **Linearize** -- Autobase incorporates the new operations and re-runs apply. All peers converge.

There is no conflict resolution protocol -- Autobase's deterministic linearization handles it. Two peers writing events while partitioned will produce the same final view once they sync.

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

// Periodic pruning removes events that exceed their tier's TTL
```

This is the recommended approach for phone clients. The light store:
- Builds and refreshes the trust graph from kind 3/10000 events
- Filters events at write time (rejects untrusted pubkeys)
- Periodically prunes events that exceed their trust tier TTL
- Always accepts kind 3 and kind 10000 events (needed for the WoT graph itself)

See [Web of Trust](web-of-trust.md) for full details on scoring, tiers, and configuration.

### When to use

- Desktop apps built on Pear Runtime
- Environments where offline support matters
- Scenarios where you want full data sovereignty (local replica, no relay trust)
- Apps that need low-latency reads (local disk, not network)
- Peer-to-peer-only deployments with no WebSocket relay nodes at all

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

Both client types depend on the Autobase bootstrap key -- the public key of the first Autobase instance that created the multi-writer base. This key identifies which Autobase all peers are writing to.

### Current state

The relay generates a bootstrap key on first startup and persists it in the Corestore. To add a second peer (relay or Pear client), the bootstrap key must be shared out-of-band: passed as configuration, copied from logs, embedded in a QR code, etc.

### Future: swarm key discovery

`src/swarm/protocol.ts` is a placeholder for a protocol extension that would solve this automatically. The idea: when a peer joins the swarm topic, existing peers announce the Autobase bootstrap key over the Hyperswarm connection. New peers receive the key, open the Autobase, and begin replicating -- no manual configuration needed.

Until this is implemented, the bootstrap key is a manual setup step.

## Comparison

| | WebSocket Client | Pear Runtime Client |
|---|---|---|
| **Connection** | WebSocket to one relay node | Hyperswarm to all peers |
| **Protocol** | NIP-01 JSON messages | Corestore replication |
| **Data storage** | None (stateless) | Full local replica (or WoT-filtered subset) |
| **Reads** | Network round-trip per query | Local disk |
| **Writes** | Send EVENT, wait for OK | Append to local Hypercore |
| **Offline** | No | Yes -- syncs on reconnect |
| **WoT filtering** | Handled by the relay node | Local via LightStore |
| **Dependencies** | WebSocket library | Holepunch stack (Hyperswarm, Corestore, Autobase, Hyperbee) |
| **Server dependency** | Needs a reachable relay node | None -- any peer works |
| **Trust model** | Trusts the relay | Verifies locally |
| **Setup** | Connect to a URL | Bootstrap key + local storage |
| **Best for** | Browsers, lightweight clients | Desktop apps, offline-first, sovereignty |
