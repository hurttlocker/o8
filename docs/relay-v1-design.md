# o8 Relay v1 — off-network reach for the mobile window (PROPOSAL)

Status: **APPROVED — Q gate passed 2026-07-08.** Rulings: (1) separate `o8-relay` Railway service per D1; (2) entitlement = all-paid in principle, which today means **founders-only** (the $19 tier isn't offered yet — flag maps founder→true, future paid→true at launch, free→false); (3) LAN-first pairing confirmed for v1; hostname `relay.o8.run`. Phase B in progress; `railway up` remains Q-gated. Ruling context: `~/Obsidian/cashcoldgame-wiki/concepts/o8-remote-access-ruling-2026-07-08.md` — mobile IS the remote window; the relay closes the one real gap (off-network reach); no web surface; cloud runners stay parked; execution never leaves the user's Mac.

## Hard constraints (from the ruling — violating any of these means the design is wrong)

1. **The Mac dials OUT only.** No inbound ports, no port-forwarding, no Tailscale requirement. LAN/Tailscale direct connection stays working unchanged and remains the fallback of record.
2. **Zero-knowledge relay.** The relay forwards E2EE ciphertext frames between two sockets. It never holds a session key, never reads a frame body, never terminates the E2EE handshake. Its total knowledge: routing identifiers, connection presence, entitlement verdicts, and (transiently) APNs tokens for push.
3. **Per-device tokens + 4401/4403 revocation semantics survive the relay hop** unchanged — revocation is decided on the Mac, not the relay.
4. **Entitlement-gated** behind `relay.offNetwork` via the license server. Runs on Railway next to license-server.

## Verified ground truth this design builds on (scout 2026-07-08)

- E2EE (`o8-mobile/src/o8/e2ee.ts`, `ws.ts`; `o8/docs/mobile-e2ee.md`) wraps **WS frames only** at the raw-frame seam — `{e2ee:1, n:<24B nonce>, c:<ciphertext>}`, XSalsa20-Poly1305, X25519 ephemeral + Ed25519 identity, **server(Mac)-initiated** handshake, loopback connections skip it, flag `O8_MOBILE_E2EE` (default OFF, raw fallback after 1500ms grace). **The `/api/mobile/*` HTTP surface is NOT encrypted today** — plaintext + Bearer.
- Client config is one object (`o8-mobile/src/o8/client.ts:12-18`): `{host, apiPort, wsPort, token, serverIdentityPublicKey?}` from the pairing QR; `apiBase=http://host:apiPort`, `wsUrl=ws://host:wsPort/ws?token=…`.
- Per-device registry (token_hash, identity_public_key, revoked_at) is **desktop-side SQLite** (`~/.o8`, `@/lib/mobile/device-registry`). The license server has **no device registry** and mints only a `plan` claim (Hono + Postgres/Drizzle + jose EdDSA, Railway/NIXPACKS, `railway.json`, `/health`).
- Entitlement flags (`relay.offNetwork`, `cloud.runners`) are resolved **locally from `plan`** by twin `resolveFlags(plan)` maps (mobile `entitlement.ts:22-45` ≡ desktop `src/lib/entitlement/flags.ts`); both relay flags are hardcoded `false` today — the plumbing exists, only the value + server-side source are missing.
- Push is Mac-driven APNs (ActivityKit tokens registered to the Mac via `/api/mobile/live-activity/register`; p8 key desktop-side). No hosted push exists — off-network, a blocked approval is currently invisible until the app polls.
- WS close codes: **4401** token revoked, **4403** handshake rejected (client stops reconnecting, forces re-pair).

## Design

### D1. Service shape: SEPARATE Railway service (`o8-relay`), not a license-server module

- The relay is a long-lived WebSocket concentrator (hundreds of persistent sockets, memory-shaped, latency-sensitive). The license server is stateless request/response tied to payments. Different scaling knobs, different blast radii: a wedged relay must never take down licensing/Stripe webhooks, and relay deploys will iterate much faster than payment code.
- Shared code: the relay verifies the same plan-JWT (jose, same public key) and applies the same `resolveFlags(plan)` map. v1 accepts a third copy of the ~20-line flag map with a loud drift comment; the durable fix (license server embedding flags in the JWT) is noted as follow-up so all three copies collapse.
- Stack: same as license-server (Hono + `ws`, TypeScript, NIXPACKS, `/health`) so the ops story is one story.

### D2. Topology & rendezvous — the QR-pinned identity IS the address

```
Mac connector ──outbound wss──► relay.o8.run ◄──wss── phone
        (auth: plan JWT + macRoutingId)      (routing: macRoutingId; auth: NONE at the relay)
```

- **`macRoutingId` = SHA-256(Mac's E2EE identity public key), first 16 bytes, base58.** The phone already pins this exact public key from the pairing QR (`serverIdentityPublicKey`) — so every already-paired phone can derive the routing address with **zero new pairing material**, and the id is stable across IPs/networks.
- **Mac side:** a connector in the desktop app dials `wss://relay.o8.run/mac` with `Authorization: Bearer <plan JWT>` + `x-o8-routing-id`. The relay verifies the JWT signature, checks `resolveFlags(plan)['relay.offNetwork']`, and registers the socket in an in-memory `routingId → macSocket` map. Reconnect with backoff; one Mac = one socket; a second registration for the same routingId supersedes the first (Mac restarts self-heal).
- **Phone side:** dials `wss://relay.o8.run/device/{macRoutingId}`. **The relay does not authenticate phones** — it cannot (the device registry is on the Mac, and that is the zero-knowledge point). It admits the socket, pipes it to the Mac connector, and the Mac's existing per-device token + E2EE handshake accept or reject end-to-end. Anti-abuse at the relay is rate limiting only: N pending unauthenticated sockets and M connection attempts/min per routingId; a socket that hasn't completed the Mac-side handshake in 10s is dropped.
- **Mac-side ingestion:** the connector bridges each relayed phone socket into the local ws-server as a distinct connection carrying an authoritative remote marker (the WS analog of the existing `x-o8-client-addr` socket-truth header), so the desktop **never treats a relayed socket as loopback**: the E2EE handshake is REQUIRED (no raw fallback over the relay — a relayed connection that fails the handshake is closed 4403), and per-device token validation runs exactly as on LAN.

### D3. Framing — everything rides the existing E2EE envelope; HTTP tunnels inside it

- The relay pipes **opaque bytes** between phone socket and a per-phone virtual stream on the Mac connector socket (a thin multiplex header `{sid, seq}` around the untouched `{e2ee:1,n,c}` frames). It never parses inner frames.
- **HTTP tunneling decision: WS multiplexing, not HTTP proxying.** Because `/api/mobile/*` is plaintext today, letting the phone POST HTTPS to the relay would make the relay a plaintext middlebox — violating constraint 2. Instead, off-network mode adds one frame pair **inside the E2EE channel**: `http-req {rid, method, path, headers(subset), bodyB64}` → Mac connector performs the request against `127.0.0.1:{apiPort}` (path allowlisted to `/api/mobile/*`) → `http-res {rid, status, headers(subset), bodyB64}`. The phone's `client.ts` gains a transport switch: direct `fetch` on LAN (unchanged), `http-over-frames` when connected via relay. Existing Bearer semantics ride inside the tunnel untouched.
  - Rejected alternative — relay HTTP proxying: simpler client code, but the relay would read every approval payload; wrong by constraint 2. Rejected — extending frame crypto to raw HTTP: two crypto paths to maintain for the same bytes.
- **Consequence stated plainly:** off-network traffic is *more* private than today's LAN traffic (everything E2EE'd inside TLS), and the relay learns nothing but frame sizes and timing.

### D4. Presence, Mac-offline semantics, and push

- The relay tracks presence trivially (it owns both socket maps). Control frames (relay↔endpoints only, the one unencrypted vocabulary, carrying zero user content): `presence {mac: up|down}` to phones; `devices {count}` to the Mac connector.
- **Mac offline:** phone connects → relay accepts, immediately sends `presence {mac: down}` and holds the socket up to 60s for a Mac reconnect, then closes with **4408 `mac_offline`** (new relay-namespace close code; 44xx chosen to avoid 4401/4403 collision). **Mutations are never queued for replay** — no stored actions, no wake-on-LAN. The phone renders "Mac is offline" honestly.
- **Queue-and-notify:** the notify half lives at the relay. When the Mac connector comes up, the relay sends it `devices {count: 0}`; when the Mac has a blocked approval and no live phone socket, it sends the relay `push-req {apnsToken, environment, kind}` (a control frame; the token is routing metadata the Mac already holds from ActivityKit registration). The relay holds the o8 APNs .p8 key and sends a **generic** push ("o8 needs you — approval waiting", no content). The relay stores APNs tokens **transiently per request** — nothing durable. Mac-driven Live Activity push on LAN continues unchanged.
- Stale sweep: relayed phone sockets idle >10min with no Mac socket are closed 4408.

### D5. Revocation across the hop

4401/4403 are emitted by the **Mac** exactly as today; the connector forwards the close through the relay, which closes the phone socket with the same code, and the client's existing `markRevoked()` path runs unchanged. Relay-origin closes use the distinct 4408 (`mac_offline`) / 4409 (`entitlement_lapsed` — plan JWT expired or flag off at connect or on the relay's daily re-check) so a client can always tell "the Mac rejected me" from "the relay can't route me".

