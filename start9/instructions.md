# nostr-swarm

A fully peer-to-peer Nostr relay that syncs events over Hyperswarm. Every peer is equal -- no central server required.

## Getting Started

1. After installation, nostr-swarm starts automatically and begins listening for WebSocket connections and Hyperswarm peers. With an empty **Bootstrap Key (Invite)** it founds its own shared event store; its shareable invite appears in the service properties.

2. Your relay is available at:
   - **Tor**: Your `.onion` address (shown in the service properties)
   - **LAN**: `wss://<your-start9-address>` (with SSL termination)

3. Add your relay URL to any Nostr client (Amethyst, Damus, Iris, Snort, etc.) as a relay.

## Configuration

### Swarm Topic

The **swarm topic** determines which peer network your relay connects to. All relay nodes and Pear clients using the same topic will discover each other. Note that discovering peers is not the same as sharing data -- nodes only share events when they share one event store (see Bootstrap Key below).

- Default topic: `nostr`
- Change this if you want a private relay network (e.g., `my-family`, `dev-team`)

### Bootstrap Key (Invite)

This decides whose shared event store your relay belongs to:

- **Leave empty** to FOUND a new store. Exactly one node per group does this. Your store's invite (`nsw1…`) appears as **Relay Invite** in the service properties -- share it with operators and Pear clients who should join.
- **Paste another relay's invite** to JOIN its store. Your node replicates it and serves reads right away, but stays read-only until admitted (below).

Set this once: after first start the store identity is recorded on the data volume and cannot be changed (a different value is a startup error). Moving to a different store requires a fresh volume; migrate events with the `export`/`import` CLI tooling.

### Admit Writers

Joining a store grants reads, not writes. A read-only joiner answers publishes with `blocked: read-only replica awaiting writer admission`. To grant a joiner write access:

1. The joiner's operator copies **Local Writer Key** from their service properties and sends it to you.
2. Paste it into **Admit Writers** (comma-separated for several) and save. Saving restarts the service, which performs the admission.
3. The joiner becomes writable automatically once the admission replicates -- nothing to do on their side.

Any admitted writer can admit further writers (capped at 64 per store). Already-admitted keys are skipped, so it's safe to leave entries in the list.

### Web of Trust (WoT)

Set your **owner pubkey** (64-character hex Nostr public key) to enable Web of Trust filtering. When enabled:

- Events from pubkeys you follow are always kept
- Events from follows-of-follows are kept for 7 days
- Events from 3rd-degree connections are kept for 1 day
- Events from unknown pubkeys are not stored

The trust graph is built from kind 3 (contact list) events in the relay. It refreshes automatically every 5 minutes.

**WoT depth** controls how many hops from your pubkey are considered trusted:
- Depth 1: Only people you directly follow
- Depth 2: Friends of friends
- Depth 3: Three degrees of separation (default)

### Rate Limiting

Defaults are suitable for most use cases:
- Events: 10 per second per connection
- Requests: 20 per second per connection

Increase these if you expect high-traffic clients connecting to your relay.

## How Peering Works

Your Start9 relay is an always-on peer in the Hyperswarm network. It:

1. Stays connected 24/7, acting as a reliable seed peer
2. Keeps a full replica of all events in its shared event store
3. Serves WebSocket clients over Tor and LAN
4. Automatically discovers peers on its swarm topic, and replicates events with the ones that share its store (founder's invite + writer admission, see Configuration above)

Phone and desktop Pear Runtime clients can sync directly with your Start9 box -- give them your **Relay Invite** from the service properties. They read your store locally and publish through your WebSocket endpoint. When they go offline and come back, they catch up from your always-on node.

Note: protected events (NIP-70, the `["-"]` tag) are rejected by this relay -- a replicated store cannot honor "don't propagate".

## Backup

nostr-swarm data is included in Start9 backups. This covers all stored events, the Autobase state, and the store identity (`bootstrap-key`, `keys.json`). After restoring a backup, the relay will rejoin the swarm and catch up on any events it missed. If your node founded its store, it is the sole indexer for everyone who joined -- keep its backups current.
