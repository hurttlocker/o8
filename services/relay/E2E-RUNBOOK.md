# Relay cross-network e2e — runbook (local, no deploy)

The joint proof that turns "built" into "ship with confidence": a REAL phone client ↔
a REAL relay ↔ the REAL Mac connector ↔ the running desktop. Runs entirely locally — no
`railway up`, no DNS. Do this BEFORE deploying or shipping anything.

## Roles

- **Desktop (this Mac):** runs `scripts/relay-e2e-desktop-participant.ts` — the production
  `RelayConnector`, bridging to the already-running o8.app (ports auto-resolved from `~/.o8`).
- **Mobile lane:** runs the relay service locally + drives the phone client.

## Prereqs

1. o8.app running on this Mac (it is the backend — the connector bridges http-req/ws to
   its `127.0.0.1` api/ws ports).
2. A phone **paired against this Mac's current E2EE identity** (`~/.o8/e2ee-identity.key`).
   If the participant script printed "Generated server E2EE identity" it just created that
   file — **re-pair the phone at the Mac** so it pins this key (routingId + E2EE both derive
   from it). LAN-first pairing, unchanged.
3. `O8_MOBILE_E2EE` enabled for the run — the relay leg is **mandatory E2EE, fail-closed**;
   the LAN leg keeps its default behavior.

## Sequence

**1. Desktop — start the Mac half:**
```bash
NODE_OPTIONS='--conditions=react-server' \
O8_RELAY_URL=ws://127.0.0.1:8787 \
npx tsx scripts/relay-e2e-desktop-participant.ts
```
It prints: the **routingId** (`ws://…/device/<routingId>` the phone dials) and a throwaway
founder **PUBLIC key PEM**. Hand both to the mobile lane. It then dials the relay and backs
off (ECONNREFUSED) until step 2 — that's correct.

**2. Mobile — start the local relay** (root `services/relay`, on :8787) with the desktop's
printed key:
```bash
LICENSE_PUBLIC_KEY="<the PEM the participant printed>" \
ISSUER=o8-license PORT=8787 \
npm start                       # (build first if needed)
# optional push: set APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID
```
Within a backoff cycle the participant logs the socket coming up (`/mac up routingId=…`).

**3. Mobile — point the phone at the local relay** (transport override to `ws://<iMac-LAN-ip>:8787`)
and connect; the phone dials `/device/<routingId>`, sends first-frame `auth {token}`, then the
mandatory E2EE handshake.

## Test matrix (drive together)

| Case | Expect |
|---|---|
| Direct blocked → relay fallback | phone loses LAN path, connects via relay, app usable |
| Real approval round-trip (http-over-frames) | `POST /api/mobile/action` served by the running app; approve lands |
| Live WS channels | chat/agent-lifecycle/symon stream over the relay in real time |
| Mid-session revocation | Mac closes 4401/4403 → passes through relay → phone re-pairs |
| Relay down (Ctrl-C the relay) | phone sees `presence down` then **4408** → offline UX + backoff, LAN unaffected |
| Rate limit | >30 device-connects/min per routingId → 429 |
| **FormData (dictation / attachment upload)** | **KNOWN GAP — fails over relay (not tunnel-encodable yet); direct/LAN unchanged. First post-v1 item, not a blocker.** |

## Caveats to interpret results honestly

- **Marker path:** the running 0.1.566 app's server wrapper predates the `x-o8-relay-forward`
  non-loopback marker, so http-req replays hit it as loopback-trusted (the per-route Bearer
  downgrade is NOT exercised against the running app). The marker's spoof-safety +
  downgrade is separately proven green by the relay's own `verify-relay-e2e` and unit tests.
  To exercise the FULL marker path live, run a dev/next desktop (`npm run dev`, ports off the
  running app) with the new `scripts/tauri-export.mjs` wrapper — optional; connectivity +
  auth-gate-via-connector are provable without it.
- **Two key systems:** the throwaway plan-JWT keypair (relay entitlement gate) is separate
  from `~/.o8/e2ee-identity.key` (phone↔Mac E2EE + routingId). Only the plan-JWT public key
  goes to the relay; the E2EE key never leaves the Mac.

## Green =
All rows pass (FormData expected-fail noted). Then: deploy relay to Railway (Q gate),
ship desktop, ship relay TestFlight — with the loop proven, not assumed.
