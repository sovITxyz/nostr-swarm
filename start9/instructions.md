# nostr-swarm

A fully peer-to-peer Nostr relay that syncs events over Hyperswarm. Every peer is equal -- no central server required.

## Getting Started

1. After installation, nostr-swarm starts automatically and begins listening for WebSocket connections and Hyperswarm peers.

2. Your relay is available at:
   - **Tor**: Your `.onion` address (shown in the service properties)
   - **LAN**: `wss://<your-start9-address>` (with SSL termination)

3. Add your relay URL to any Nostr client (Amethyst, Damus, Iris, Snort, etc.) as a relay.

## Configuration

### Swarm Topic

The **swarm topic** determines which peer network your relay joins. All relay nodes and Pear clients using the same topic will discover each other and replicate events.

- Default topic: `nostr`
- Change this if you want a private relay network (e.g., `my-family`, `dev-team`)

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
2. Keeps a full replica of all events on the swarm topic
3. Serves WebSocket clients over Tor and LAN
4. Automatically discovers and replicates with other peers

Phone and desktop Pear Runtime clients can sync directly with your Start9 box. When they go offline and come back, they catch up from your always-on node.

## Backup

nostr-swarm data is included in Start9 backups. This covers all stored events and the Autobase state. After restoring a backup, the relay will rejoin the swarm and catch up on any events it missed.
