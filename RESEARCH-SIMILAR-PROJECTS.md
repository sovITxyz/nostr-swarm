# Research: Similar Projects to nostr-swarm

## Overview

nostr-swarm is a fully peer-to-peer Nostr relay that syncs events over Hyperswarm using Autobase, Hyperbee, and Corestore from the Holepunch/Hypercore ecosystem. This document surveys similar and adjacent projects.

## Direct Competitors (Nostr + Hyperswarm/Hypercore)

### hyper-nostr (by Ruulul)
- **URL**: https://github.com/Ruulul/hyper-nostr
- **Description**: A distributed Nostr relay that syncs relay storage and real-time events through Hyperswarm, linearizes databases with Autobase, and uses a Hyperbeedee database (MongoDB-like). Uses Hyper SDK for abstraction over Hyperswarm and core management.
- **Comparison**: The most directly comparable project. Both use Hyperswarm + Autobase for P2P relay sync. nostr-swarm uses Hyperbee for storage while hyper-nostr uses Hyperbeedee. nostr-swarm is a more recent TypeScript implementation with a cleaner API and additional features (WoT, light client mode).

## Pure P2P Nostr Alternatives (No Relays)

### NostrP2P (by ryogrid)
- **URL**: https://github.com/ryogrid/nostrp2p
- **Description**: A pure peer-to-peer distributed microblogging system on a NAT-transparent overlay network, inspired by Nostr. Each user runs their own server; clients communicate only with their own server. Written in Go (server) and Dart/Flutter (client).
- **Comparison**: More radical approach — eliminates relays entirely with a custom P2P overlay, rather than bridging existing Nostr protocol onto Hyperswarm.

### nostr-p2p (by cmdruid)
- **URL**: https://github.com/cmdruid/nostr-p2p
- **Description**: A lightweight client library for building peer-to-peer messaging protocols on top of the Nostr relay network. Handles peering, encryption (AES-256-GCM), message routing, and relay management. Supports direct messages, broadcasts, multicasts, and request-response patterns.
- **Comparison**: Uses Nostr relays *as* the P2P transport layer rather than replacing them with a DHT — the opposite philosophy from nostr-swarm.

## Relay-to-Relay Sync / Mesh Topologies

### strfry (by hoytech)
- **URL**: https://github.com/hoytech/strfry
- **Description**: A high-performance C++ Nostr relay with a built-in "router" mode for building mesh topologies of relays. Features Negentropy-based set reconciliation (NIP-77) for efficient relay-to-relay sync with minimal bandwidth.
- **Comparison**: Creates relay mesh networks over standard WebSocket/Nostr protocol. strfry's Negentropy sync is complementary — it could theoretically be used alongside a Hyperswarm transport.

### NIP-77 (Negentropy Syncing)
- **URL**: https://nips.nostr.com/77
- **Description**: A protocol extension for efficient set reconciliation between relays (or client-relay). The "official" Nostr approach to relay sync — solves event distribution at the application protocol layer rather than the transport layer.

## Nostr + Mesh/Radio Networks

### Noshtastic (by ksedgwic)
- **URL**: https://github.com/ksedgwic/noshtastic
- **Description**: A broadcast Negentropy Meshtastic Nostr relay. Creates a fully self-sufficient communication network using only Meshtastic LoRa radio devices, without requiring internet-connected relays. Uses Negentropy for message synchronization over extremely low-bandwidth radio links. Written in Rust.
- **Comparison**: Targets offline/radio mesh scenarios. Both projects aim to move Nostr events beyond traditional WebSocket relays, but into very different transport contexts.

### Nostrastic (by QuixoteSystems)
- **URL**: https://github.com/QuixoteSystems/nostrastic
- **Description**: A bridge to publish Nostr posts and send/receive DMs over LoRa using Meshtastic. Requires at least one internet-connected Meshtastic device to forward messages via MQTT.
- **Comparison**: Simpler bridge approach compared to Noshtastic's fully offline design.

## Nostr + libp2p / Multi-Transport

### Zemzeme (by whisperbit-labs)
- **URL**: https://github.com/whisperbit-labs/zemzeme-android
- **Description**: A private, serverless messenger for Android with three simultaneous transport layers: offline Bluetooth mesh, direct P2P over libp2p + ICE, and relay-based messaging via Nostr. All layers operate simultaneously with automatic fallback. End-to-end encrypted.
- **Comparison**: Multi-transport approach where Nostr is one of several communication channels. nostr-swarm focuses specifically on replacing the Nostr relay transport with Hyperswarm.

## Nostr as Signaling Layer for P2P

### GenosDB / GenosRTC (by estebanrfp)
- **URL**: https://github.com/estebanrfp/gdb
- **Description**: A decentralized P2P graph database that uses Nostr relays as a signaling layer for WebRTC peer connections. Runs in the browser, stores data locally, syncs between peers via WebRTC.
- **Comparison**: Inverts the relationship — uses Nostr *for* P2P signaling rather than using P2P *for* Nostr.

## Summary Comparison Table

| Project | Transport | Approach | Language |
|---|---|---|---|
| **nostr-swarm** (this project) | Hyperswarm DHT | P2P relay using Autobase + Hyperbee | TypeScript |
| **hyper-nostr** | Hyperswarm DHT | P2P relay using Autobase + Hyperbeedee | JavaScript |
| **NostrP2P** | Custom overlay | Pure P2P, no relays at all | Go/Dart |
| **nostr-p2p** (cmdruid) | Nostr relays | P2P messaging library over relays | TypeScript |
| **strfry** (router mode) | WebSocket | Relay mesh with Negentropy sync | C++ |
| **Noshtastic** | Meshtastic/LoRa | Offline mesh Nostr relay | Rust |
| **Zemzeme** | BLE + libp2p + Nostr | Multi-transport messenger | Kotlin |
| **GenosDB** | WebRTC (Nostr signaling) | P2P database, Nostr for signaling | JavaScript |

