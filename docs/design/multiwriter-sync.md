# Multi-Writer Sync: Explicit Bootstrap + Operator Admission

Design + implementation plan for converging multiple nostr-swarm nodes onto one shared multi-writer Autobase. Lives at `docs/design/multiwriter-sync.md`.

## 1. Motivation

`EventStore` already accepts an Autobase bootstrap key (`src/storage/store.ts:27`, passed to `new Autobase(...)` at store.ts:30-40), but `NostrSwarm` never supplies it — `src/relay.ts:33` is `new EventStore(this.config.storagePath)` — and nothing ever calls `host.addWriter` (`apply()` at store.ts:80-99 handles only `put`/`delete`; its `_host` param is unused). `SwarmNetwork` only does `corestore.replicate(socket)` (`src/swarm/network.ts:27`); `src/swarm/protocol.ts` is a dead 23-line stub. Consequence: every node founds its own single-writer Autobase. Peers connect and replicate corestores, but two independently started nodes never share a view. The README's headline ("Every peer sees the same data regardless of join order", README.md:11) and equivalent claims in docs/architecture.md:334-347, docs/clients.md:184-194, and docs/start9.md:156-171 are not functional.

## 2. Chosen architecture

**Founder/joiner with explicit bootstrap and operator-driven writer admission.** One node per swarm starts without `--bootstrap` and founds the base (`base.key === base.local.key`). Every other node starts with `--bootstrap <invite>` and deterministically opens the founder's base — convergence by construction, independent of runtime join order (a joiner may start before the founder is reachable). Writers are admitted manually by an operator of any existing writer via `--admit <writerKeyHex>`, which appends an `add_writer` op executed in `apply()` via `host.addWriter(key, { indexer: false })`. Reads need no admission: non-writers fully materialize the view by running apply over replicated cores.

**Rejected alternatives.**
- *Invite-only "one base = one swarm"* (topic = `base.discoveryKey`): structurally eliminates founder races, but forces a namespace re-found plus full event replay on every existing deployment (storage doubling, migration risk) and deprecates `--topic`/`SWARM_TOPIC` semantics. We adopt its invite codec, NIP-70 stance, and HMAC admission-channel crypto, not its migration.
- *Automatic base election over a side channel*: zero-ceremony, but default-on merging with strangers on the well-known `nostr` topic, live base hot-swap under WS traffic, config-dependent indexer promotion (a consensus bug), and key-grinding election attacks. We adopt its subs-invalidation fix, availability-first posture, and the optimistic-append direction.

Availability is never sacrificed: no startup path blocks on peer state; a joiner serves reads from whatever it has replicated and accepts writes the moment `'writable'` fires.

## 3. Mechanism

### 3.1 Bootstrap: invite codec and resolution

The base key is shared operator-to-operator as a checksummed invite (never raw hex in docs/UI; raw hex remains accepted for scripting):

```
invite = 'nsw1' + z32encode(payload)
payload = version(1 byte, 0x01) || baseKey(32 bytes) || sha256(version || baseKey)[0..4)
```

`src/util/invite.ts` (new):

```ts
export function encodeInvite(baseKey: Buffer): string
export function decodeInvite(code: string): Buffer        // throws on bad prefix/version/length/checksum
export function parseBootstrap(value: string): Buffer | null
// '' -> null; 'nsw1…' -> decodeInvite; /^[0-9a-f]{64}$/i -> Buffer; anything else -> throw (fatal at startup)
```

`z32` (already in node_modules transitively) becomes a direct dependency. A typo'd bootstrap is a hard startup error, never a silently re-founded empty node.

`src/storage/bootstrap.ts` (new) — the re-founding persistence guard:

```ts
export function resolveBootstrap(storagePath: string, configured: string): Buffer | null
// <storagePath>/bootstrap-key holds 64-hex.
// file exists && configured key differs  -> throw (fatal, explicit message)
// file exists                            -> return file's key
// configured only                        -> persist file, return key
// neither                                -> return null (founder; caller persists base.key after ready)
export function persistBootstrapKey(storagePath: string, key: Buffer): void
export function writeKeysFile(storagePath: string, baseKey: Buffer, writerKey: Buffer): void
// writes <storagePath>/keys.json: { "baseKey": hex, "invite": "nsw1…", "writerKey": hex }
```

At `store.ready()` the relay logs prominently: the invite (`nsw1…`), the raw base key, and the local writer key (`base.local.key` hex), and writes `keys.json` (surfaced by Start9 properties).

### 3.2 Writer admission

New op and view sub:

```ts
// src/util/types.ts — StoreOp becomes:
export type StoreOp =
  | { type: 'put'; event: NostrEvent; v?: number }
  | { type: 'delete'; event: NostrEvent; v?: number }
  | { type: 'add_writer'; key: string; v?: number }   // key = joiner's base.local.key, 64 lowercase hex
// v is a reserved consensus-version field; absent means 1.
```

`writers` sub in `src/storage/indexes.ts` (`IndexSubs.writers`): key = writerKeyHex, value = `{ addedBy: string }` (hex of `node.from.key`). The founder's own key is implicit, never in the sub.

Flow: joiner starts read-only and logs its writer key → joiner's operator sends it out-of-band to any existing writer's operator → that operator restarts with `--admit <hex>` (Start9: edit `admit-writers`, which restarts the service) → on startup, once `base.writable`, the relay appends `add_writer` for each configured key not already in the `writers` sub → the op replicates; the joiner's base emits `'writable'`; it starts accepting writes with no restart on its side. `EventStore.admitWriter(keyHex)` enforces a pre-check; `apply()` is authoritative.

Authentication: the 32-byte writer key is itself the capability, exchanged out-of-band. There is no in-band admission request in v1, so a public-topic attacker has nothing to spam. Spam bounds: hard cap of **64 writers**, enforced deterministically in `apply()` (writers-sub count is part of the view); duplicate `add_writer` ops are no-ops. All admissions use `{ indexer: false }`: **the founder stays the sole indexer**, so `signedLength` liveness never depends on churny peers (autobase issue #359).

### 3.3 Consensus rules in apply()

`apply()` becomes a versioned consensus protocol. `CONSENSUS_VERSION = 1`. Rules, in order, all deterministic and config-free:

1. Null-value nodes (acks): skip.
2. `op.v !== undefined && op.v > 1` → `host.interrupt('unsupported op version')` — halt rather than diverge.
3. `add_writer`: key must match `/^[0-9a-f]{64}$/`; skip if already in `writers` sub or sub size ≥ 64; else `await host.addWriter(Buffer.from(key,'hex'), { indexer: false })` and record `{ addedBy }`.
4. `put`: `validateEventStructure(event) && verifyEventSignature(event)` or skip (admitted writers cannot bypass WS validation); `isProtected(event)` (NIP-70 `["-"]` tag) → skip; then existing applyPut path (id dedup, tombstone check, indexes). Ephemeral kinds still never stored.
5. `delete`: validate + verify the kind-5 event itself or skip; per `e`-tag target: if stored, remove only when `target.pubkey === deletion.pubkey`; **always** write tombstone as `{ id: <deletionEventId>, pubkey: <deletion.pubkey> }`; finally store the kind-5 via rule 4.
6. Tombstone check in applyPut: object tombstones block a put only when `tombstone.pubkey === event.pubkey` (kills the forged-tombstone censorship vector and makes delete-before-put ordering safe). Legacy string tombstones (pre-upgrade single-node data) block unconditionally, preserving old local behavior.
7. `removeIndexes`: delete the replaceable (`pubkey!kind`) / addressable (`pubkey!kind!dTag`) pointer **only if it still references the deleted event id** (fixes the pointer-orphaning bug at store.ts:221-226).

Supporting changes: the Autobase is constructed with `optimistic: true` **now** (constructor-gated; cannot be retrofitted without a consensus bump). v1's apply never calls `host.ackWriter`, so optimistic blocks are always rolled back — the option is reserved for v2 self-verifying writes from light/Pear peers. `nostr-tools` is pinned exactly to `2.23.3` (`verifyEvent` is now a consensus rule; verifier drift forks views). `'event:stored'` emissions are deduped through a bounded 4096-id LRU (reorg re-application re-fires them). The `indexes` getter (store.ts:48-51) invalidates its cache whenever `base.view` identity changes (fast-forward safety); `WotGraph.rebuild/startRefresh` switch to a `getIndexes: () => IndexSubs` thunk so the WoT refresh timer never holds stale subs.

New `EventStore` surface:

```ts
get writable(): boolean                  // base.writable
get localWriterKey(): Buffer             // base.local.key
get isFounder(): boolean                 // base.key.equals(base.local.key)
async admitWriter(keyHex: string): Promise<'appended' | 'already-admitted' | 'cap-reached'>  // throws if !writable
async listWriters(): Promise<string[]>
// EventEmitter: 'event:stored' (existing), 'writable' and 'update' re-emitted from the base
```

### 3.4 NIP layer, read-only peers, light clients

- **Read-only gate**: before `putEvent/deleteEvent`, `src/ws/handler.ts` replies `["OK", id, false, "blocked: read-only replica awaiting writer admission"]` when `!store.writable`. REQ/COUNT/NIP-11/NIP-42 are untouched — non-writers serve full reads.
- **NIP-70**: protected events are now rejected unconditionally at the WS edge with `blocked: protected events (NIP-70) are not accepted by replicated relays` (replacing the auth-gated accept at handler.ts:107-109), matching the unconditional apply-side skip — never accept-then-drop, never config-dependent consensus. NIP-70 is removed from `supported_nips`. Rationale: a replicated multi-writer store cannot honor "don't propagate"; NIP-70 explicitly blesses rejection. This is a deliberate behavior change for single-node deployments too.
- **Light clients are never admitted as writers** (documented rule). `LightStore.prune` becomes a warn-once no-op everywhere: its forged unsigned kind-5 ops (light/store.ts:142-150) would be dropped by apply rule 5 regardless, and in a shared base they'd otherwise be global deletions. `LIGHT_MAX_STORAGE` enforcement degrades to a warning this release; true local pruning (hypercore clearing) is deferred.
- Replication switches from `corestore.replicate(socket)` to `store.base.replicate(socket)` (network.ts:27) so protomux-wakeup announces writer heads; relay.ts ordering already guarantees the base is ready before connections.

### 3.5 Split-brain stance

Procedural prevention, no election: exactly one node per swarm starts without `--bootstrap`; the persistence guard makes accidental re-founding impossible after first start. Partitions *within* one base heal via Autobase causal merging (replaceable conflicts already resolve deterministically via `shouldReplace`). Merging two already-populated bases is an explicit operator action using new CLI tools: `nostr-swarm export --storage <dir>` dumps all events as JSONL from a read-only view open; the node restarts on a fresh storage path with `--bootstrap`, gets admitted, then `nostr-swarm import --url ws://127.0.0.1:<port>` replays the JSONL through the normal validated WS path. Events are self-certifying and id-deduped in applyPut, so replay is idempotent.

### 3.6 v2: in-band admission channel (implemented)

Originally specified here as a seam; now implemented in `src/swarm/admission.ts` with the wire contract and proof in `src/swarm/protocol.ts`. Both sides are opt-in (`--auto-admit` granter, `--request-writer` joiner) and default off, so the baseline operator-driven `--admit` flow is unchanged. The contract:

- Protomux channel `nostr-swarm/admission@1` via `Protomux.from(socket)` (coexists with replication on the same muxer; `createChannel` returns null on duplicates — must be handled; all handlers try/caught, since a throw destroys the connection including replication).
- Handshake (JSON): `{ v: 1, writerKey: <hex64>, wants: 'writer' | 'reader', proof: <hex64> }` where `proof = HMAC-SHA256(key = base.key, data = utf8('nostr-swarm/admit/1') || conn.handshakeHash || writerKeyBytes)` — proof of invite possession, channel-bound to the Noise session (replay-proof), no persistent swarm seed needed.
- Reply message: `{ admitted: boolean, reason?: string }`. Granter checks proof, writers-sub dedup, the 64 cap, and a per-admitter token bucket (16 admissions/hour) before appending `add_writer`. Joiner watches `'writable'`.

## 4. CLI / env / config additions (exact)

| Flag | Env | RelayConfig field | Default |
|---|---|---|---|
| `--bootstrap <invite\|hex64>` | `BOOTSTRAP_KEY` | `bootstrap: string` | `''` (found) |
| `--admit <hex64>` (repeatable, parseArgs `multiple: true`) | `ADMIT_WRITERS` (comma-separated) | `admitWriters: string[]` | `[]` |

Constructor-only (off CLI/env, for tests/private DHTs): `NostrSwarm({ network: { dhtBootstrap?: { host: string; port: number }[] } })` → `new Hyperswarm({ bootstrap })`. New CLI subcommands `export` / `import` dispatched before parseArgs. Existing env-over-CLI precedence is preserved for consistency and documented (`BOOTSTRAP_KEY` beats `--bootstrap`). `--topic`/`SWARM_TOPIC` semantics are unchanged. Start9: nullable config fields `bootstrap-key` (pattern `^(nsw1[a-z0-9]+|[0-9a-fA-F]{64})?$`) and `admit-writers`; `docker_entrypoint.sh` exports `BOOTSTRAP_KEY`/`ADMIT_WRITERS`; `properties.ts` surfaces the invite and local writer key from `keys.json` as copyable fields.

## 5. Security considerations

Trust boundary = the writer set. Possession of the base key grants read replication (the DHT sees only hashes; transport is Noise IK, mutually authenticated and encrypted). Write power requires manual operator admission; any writer can admit (autopass model) — acceptable because writers are operator-vetted. Apply-side verification means even a rogue admitted writer can only inject validly signed Nostr events — it cannot forge events, delete others' events, or censor via tombstones; its damage is bounded to storage spam (WS-edge rate limits don't apply to it, but the 64-writer cap and manual admission bound exposure). WoT stays a local pre-append/serve-time policy, never an apply rule (per-node graphs would diverge views). The consensus change ships safely because no shared multi-writer base exists in the wild; docs state all peers of one base must run ≥ this version.