### D6. Entitlement & pairing

- Gate: the **Mac's** relay connector only dials out when `resolveFlags(plan)['relay.offNetwork']` is true locally AND the relay re-verifies the same from the presented JWT — belt and braces, and the flag flips from hardcoded `false` to plan-derived in both twin maps (+ the relay's copy). Which plans get it = **Q's call** (decision summary).
- **Remote first-pairing: not in v1.** Pairing stays LAN-first (QR at the Mac establishes device keys, per-device token, pinned identity). The relay serves already-paired devices only. This is the accepted v1 ruling; a signed one-time remote-pair blob is sketched as v2 if founders demand it.

### D7. Cost at ~40-founder scale

~40 Macs + ~40 phones = ≤120 concurrent sockets, ciphertext frame relay only (KB/s-scale except diff pulls). One Railway service, 256–512MB, no database (in-memory maps + APNs key): **~$5–10/mo**, well inside the founder patronage envelope. Scale ceiling before re-architecture: ~5k sockets on one instance; sharding by routingId hash is the eventual story, not v1's.

### D8. What Phase B builds (scoped)

1. The private `o8-relay` service (Hono+ws, Railway config, /health, rate limits, APNs sender, control-frame vocabulary above).
2. Desktop connector (`src/lib/mobile/relay-connector.ts` + settings toggle): outbound dial, JWT presentation, socket bridging with the remote marker, `push-req` on blocked approvals, LAN unaffected when relay is down.
3. Mobile leg (mobile agent, against §Wire contract): config gains `relayRoutingId` derived from the pinned key; transport switch (direct on LAN, relay+http-over-frames off-network); presence/4408/4409 UX.
4. **approvalId punchlist (desktop half):** the handler already resolves approvalId-first (`action/route.ts:364-368`); Phase B hardens it — when `approvalId` is present it is authoritative and session fallback is skipped entirely; stale-`sessionKey`-cannot-mistarget proven by a contract test; sessionKey-only addressing kept for old clients.
5. Contract tests (`scripts/contract-test.ts` style) + live cross-network e2e (relay round trip, mid-session revocation, Mac-disconnect → push). `railway up` is **Q-gated**.

