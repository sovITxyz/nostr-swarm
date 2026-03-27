# Web of Trust

nostr-swarm includes a Web of Trust (WoT) system that filters events based on social graph distance from a configured owner pubkey. This keeps relay storage focused on socially relevant content and blocks spam from unknown or muted pubkeys.

## How it works

The trust graph is built from Nostr events already stored in the relay:

- **Kind 3** (contact list) events define who each pubkey follows
- **Kind 10000** (mute list) events define who each pubkey blocks

Starting from the owner's pubkey, the system performs a breadth-first traversal of the follow graph to compute degrees of separation:

```
Owner (you)
  ├── Degree 1: People you follow directly
  │     ├── Degree 2: People your follows follow
  │     │     └── Degree 3: Three hops away
  │     └── ...
  └── ...
```

Each degree gets a trust score and a TTL (time-to-live) that determines how long events from pubkeys at that distance are kept.

## Default trust tiers

| Degree | Who | Score | TTL |
|--------|-----|-------|-----|
| 0 | Owner (you) | 1.0 | Forever |
| 1 | Direct follows | 0.8 | Forever |
| 2 | Follows-of-follows | 0.4 | 7 days |
| 3 | Third degree | 0.1 | 1 day |
| -- | Unknown / not in graph | 0.0 | Rejected |
| -- | Muted | 0.0 | Rejected |

## Muting

A pubkey is considered muted if:

1. The owner's kind 10000 mute list contains it, OR
2. More than 50% of the owner's direct follows have it in their mute lists (consensus muting)

Muted pubkeys are always rejected regardless of graph distance.

## Configuration

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WOT_OWNER_PUBKEY` | Owner's 64-char hex pubkey (required to enable WoT) | (empty -- WoT disabled) |
| `WOT_MAX_DEPTH` | Maximum hops in the trust graph | `3` |
| `WOT_REFRESH_MS` | How often to rebuild the graph (milliseconds) | `300000` (5 min) |

### CLI flags

```bash
node dist/cli.js --wot-pubkey <hex-pubkey> --wot-depth 3
```

### Programmatic

```typescript
import { NostrSwarm } from 'nostr-swarm'

const relay = new NostrSwarm({
  wot: {
    ownerPubkey: 'deadbeef...64chars',
    maxDepth: 3,
    trustByDegree: { 0: 1.0, 1: 0.8, 2: 0.4, 3: 0.1 },
    ttlByDegree: { 0: 0, 1: 0, 2: 604800, 3: 86400 },
    refreshIntervalMs: 300_000,
  },
})
```

## Trust tiers in detail

### Score calculation

The `trustByDegree` map assigns a score (0.0 to 1.0) to each degree of separation. Scores are used for policy decisions:

- **score > 0** -- event is accepted (subject to TTL)
- **score = 0** -- event is rejected

You can customize the scoring to be more or less permissive:

```typescript
// Strict: only direct follows
trustByDegree: { 0: 1.0, 1: 1.0 }

// Permissive: wide trust net
trustByDegree: { 0: 1.0, 1: 0.9, 2: 0.7, 3: 0.5, 4: 0.2, 5: 0.1 }
```

### TTL (time-to-live)

The `ttlByDegree` map sets how long events from each tier are kept (in seconds):

- `0` means keep forever
- Any positive number is the max age before pruning

Events from higher-trust tiers are kept longer. Events from lower-trust tiers are pruned more aggressively to save space.

### Kind 3 and Kind 10000 exemption

Contact list (kind 3) and mute list (kind 10000) events are **always accepted** regardless of WoT scoring. These events are the data source for the trust graph itself -- filtering them would prevent the graph from being built.

## Graph refresh

The trust graph is rebuilt periodically (default: every 5 minutes). During a rebuild:

1. All kind 3 events are scanned to extract follow relationships
2. All kind 10000 events are scanned to extract mute relationships
3. BFS computes degrees of separation from the owner
4. Trust scores are recalculated

The graph is also rebuilt once at startup.

Rebuilds are incremental in effect -- new follow/mute events that arrived since the last rebuild will change the graph. If someone you follow starts following a new person, that person enters the trust graph on the next refresh.

## Architecture

```
src/wot/
  graph.ts    -- WotGraph class: BFS traversal, degree computation, mute detection
  policy.ts   -- ReplicationPolicyEngine: accept/reject decisions, TTL assignment
  index.ts    -- Barrel exports
```

### WotGraph

The `WotGraph` class maintains three data structures:

- `follows: Map<pubkey, Set<pubkey>>` -- follow graph from kind 3 events
- `mutes: Map<pubkey, Set<pubkey>>` -- mute lists from kind 10000 events
- `degrees: Map<pubkey, number>` -- BFS-computed distance from owner

It exposes:
- `getScore(pubkey)` -- returns `TrustScore` with degree, score, muted flag
- `isTrusted(pubkey)` -- boolean: score > 0 and not muted
- `getTrustedPubkeys()` -- set of all trusted pubkeys
- `getStats()` -- summary: total, by-degree counts, muted count

### ReplicationPolicyEngine

Takes a `WotGraph` and a `WotConfig`, evaluates events:

- `evaluate(event)` -- returns `{ action: 'accept', ttl }` or `{ action: 'reject', reason }`
- `isExpiredByPolicy(event)` -- checks if an event's age exceeds its tier's TTL

## Full relay vs. light client

- **Full relay** (Start9, VPS): WoT is optional. When enabled, it filters incoming events but the relay still serves everything it has stored. Useful for spam prevention.
- **Light client** (phone, Pear Runtime): WoT + pruning. The light client uses WoT to decide what to replicate and aggressively prunes expired-tier events to save storage. See [Client Architecture](clients.md) for details.