## 6. Accepted limitations (with rationale)

1. **Restart-to-admit UX**: clunky but operator-error-tolerant; Start9 config edits already restart the service. The fully specified §3.6 channel removes it in v2.
2. **Founder is sole indexer**: founder loss stalls checkpoints/fast-forward (writes still merge; cold joins linearize slowly). Chosen over churn-induced quorum stalls; founder storage backups are documented as operationally critical. Indexer promotion deferred.
3. **Pear/light clients are read-mostly**: they replicate and read but write via a relay's WS endpoint. `optimistic: true` is reserved now so v2 can add self-verifying optimistic writes without a consensus bump.
4. **Two-founder operator error** creates a permanent split; recovery is export/import. No in-band detection in v1.
5. **Writer set only grows** (no removeWriter — historically buggy upstream; last indexer irremovable); bounded at 64.
6. **Apply-rule changes on pre-existing logs**: previously stored NIP-70 events and old-format tombstones live in already-materialized views; joiners adopting a legacy founder's base rely on Autobase fast-forward (default on) to inherit the signed view, and only the short un-indexed tail (founder acks at 1s `ackInterval`) re-applies under new rules. Cleanest shared bases start from a fresh founder; documented.
7. **Reorg re-emission**: the LRU suppresses duplicate `event:stored` pushes but cannot un-send a transiently applied event.
8. **Env-over-CLI precedence** kept (consistent with every existing knob), documented as a foot-gun.