## Resolutions to the mobile redline (2026-07-08, desktop lane — all R1–R8 accepted)

- **R1 → no maintained allowlist; the existing middleware is the gate.** The connector does NOT tunnel to `127.0.0.1` as a loopback caller. It replays each `http-req` against the local Next app stamping the socket-truth header `x-o8-client-addr` with a **non-loopback** marker AND attaching the device's `Authorization: Bearer` — so `src/middleware.ts` default-deny runs per-route exactly as it does for a LAN phone. Result: all 26 paths across 11 prefixes work off-network with their existing policies, nothing is silently dropped, and we never build a parallel allowlist that drifts or a loopback-trusted tunnel that sidesteps the gate (which the security doctrine forbids). The connector's only path constraint is a deny of anything the middleware itself wouldn't allow a remote Bearer client — i.e. none of our own; the gate decides.
- **R2 → first-frame `auth {token}` on every bridged socket, loopback-trust explicitly closed.** Adopted verbatim. The bridged ws-server connection is held unauthenticated — no channel traffic, no `http-req` processed — until it sends `auth {token}` and the Mac validates it against the device registry (`@/lib/mobile/device-registry`); invalid → close `4403`. Because R1 removes loopback-trust for tunneled HTTP, the device token + the mandatory E2EE handshake are the complete, explicit off-network auth story — stated here so it is never implicit.
- **R3 → option (a): real remote-notification registration.** Mobile adds `registerForRemoteNotifications` → a standard APNs **device token**, registered to the Mac alongside the ActivityKit token (new field on `/api/mobile/live-activity/register` or a sibling route — desktop stores both). The relay's `push-req` carries that alert-capable token; the relay sends `apns-push-type: alert`, generic body. ActivityKit update/push-to-start tokens are untouched (LAN Live Activities unchanged). Boring and reliable, per the redline.
- **R4 → published limits:** ≤8 pending un-authed `/device` sockets per routingId; ≤30 device-connect attempts/min per routingId; the 10s handshake deadline starts at **socket-admit**, not DNS. Client back-off must stay under these; the direct-first prober's relay fallback is well within 30/min.
- **R5 → per-transport E2EE, accepted.** LAN keeps today's behavior (flag `O8_MOBILE_E2EE`, 1500ms raw grace). Relay is **mandatory, fail-closed** — a relayed socket that doesn't complete the handshake is closed `4403`, no raw fallback. Devices paired before `serverIdentityPublicKey` existed in the QR get honest **"re-pair at your Mac to enable remote"** UX (they can derive neither routingId nor a session key) — not an error state.
- **R6 → chunked responses, accepted.** `http-res` gains a continuation `http-res-part {rid, i, last}`; the connector streams the local response in ≤256KB post-base64 chunks; no hard size cap (diffs already accept a client `maxBytes`). A logical response exceeding a generous relay ceiling (env, default 32MB) returns an `http-res {rid, status:413, error:"tunnel_response_too_large"}` the client renders.
- **R7 → 4408/4409 never touch revocation, accepted.** Contract-stated client expectations: `4401`/`4403` → `markRevoked()` + re-pair (Mac-origin, unchanged); `4408` → offline UX + backoff retry; `4409` → stop relay attempts until entitlement refresh. Distinct namespaces guarantee a client can't confuse "Mac rejected me" with "relay can't route me".
- **R8 → derive `relayRoutingId` at connect, accepted.** Pure derivation of the pinned `serverIdentityPublicKey`; never persisted. Mobile's only new config is the relay hostname (+ optional self-hoster override).