## What Makes nostr-swarm Unique

While hyper-nostr shares the same core technology stack, nostr-swarm differentiates with:
- TypeScript implementation with cleaner API
- Hyperbee storage (B-tree indexed, vs MongoDB-like Hyperbeedee)
- Built-in Web of Trust social filtering
- Light client mode for resource-constrained devices
- Pear Runtime native client support
- Start9/StartOS packaging for self-hosting
- Dual client support (WebSocket + native Hyperswarm)

## Deep Dive: nostr-swarm vs. Hypertuna

Hypertuna (by squip) is a three-repo suite created April 2025, all labeled proof-of-concept / work-in-progress with 0 stars each:

- **hypertuna-relay-server** — the core P2P relay (7 commits, last updated 2025-04-27)
- **hypertuna-proxy-server** — WebSocket-to-Hyperswarm bridge for standard Nostr clients (7 commits)
- **hypertuna-relay-manager-client** — Pear desktop app for relay management (12 commits)

### Architecture Comparison

| Aspect | nostr-swarm | Hypertuna |
|---|---|---|
| **Language** | TypeScript | JavaScript (.mjs) |
| **Holepunch stack** | autobase 7, corestore 7 (latest) | autobase 6, corestore 6 (older) |
| **Nostr library** | `nostr-tools` v2.23.3 | Manual crypto (noble-secp256k1, tweetnacl, sodium-native) |
| **Storage** | Hyperbee with multi-index (6 indexes) | Autobee (Autobase + Hyperbee) with composite keys |
| **Client access** | Direct WebSocket relay (NIP-01 native) | Requires separate proxy server to bridge WS → HTTP → Hyperswarm |
| **Peer communication** | Direct Hyperswarm replication | HTTP forwarding via hypertele tunnels + Express REST API |
| **NIP support** | NIP-01, 09, 11, 40, 42, 45, 70 | NIP-01 (partial) only |
| **Web of Trust** | Built-in (BFS trust graph, consensus muting, per-degree TTLs) | None |
| **Light client mode** | Yes (WoT-aware pruning, discovery caps) | None |
| **Event indexing** | 6 dedicated sub-databases (events, kind, author, author_kind, tag, createdAt) + replaceable/addressable/expiration/deletion indexes | Single composite key format (`kind:created_at:id`) |
| **Auth** | NIP-42 challenge-response | None |
| **Deletion** | NIP-09 with author verification | None |
| **Expiration** | NIP-40 with cleanup timer | None |
| **Relay info** | NIP-11 document endpoint | None |
| **Identity** | Standard Nostr keypair | PBKDF2-SHA256 derived keys per relay |
| **Deployment** | Single process (relay + WS server) | Three separate components (relay server + proxy + client) |
| **Self-hosting** | Start9/StartOS package | VPS with registered domain recommended |
| **Maturity** | Active development, comprehensive test suite | Proof-of-concept, 0 stars, minimal activity |

### Key Architectural Differences

**1. Client Connectivity Model**

nostr-swarm is a **native Nostr relay** — standard Nostr clients connect directly via WebSocket and speak NIP-01. Every peer is a fully functional relay.

Hypertuna requires a **centralized proxy server** to bridge standard Nostr clients to the P2P swarm. The proxy is a single point of failure that routes WebSocket messages to peers via HTTP REST calls through hypertele tunnels. This re-introduces centralization at the access layer.

**2. Replication Strategy**

nostr-swarm uses Hyperswarm's built-in Corestore replication — when peers connect, they call `corestore.replicate(socket)` for automatic, efficient core-level sync. Autobase 7 provides deterministic linearization.

Hypertuna uses HTTP message forwarding between peers via Express endpoints and hypertele tunnels. Events are POSTed between peers rather than using native Hypercore replication, which is less efficient and doesn't leverage the full power of the Holepunch stack.

**3. Query Capability**

nostr-swarm has a sophisticated query engine that chooses the most selective index path (IDs → author+kind → author → kind → scan) with time range filtering and post-filtering.

Hypertuna uses simple composite key lookups (`kind:created_at:id`) with basic range scanning. No query optimization or multi-index selection.

**4. Spam/Trust Management**

nostr-swarm's Web of Trust system provides social-graph-based content filtering with configurable trust degrees, consensus muting, per-tier TTLs, and automatic pruning for light clients.

Hypertuna has no spam or trust management — all events from all peers are accepted unconditionally.

### Summary

Hypertuna is an early proof-of-concept that demonstrates the basic idea of running a Nostr relay over Hyperswarm. nostr-swarm is a significantly more mature and feature-complete implementation that:
- Uses the latest Holepunch stack versions
- Provides native WebSocket relay access (no proxy needed)
- Implements 7 NIPs vs. partial NIP-01 only
- Includes sophisticated query indexing, Web of Trust filtering, and light client support
- Leverages native Hypercore replication instead of HTTP forwarding

## Conclusion

nostr-swarm is not the only project in this space, but the specific combination of Hyperswarm + Autobase + Web of Trust filtering + light client support + dual transport makes it a distinctive and more feature-complete implementation compared to alternatives.