## 7. Test strategy (no public DHT, ever)

Add `hyperdht@^6.21.0` to devDependencies (matching hyperswarm's transitive range to avoid handshake skew). Import `createTestnet` from `'hyperdht/testnet.js'` — the `.js` subpath is mandatory (hyperdht has no exports map). Per suite: `beforeAll: tn = await createTestnet(3)`, `afterAll: await tn.destroy()` (testnet nodes bind real loopback UDP sockets; vitest leaks handles otherwise). Every relay gets `{ network: { dhtBootstrap: tn.bootstrap } }` → `new Hyperswarm({ bootstrap })` — never share a Testnet node via `opts.dht` (Hyperswarm.destroy() force-destroys injected DHTs). `tests/helpers.ts` gains `waitFor(predicate, { timeout, interval })` polling (keyed on the store's `'update'` event where possible) and scrubs `SWARM_TOPIC`/`WS_PORT`/`STORAGE_PATH`/`BOOTSTRAP_KEY`/`ADMIT_WRITERS` from `process.env` (env beats overrides in loadConfig). The existing integration suites are migrated onto the testnet, fixing their hidden internet dependency. Multi-node suites raise testTimeout to 60s.

## 8. Implementation phases

Each phase is one commit, independently shippable, with a runnable check.

**Phase 1 — Offline DHT test infrastructure.** Thread `dhtBootstrap` (constructor-only) NostrSwarm → SwarmNetwork → `new Hyperswarm({ bootstrap })`; add hyperdht devDep, `getTestnet()`/`waitFor` helpers, env scrub; migrate existing integration tests onto the testnet. Done: `npx vitest run tests/integration/relay.test.ts tests/integration/store.test.ts` passes.

**Phase 2 — Invite codec, bootstrap resolution, config/CLI surface.** `src/util/invite.ts`, `src/storage/bootstrap.ts`, RelayConfig fields, env/CLI wiring, z32 dep, unit tests. Not yet wired into relay.ts. Done: `npx vitest run tests/unit/invite.test.ts tests/unit/bootstrap.test.ts && npm run typecheck`.

**Phase 3 — Consensus hardening.** Apply rules 1-7 of §3.3, `optimistic: true`, pinned nostr-tools, LRU dedup, indexes-getter invalidation, NIP-70 WS rejection, light-prune no-op. Done: `npx vitest run tests/integration/store.test.ts tests/unit/events.test.ts && npm run typecheck`.