## Wire contract (v1.1 — CHANGED from v1.0; Phase B + the mobile leg freeze THIS verbatim)

> v1.1 deltas vs v1.0: added first-frame `auth`; `http-req` is presented to Next as remote-Bearer (no allowlist, no loopback-trust); added `http-res-part` chunking + `413`; published rate limits; push token is a real APNs alert token, not ActivityKit.

- Mac connector → relay: `wss://relay.o8.run/mac` — headers `Authorization: Bearer <plan JWT>`, `x-o8-routing-id: <base58>`. Relay verifies JWT sig + `resolveFlags(plan)['relay.offNetwork']===true` else close `4409`. One socket per routingId; newest supersedes.
- Phone → relay: `wss://relay.o8.run/device/{routingId}` — **no auth at the relay**. Rate limits R4. Relay bridges to the Mac connector; the Mac's per-device auth + E2EE are the gate.
- Relay↔endpoint control frames (JSON, unencrypted, zero user content): `presence {mac}`, `devices {count}`, `push-req {apnsAlertToken, environment, kind}`, `mux-open {sid}` / `mux-close {sid}`.
- Device↔Mac data frames: opaque `{sid, seq, payload:<raw bytes, incl. {e2ee:1,n,c}>}` — relay never parses `payload`.
- In-tunnel (inside E2EE), first frame per bridged socket: `auth {token}` → validated → all subsequent traffic; else `4403`.
- In-tunnel HTTP: `http-req {rid, method, path, headers, bodyB64}` → `http-res {rid, status, headers, bodyB64}` (+ `http-res-part {rid, i, last}` for chunked; `413 tunnel_response_too_large` over the ceiling). Connector replays to local Next with non-loopback `x-o8-client-addr` + the request's Bearer; middleware gates per-route.
- Close codes: `4401` token revoked · `4403` handshake/auth rejected (both Mac-origin, → re-pair) · `4408` `mac_offline` (→ backoff) · `4409` `entitlement_lapsed` (→ stop until refresh).

## Q rulings (recorded)

1. Entitlement: all-paid in principle, **founders-only today** ($19 tier not yet offered) — flag map founder→true, free→false, future paid→true at launch. ✅
2. LAN-first pairing for v1; remote-pair = v2. ✅
3. Relay hostname `relay.o8.run`. ✅

## Mobile client redline (2026-07-08 — mobile lane, pre-build review per Track-2 protocol)

Reviewed against o8-mobile HEAD. The architecture (zero-knowledge relay, HTTP-over-frames,
last-start-wins connector) is right and buildable from the phone side. Blockers and gaps
below must be resolved in this doc before the §Wire contract freezes — R1–R3 are
contract-blocking, R4–R8 are asks/clarifications.

