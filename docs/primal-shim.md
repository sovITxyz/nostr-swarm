# Primal cache shim

`nostr-swarm primal-shim` lets the open-source [Primal web app](https://github.com/PrimalHQ/primal-web-app)
be used as a UI for a nostr-swarm relay.

## Why a shim

The Primal web app does not read from Nostr relays. Every read path — feeds,
threads, profiles, search, notifications — goes through Primal's proprietary
caching service using messages like:

```
["REQ", <subId>, {"cache": ["<verb>", <payload>]}]
```

A standard NIP-01 relay cannot answer these. The shim impersonates that
caching service: it serves the cache protocol on its own WebSocket port
(default **8801**) and answers every verb by querying a nostr-swarm relay over
plain NIP-01 (plus NIP-45 COUNT and NIP-50 search), synthesizing the
Primal-specific response events (engagement stats, feed ranges, notification
objects) on the fly.

Only *reads* need the shim. The web app publishes events **directly to the
relay** by default (`proxyThroughPrimal` is off), because the shim answers
`get_default_relays` with this relay's URL.

```
Primal web app (browser)
   │  ws://localhost:8801   cache protocol        │ ws://localhost:3000
   ▼                                              ▼ (direct publish path)
primal-shim ───── NIP-01 REQ/COUNT/EVENT ──▶ nostr-swarm relay
```

## Quick start

```bash
# Terminal 1: the relay (founds a writable base on first run)
nostr-swarm

# Terminal 2: the shim
nostr-swarm primal-shim            # ws://localhost:8801 → ws://127.0.0.1:3000
```

Then point a checkout of [swarm-client](https://github.com/sovITxyz/swarm-client)
(our primal-web-app fork) at it. Either edit its `.env`:

```
PRIMAL_PRIORITY_RELAYS = "ws://localhost:3000"
PRIMAL_CACHE_URL = "ws://localhost:8801"
PRIMAL_UPLOAD_URL = "ws://localhost:8801"
```

and run `npm run dev -- --port 5173` (the Vite default of 3000 collides with
the relay), or — without rebuilding — open the deployed app and run
`localStorage.setItem('cacheServer', 'ws://localhost:8801')` before reloading
(the same setting lives in the app under Settings → Network).

## Options

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `-p, --port` | `SHIM_PORT` | `8801` | Shim WebSocket port |
| `--host` | `SHIM_HOST` | `0.0.0.0` | Bind address |
| `-r, --relay` | `SHIM_RELAY_URL` | `ws://127.0.0.1:3000` | Upstream relay |
| `--public-relay` | `SHIM_PUBLIC_RELAY_URL` | derived from `--relay` | Relay URL advertised to browsers (`get_default_relays`) |
| `-d, --data-dir` | `SHIM_DATA_DIR` | `./primal-shim-data` | Shim state (notification seen-timestamps) |
| — | `SHIM_UPSTREAM_SOCKETS` | `4` | Upstream query socket pool size |
| — | `SHIM_STATS_TTL_MS` | `30000` | Engagement-stats cache TTL |
| — | `SHIM_STATS_CACHE_SIZE` | `10000` | Engagement-stats cache entries |
| — | `SHIM_MAX_MESSAGE_SIZE` | `131072` | Max client message bytes |
| — | `SHIM_QUERY_TIMEOUT_MS` | `15000` | Per-upstream-query timeout |

As everywhere in nostr-swarm, environment variables take precedence over CLI
flags.

## What works

- **Boot** as guest and logged-in (NIP-07 extension or nsec), default app
  settings, per-user settings persisted to the relay as the user's own signed
  kind-30078 event
- **Feeds**: "Latest" (accounts you follow, from your kind-3), "All Notes"
  (relay firehose), profile notes/replies/media/bookmarks tabs, reads
  (kind-30023), pagination and the new-notes poll
- **Threads** with parent chains and replies; engagement counts
  (replies/reposts/likes/zaps with sats) batched per page and cached
- **Publishing**: direct-to-relay by default; the `broadcast_events` proxy
  path and post-publish `import_events` ingestion are also implemented
- **Search**: notes and people via the relay's NIP-50 substring search
- **Notifications**: replies, mentions, reactions, reposts and zaps on your
  posts, with a live badge counter and seen-state (persisted in the shim's
  data dir)
- **Explore / trending**: the home-sidebar trending list, and the Explore
  Media, Zaps, Topics, and People tabs. "Latest" media/zaps/topics are
  faithful; trending *ranking* is approximated from relay engagement
  (`likes + reposts + 2·replies + 2·zaps`, or zap sats) since Primal's true
  network-weighted score isn't reproducible from a plain relay
- **Direct messages** (NIP-04, kind 4): conversation list, threads, unread
  badge, and mark-as-read. The shim only moves ciphertext — all
  encryption/decryption stays in the client; unread watermarks persist in the
  shim's data dir

## What degrades (by design, MVP)

Everything else answers with an empty result (`EOSE`), which the web app
renders as an empty state: DVM feeds, Premium, wallet/NWC, live streams,
moderation filter lists, NIP-17 gift-wrapped DMs (the client is NIP-04 only),
link-preview and media metadata. Media uploads use Primal's Blossom HTTP
servers, not the cache socket — uploads fail with a toast unless you configure
a Blossom server in the app.

Two quantitative caveats:

- Engagement counts saturate at the relay's per-query limit (default 500
  combined interactions per page request).
- The relay's rate limits are per connection; the shim pools
  `SHIM_UPSTREAM_SOCKETS` connections. For many concurrent users, raise the
  relay's `REQ_RATE` or the pool size.

## Deployment notes

- **TLS**: the shim, like the relay, terminates plain `ws://` only. A page
  served over `https://` needs `wss://` — put both ports behind the same
  reverse-proxy TLS termination shown in the README's nginx example.
- **Read-only replicas**: writes (settings, broadcast/import) fail against a
  joiner node that has not been admitted as a writer; the shim surfaces the
  relay's reason as a `NOTICE`. Point the shim at a writable node.
- **Protocol drift**: the verb surface was mapped against primal-web-app
  v3.0.101. Unknown verbs degrade to `EOSE` and are logged at debug level
  (`-v`), so newer clients stay usable while telling you what's missing.