**Phase 4 — Multi-writer admission core.** `add_writer` op + `writers` sub + cap; `writable`/`localWriterKey`/`isFounder`/`admitWriter`; relay threading (resolveBootstrap → EventStore bootstrap; `--admit` processing; key logging + keys.json); `base.replicate` switch; WS read-only gate; WoT thunk; holepunch.d.ts typings; multinode integration suite. Done: `npx vitest run tests/integration/multinode.test.ts && npm run typecheck`.

**Phase 5 — Export/import merge tooling.** `src/tools/migrate.ts` + CLI dispatch + round-trip test. Done: `npx vitest run tests/integration/export-import.test.ts`.

**Phase 6 — Start9 packaging.** Config fields, entrypoint exports, properties from keys.json, migrations bump. Done: `bash -n start9/docker_entrypoint.sh && npx tsx -e "await import('./start9/scripts/procedures/getConfig.ts'); await import('./start9/scripts/procedures/properties.ts')"`.

**Phase 7 — Documentation truth pass.** Rewrite all false-convergence sections (README.md:9-13/104-112/154/188-223/266-274 and tables; architecture.md:7/44-54/89/330-388/417-446; clients.md:25/74-82/118-153/184-210/284-313; start9.md:7-15/93-109/153/156-171; web-of-trust.md WoT-is-not-consensus note; start9/instructions.md); write the §3.6 spec into protocol.ts's header. Done: `! grep -n "regardless of join order" README.md docs/architecture.md docs/clients.md docs/start9.md && grep -q -- "--bootstrap" README.md && grep -q "admission@1" src/swarm/protocol.ts`.

## 9. Migration for existing deployments

Zero-action upgrade. No `--bootstrap` means a node keeps reopening its own founded base (for an existing base, bootstrap = own `base.key`); first post-upgrade start records `base.key` into `<storagePath>/bootstrap-key` and `keys.json` (recording identity, not changing it). Old logs contain only put/delete ops already validated at the WS layer, and a single-node founder's signed view never reorgs historical state. Behavior changes: NIP-70 protected events are now rejected, and light-client TTL pruning is disabled (§3.4, §6). Start9 backups remain valid; the storage layout only gains `bootstrap-key` and `keys.json`.

---

## Appendix: Phase contracts (for fresh-context implementation agents)

Each phase below is self-contained: implementers read this document and the listed input files only. One phase = one commit. The done-when command must pass before the commit.

### Phase 1: Offline DHT test infrastructure

**Goal.** All tests run against a local hyperdht testnet instead of the public Hyperswarm DHT, and a constructor-only dhtBootstrap option is threaded through NostrSwarm -> SwarmNetwork -> Hyperswarm. This unblocks every later multi-node test and fixes the existing suites' hidden internet/UDP dependency.

**Input files.**
- `package.json`
- `src/swarm/network.ts`
- `src/relay.ts`
- `src/types/holepunch.d.ts`
- `tests/helpers.ts`
- `tests/integration/relay.test.ts`
- `vitest.config.ts`
- `docs/design/multiwriter-sync.md`