- **R1 (BLOCKER, D3): the `/api/mobile/*` allowlist breaks half the app off-network.**
  The phone's real HTTP surface today (every `apiBase()` call site, grepped at HEAD) spans
  **26 paths across 11 prefixes**, including NON-`/api/mobile/*`: `/api/dictation/transcribe`
  + `/polish` (composer dictation), `/api/tts` (read-aloud), `/api/repo-spec` +
  `/api/repo-spec/asset` (o8.md notes), `/api/v2/chat-history` (transcripts),
  `/api/worktrees/diff` (diff review — an approval-flow dependency, not a nicety),
  `/api/panel/projects` + `/api/panel/search`, `/api/runtime/inventory`,
  `/api/setup/orchestrator-backends`. With the tunnel allowlisted to `/api/mobile/*` only,
  off-network loses dictation, TTS, notes, transcripts, diffs, search, and the orchestrator
  mode selector — silently. Fix: allowlist the enumerated prefix set (mobile will freeze
  types against the final list and can own generating it), or a `x-o8-mobile-surface`
  route-manifest the connector fetches from the local Next app at startup.
- **R2 (BLOCKER, D2/§Wire): per-device token presentation over the relay is unspecified.**
  On LAN the token rides the WS URL (`/ws?token=…`, client.ts:17) at upgrade time. Via the
  relay the phone's upgrade goes to `relay.o8.run/device/{routingId}` — no token — and the
  connector originates the local ws-server connection itself. The contract must state HOW
  the token reaches the Mac's validator: recommend a first in-tunnel `auth {token}` frame
  the bridged socket must send before anything else, with the ws-server holding the socket
  unauthenticated (no channel traffic, no `http-req` processing) until it validates.
  Related: since the connector dials `127.0.0.1` and middleware waves loopback through,
  the in-tunnel gate IS the entire HTTP auth off-network — say that explicitly and gate
  `http-req` handling on token-validated sockets.
- **R3 (BLOCKER, D4): ActivityKit tokens cannot carry the "o8 needs you" push.** The tokens
  the Mac holds from `/api/mobile/live-activity/register` are Live-Activity
  **update** tokens — APNs will only accept `liveactivity` pushes against them (update/end
  that one activity); they cannot deliver a generic alert. For the relay's queue-and-notify,
  either (a) mobile adds real remote-notification registration
  (`registerForRemoteNotifications` → device token → registered to the Mac alongside the
  ActivityKit token — mobile can build this, needs it in the contract + Mac storage), or
  (b) v1 pivots to ActivityKit **push-to-start** tokens (iOS 17.2+, a third token type,
  starts a "waiting approval" Live Activity — closest to the product's existing surface).
  Pick one in this doc; (a) is the boring reliable choice.
- **R4 (D2, ask): relay rate limits vs the fallback prober.** Client policy will be
  direct-first with a short smoke-test, relay on failure — flaky LAN means the phone may
  legitimately hit the relay several times per minute. Publish the limit numbers (N pending,
  M attempts/min) in the wire contract so the client can back off below them, and make the
  10s handshake deadline start at socket-admit, not DNS.
- **R5 (D2/D6, client behavior to encode in contract): E2EE policy becomes
  transport-dependent.** Mobile's current default is E2EE OFF with a 1500ms raw-fallback
  grace (flag `O8_MOBILE_E2EE`). Over the relay the contract requires E2EE with no raw
  fallback — mobile will implement per-transport policy (LAN: today's behavior unchanged;
  relay: mandatory, fail-closed 4403). Consequence to state in D6: devices paired before
  `serverIdentityPublicKey` existed in the QR can neither derive `routingId` nor E2EE —
  relay UX for them is honest "re-pair at your Mac to enable remote", not an error.
- **R6 (D3, ask): size/flow limits for `http-req`/`http-res`.** `/api/worktrees/diff` and
  `/api/repo-spec/asset` responses reach MBs; base64 inflates 4/3 and single giant WS
  frames will fight the mux. Specify max in-tunnel response size + a chunked
  `http-res-part {rid, i, last}` continuation (or an explicit v1 cap with a defined
  `413`-equivalent error the client can render).
- **R7 (D5, client note): 4408/4409 must not look like revocation.** Client's 4401/4403
  path calls `markRevoked()` → forces re-pair (ws.ts:461). Contract should state client
  expectations: 4408 → offline UX + retry with backoff; 4409 → stop relay attempts until
  entitlement refresh; neither touches revocation state. Mobile will implement exactly that.
- **R8 (D8.3, minor): don't persist `relayRoutingId`.** It's a pure derivation of the
  pinned `serverIdentityPublicKey` already in secure storage — derive at connect time
  (stale-copy-on-re-pair bug avoided). The config addition mobile actually needs is just
  the relay hostname (+ optional override for self-hosters, if that's ever a thing).

Mobile-side scope confirmed as buildable once R1–R3 land: transport switch in `client.ts`
(direct `fetch` vs http-over-frames), relay leg in `ws.ts` behind the same reconnect state
machine, per-transport E2EE policy, presence/4408/4409 UX, and `relay.offNetwork`-gated
surfacing. — mobile lane
