# Deploying the full stack (relay + Primal shim + UI)

The UI experience has three moving parts:

| Component | What it is | Default endpoint |
|---|---|---|
| **relay** | `nostr-swarm` -- the NIP-01 Nostr relay | `ws://localhost:3000` |
| **shim** | `nostr-swarm primal-shim` -- Primal cache-protocol adapter | `ws://localhost:8801` |
| **UI** | [`sovITxyz/swarm-client`](https://github.com/sovITxyz/swarm-client) (Primal web-app fork, Vite) | dev: `http://localhost:5174` |

The shim answers the proprietary Primal cache protocol from the relay; the UI talks to the shim (`PRIMAL_CACHE_URL`) for feeds and to the relay directly (`PRIMAL_PRIORITY_RELAYS`) for reads/publishing. The UI is a separate repo and is always run/built on its own -- the tooling below covers the relay + shim.

## 1. Local dev -- Procfile

Runs the relay and the shim together with one command (via [foreman] or [overmind]); no build step (tsx):

```bash
overmind start      # or: foreman start
```

This launches:
- `relay` on `ws://localhost:3000`
- `shim`  on `ws://localhost:8801` (querying the relay at `ws://127.0.0.1:3000`)

Then start the UI separately from its own checkout:

```bash
# swarm-client/.env
PRIMAL_CACHE_URL       = "ws://localhost:8801"
PRIMAL_PRIORITY_RELAYS = "ws://localhost:3000"

npm run dev -- --port 5174
```

[foreman]: https://github.com/ddollar/foreman
[overmind]: https://github.com/DarthSim/overmind

## 2. Containers -- docker-compose

`docker-compose.yml` + `Dockerfile` (repo root) build a single multi-stage image (TS -> `dist/`) and run the relay and shim as two services on a shared network. Relay storage persists in the `relay-data` named volume.

```bash
docker compose up --build
# relay -> ws://localhost:3000   shim -> ws://localhost:8801
```

- `SHIM_RELAY_URL=ws://relay:3000` -- the shim reaches the relay by its compose service name.
- `SHIM_PUBLIC_RELAY_URL=ws://localhost:3000` -- the relay URL the shim advertises to **browsers** (`get_default_relays`); it must be reachable from the user's machine, not the internal `relay` hostname.
- To join an existing base instead of founding a new one, set `BOOTSTRAP_KEY` (the founder's `nsw1...` invite) on the relay service.

The UI still runs separately (dev server, or its own static build/host).

## 3. Public -- nginx + TLS

Browsers loading the UI over `https://` may only open `wss://` sockets (mixed-content rule), and the UI dials **two** kinds of socket: the cache shim **and** every priority relay. So **both** endpoints need TLS. `deploy/nginx/nostr-swarm.conf` terminates TLS for two hostnames and proxies each with the WebSocket `Upgrade`/`Connection` headers:

```
relay.example.com  ->  127.0.0.1:3000   (relay)
cache.example.com  ->  127.0.0.1:8801   (shim)
```

Because the UI compiles its endpoints in at **build** time (Vite), rebuild it against the public `wss://` URLs after certs are live:

```bash
# swarm-client/.env
PRIMAL_CACHE_URL       = "wss://cache.example.com"
PRIMAL_PRIORITY_RELAYS = "wss://relay.example.com"

npm run build     # (vite build) -> static dist/, serve behind your web host
```

And start the shim so the relay it advertises to browsers is the `wss` one:

```bash
SHIM_PUBLIC_RELAY_URL=wss://relay.example.com   # advertised via get_default_relays
```

> For the pure peer-to-peer (no TLS, no reverse proxy) deployment path, see the **Deployment** section of the [README](../README.md#deployment).