**Deliverables.**
- Add hyperdht@^6.21.0 to devDependencies (match hyperswarm's transitive range)
- SwarmNetwork constructor accepts opts { dhtBootstrap?: { host: string; port: number }[] } and passes new Hyperswarm({ bootstrap: dhtBootstrap }) when set (src/swarm/network.ts:13)
- NostrSwarm constructor accepts network?: { dhtBootstrap?: { host: string; port: number }[] } (constructor-only, NOT on RelayConfig/CLI/env) and forwards it to SwarmNetwork (src/relay.ts:35)
- Hyperswarm constructor opts { bootstrap } added to src/types/holepunch.d.ts; declaration for 'hyperdht/testnet.js' added (note: the .js subpath is mandatory, hyperdht has no exports map)
- tests/helpers.ts: getTestnet() suite-singleton wrapping createTestnet(3) from 'hyperdht/testnet.js', destroyTestnet() for afterAll, waitFor(predicate, { timeout, interval }) polling helper, env scrub of SWARM_TOPIC/WS_PORT/STORAGE_PATH/BOOTSTRAP_KEY/ADMIT_WRITERS; createRelay() always threads { network: { dhtBootstrap: tn.bootstrap } } (bootstrap-array form only — never share a Testnet node via opts.dht because Hyperswarm.destroy() force-destroys injected DHTs)
- tests/integration/relay.test.ts migrated to the testnet (beforeAll creates testnet, afterAll destroys it after relays stop)

**Done when.** `npx vitest run tests/integration/relay.test.ts tests/integration/store.test.ts && npm run typecheck`

### Phase 2: Invite codec, bootstrap resolution, config/CLI surface

**Goal.** Typo-proof bootstrap-key handling exists and the config surface is wired (not yet consumed by relay.ts): 'nsw1' z32 checksummed invites, strict parsing that fails fast, and a persistence guard that makes accidental re-founding impossible.

**Input files.**
- `src/util/types.ts`
- `src/util/config.ts`
- `src/cli.ts`
- `package.json`
- `docs/design/multiwriter-sync.md`

**Deliverables.**
- src/util/invite.ts: encodeInvite(baseKey: Buffer): string ('nsw1' + z32(0x01 || key32 || sha256(0x01||key32)[0..4))), decodeInvite(code: string): Buffer throwing on bad prefix/version/length/checksum, parseBootstrap(value: string): Buffer | null ('' -> null; nsw1 invite -> decode; 64-hex -> Buffer; else throw)
- z32 promoted to a direct dependency in package.json (already installed transitively)
- src/storage/bootstrap.ts: resolveBootstrap(storagePath, configured) implementing the persistence guard (<storagePath>/bootstrap-key file; fatal on mismatch; persist configured key; null when neither), persistBootstrapKey(storagePath, key), writeKeysFile(storagePath, baseKey, writerKey) producing keys.json { baseKey, invite, writerKey }
- RelayConfig gains bootstrap: string (default '') and admitWriters: string[] (default []) in src/util/types.ts and src/util/config.ts defaults; loadConfig wires envStr('BOOTSTRAP_KEY', ...) and ADMIT_WRITERS comma-split following the existing override pattern
- src/cli.ts: --bootstrap <string> flag and --admit <string> repeatable flag (parseArgs multiple: true) mapped to overrides; --help documents both flags, both env vars, the founder/joiner workflow, and that env beats CLI (existing precedence, kept)
- Unit tests: tests/unit/invite.test.ts (round-trip, corrupted checksum rejected, wrong version rejected, raw-hex accepted, garbage fatal) and tests/unit/bootstrap.test.ts (persist/reload, mismatch fatal, founder-null path)

**Done when.** `npx vitest run tests/unit/invite.test.ts tests/unit/bootstrap.test.ts && npm run typecheck`

### Phase 3: Consensus hardening in EventStore and policy alignment

**Goal.** apply() becomes a safe deterministic consensus function before any writer is ever admitted: re-validates everything, fixes the forged-tombstone and replaceable-pointer bugs, handles NIP-70 consistently end-to-end, reserves optimistic mode, and removes the stale-cached-subs and forged-prune hazards.

**Input files.**
- `src/storage/store.ts`
- `src/storage/indexes.ts`
- `src/nostr/events.ts`
- `src/nostr/nip-70.ts`
- `src/nostr/nip-11.ts`
- `src/ws/handler.ts`
- `src/light/store.ts`
- `src/wot/graph.ts`
- `src/relay.ts`
- `package.json`
- `tests/integration/store.test.ts`
- `docs/design/multiwriter-sync.md`

**Deliverables.**
- package.json pins nostr-tools exactly to "2.23.3" (no caret) — verifyEvent is now a consensus rule
- Autobase constructed with optimistic: true (reserved; apply never acks optimistic blocks in v1) — decided now because it cannot be retrofitted without a consensus bump
- apply() put/delete branches re-validate with validateEventStructure + verifyEventSignature and skip invalid ops deterministically; ops carry optional v field, apply calls host.interrupt on v > 1 (CONSENSUS_VERSION = 1)
- NIP-70: apply skips ["-"]-tagged events unconditionally; src/ws/handler.ts rejects them unconditionally with 'blocked: protected events (NIP-70) are not accepted by replicated relays' (replacing the auth-gated accept at handler.ts:107-109); NIP-70 removed from supported_nips in src/nostr/nip-11.ts
- Tombstones become { id: deletionEventId, pubkey: deleterPubkey }; applyPut blocks a put on tombstone only when pubkey matches the event author; legacy string tombstones still block unconditionally (read leniently)
- removeIndexes deletes replaceable/addressable pointers only if the pointer still references the deleted event id
- 'event:stored' emissions deduped via a bounded 4096-id LRU inside EventStore
- indexes getter invalidates its cached subs whenever base.view identity changes; WotGraph.rebuild/startRefresh signatures change to accept getIndexes: () => IndexSubs and relay.ts passes () => this.store.indexes
- LightStore.prune becomes a warn-once no-op (forged unsigned kind-5 ops are dropped by apply verification anyway; LIGHT_MAX_STORAGE degrades to a warning)
- store.test.ts extended: bad-sig put skipped, forged-tombstone no longer censors a later legitimate put, author-scoped delete enforcement, protected-event skip, pointer-ownership preservation when deleting a superseded replaceable event, op v>1 interrupt

**Done when.** `npx vitest run tests/integration/store.test.ts tests/unit/events.test.ts && npm run typecheck`

### Phase 4: Multi-writer admission core

**Goal.** The actual gap closes: relay.ts passes a resolved bootstrap into EventStore, add_writer ops admit operator-approved writers (indexer:false, 64 cap), joiners serve reads immediately and gate writes until writable, and a multi-node integration suite proves convergence on a local testnet.

**Input files.**
- `src/storage/store.ts`
- `src/storage/indexes.ts`
- `src/storage/bootstrap.ts`
- `src/util/invite.ts`
- `src/util/types.ts`
- `src/relay.ts`
- `src/swarm/network.ts`
- `src/ws/handler.ts`
- `src/types/holepunch.d.ts`
- `tests/helpers.ts`
- `docs/design/multiwriter-sync.md`

**Deliverables.**
- StoreOp gains { type: 'add_writer'; key: string; v?: number }; apply() branch: validate /^[0-9a-f]{64}$/, dedup against writers sub, enforce 64-writer cap deterministically, host.addWriter(Buffer.from(key,'hex'), { indexer: false }), record { addedBy: node.from.key hex } in the new 'writers' sub added to IndexSubs/createSubs
- EventStore: get writable, get localWriterKey (base.local.key), get isFounder (base.key equals base.local.key), admitWriter(keyHex) returning 'appended'|'already-admitted'|'cap-reached' (throws if not writable), listWriters(); re-emit base 'writable' and 'update' events; ready() logs invite + raw base key + local writer key
- relay.ts: resolveBootstrap(storagePath, config.bootstrap) runs before EventStore construction and its result is passed as the second EventStore arg (relay.ts:33); after store.ready(), persist founder base.key via persistBootstrapKey and write keys.json; process config.admitWriters once writable (at ready if already writable, else on the 'writable' event), skipping already-admitted keys
- src/swarm/network.ts:27 switches corestore.replicate(socket) to store.base.replicate(socket) for protomux-wakeup writer hints
- src/ws/handler.ts: before putEvent/deleteEvent, reply ["OK", id, false, "blocked: read-only replica awaiting writer admission"] when !store.writable
- holepunch.d.ts grows: apply host { addWriter(key, opts), ackWriter(key), removeWriter(key), interrupt(reason) }, base.local, base.writable, base.replicate, base.discoveryKey, 'writable'/'update' events, optimistic constructor option
- tests/integration/multinode.test.ts (testTimeout 60s, local testnet): (1) joiner's base.key equals founder's; (2) event published to founder appears via REQ on joiner (read replication); (3) EVENT to unadmitted joiner returns the blocked OK; (4) after admitWriter, joiner becomes writable and events flow joiner->founder; (5) restarting with the same --admit yields exactly one writers-sub entry; (6) author-valid NIP-09 delete propagates; (7) light-client joiner never becomes writable and injects no kind-5 forgeries

**Done when.** `npx vitest run tests/integration/multinode.test.ts && npm run typecheck`

### Phase 5: Export/import merge tooling

**Goal.** Two already-populated single-node deployments can converge: a JSONL export from an old storage dir replays through the normal validated WS path of a node admitted to the canonical base, idempotently by event id.

**Input files.**
- `src/cli.ts`
- `src/storage/store.ts`
- `src/storage/query.ts`
- `src/storage/indexes.ts`
- `tests/helpers.ts`
- `docs/design/multiwriter-sync.md`

**Deliverables.**
- src/tools/migrate.ts: runExport(storageDir) opens the EventStore read-only and streams every event from the events sub as JSONL to stdout (skipping events failing validateEventStructure/verifyEventSignature, e.g. legacy forged prune ops); runImport(url) reads JSONL on stdin, sends each as a NIP-01 EVENT over ws, awaits OK responses, exits non-zero on connection failure, treats 'duplicate:' OKs as success
- src/cli.ts dispatches subcommands before parseArgs: 'nostr-swarm export --storage <dir>' and 'nostr-swarm import --url ws://host:port'; --help documents the two-node merge runbook (export old, restart on fresh storage with --bootstrap, get admitted, import)
- tests/integration/export-import.test.ts: seed a standalone EventStore with signed events plus one invalid record, export, assert JSONL contents; import into a running relay on the local testnet and assert all valid events queryable and idempotent on re-import

**Done when.** `npx vitest run tests/integration/export-import.test.ts && npm run typecheck`

### Phase 6: Start9 packaging

**Goal.** Start9 operators can join and admit peers from the UI: bootstrap-key and admit-writers config fields flow to env vars, and the node's invite + writer key are copyable properties (config edits already restart the service, which is exactly the admit workflow).

**Input files.**
- `start9/scripts/procedures/getConfig.ts`
- `start9/scripts/procedures/setConfig.ts`
- `start9/scripts/procedures/properties.ts`
- `start9/scripts/procedures/migrations.ts`
- `start9/docker_entrypoint.sh`
- `start9/manifest.yaml`
- `docs/design/multiwriter-sync.md`

**Deliverables.**
- getConfig.ts: nullable 'bootstrap-key' string field (pattern ^(nsw1[a-z0-9]+|[0-9a-fA-F]{64})?$, description explaining paste-to-join vs leave-empty-to-found) and nullable 'admit-writers' string field (comma-separated 64-hex writer keys)
- docker_entrypoint.sh: export BOOTSTRAP_KEY and ADMIT_WRITERS via the existing get_yaml_value pattern (only when non-empty, matching SWARM_TOPIC handling)
- properties.ts: read /data/nostr-swarm-data/keys.json and expose 'Relay Invite' (copyable, the nsw1 string) and 'Local Writer Key' (copyable) alongside existing properties; degrade gracefully when keys.json is absent
- migrations.ts + manifest.yaml: version bump entry injecting null defaults for the two new config keys; no data transform (existing installs upgrade zero-action and keep their base)

**Done when.** `bash -n start9/docker_entrypoint.sh && npx tsx -e "await import('./start9/scripts/procedures/getConfig.ts'); await import('./start9/scripts/procedures/properties.ts'); await import('./start9/scripts/procedures/migrations.ts')"`

### Phase 7: Documentation truth pass and v2 protocol seam

**Goal.** Every false convergence claim is rewritten to describe the founder/joiner + operator-admission reality, new flags are documented, and protocol.ts carries the complete v2 in-band admission channel contract so a later release can implement it without redesign.

**Input files.**
- `README.md`
- `docs/architecture.md`
- `docs/clients.md`
- `docs/start9.md`
- `docs/web-of-trust.md`
- `docs/design/multiwriter-sync.md`
- `src/swarm/protocol.ts`
- `start9/instructions.md`

**Deliverables.**
- README.md: rewrite How-it-works (9-13), Deployment (104-112, 154), Pear client (188-223 — replace the undefined bootstrapKey free variable with the invite flow and read-mostly client reality), Architecture (225-241), keytr (266-274); add --bootstrap/--admit + BOOTSTRAP_KEY/ADMIT_WRITERS to CLI/env tables; document founder/joiner workflow, read-only-until-admitted semantics, NIP-70 rejection, and light-prune deprecation
- docs/architecture.md: fix 7, 44-54, 89, 330-347 (how peers actually sync), 349-354 (bootstrap key problem -> solved, describe resolveBootstrap guard), 356-388, 417-446 (config table); document apply() as a versioned consensus function, founder-as-sole-indexer rationale, and the fast-forward reliance for legacy founders
- docs/clients.md: fix 25, 74-82, 118-153, 184-201 (writes require admission; clients are read-mostly), 203-210, 284-296 (invite codec replaces 'copy from logs'), 298-313 comparison table
- docs/start9.md: fix 7-15, 93-109 (config table + new fields), 153, 156-171 (replace 'no manual peering needed' with the copy-invite-from-properties workflow); update start9/instructions.md to match
- docs/web-of-trust.md: new section stating WoT is a local pre-append/serve-time policy, never an apply/consensus rule, and that apply independently re-verifies signatures
- src/swarm/protocol.ts: header comment replaced with the full v2 admission-channel contract — protomux channel 'nostr-swarm/admission@1' via Protomux.from(socket) (null-check duplicate channels, try/catch all handlers since a throw destroys replication), handshake { v: 1, writerKey: hex64, wants: 'writer'|'reader', proof: hex64 } with proof = HMAC-SHA256(key = base.key, data = utf8('nostr-swarm/admit/1') || conn.handshakeHash || writerKeyBytes), reply { admitted: boolean, reason?: string }, granter-side checks (proof, writers-sub dedup, 64 cap, 16 admissions/hour token bucket)

**Done when.** `! grep -n "regardless of join order" README.md docs/architecture.md docs/clients.md docs/start9.md && grep -q -- "--bootstrap" README.md && grep -q "admission@1" src/swarm/protocol.ts && npm run typecheck`
