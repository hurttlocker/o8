# o8 Relay — deploy checklist (Q-gated)

**Do NOT `railway up` without Q's go.** The relay is a SEPARATE Railway service next
to license-server (Q ruling D1). It holds no database, no license private key, no
session keys — it verifies plan-JWTs (public key) and forwards opaque bytes.

Rollback is trivial and safe: **stop the service. LAN + Tailscale direct connections
keep working unchanged** — the relay is only the off-network reach path (constraint 1).

---

## 1. Environment variables (set in the Railway service, NOT committed)

| Var | Required | What |
|---|---|---|
| `LICENSE_PUBLIC_KEY` | ✅ | Ed25519 **PUBLIC** SPKI PEM matching the license server's `LICENSE_PRIVATE_KEY`. Verifies the plan-JWT. Get it from `services/license-server` → `npm run gen-keys` prints the PUBLIC block, or derive from the existing private key. Paste the multi-line PEM directly (or `\n`-escaped). |
| `ISSUER` | — | Must equal the license server's `ISSUER` (default `o8-license`). |
| `APNS_KEY_P8` | for push | The `.p8` signing key **contents** (PKCS8 PEM). |
| `APNS_KEY_ID` | for push | 10-char Apple key id. |
| `APNS_TEAM_ID` | for push | 10-char Apple team id. |
| `APNS_BUNDLE_ID` | — | iOS bundle id (default `com.marquisehurtt.o8mobile`). |
| `APNS_ENV` | — | **Fallback default only** — the live environment is carried **per `push-req`** and `sendApprovalAlert()` selects the endpoint from it, so leave it unset in prod. Local **dev** builds → `sandbox`; **TestFlight AND App Store** → `production` (TestFlight uses PRODUCTION APNs, NOT sandbox). |
| `RELAY_MAX_TUNNEL_BYTES` | — | In-tunnel response ceiling before 413 (default 32MB). |
| `PORT` | — | Railway sets this automatically. |

> APNs is OPTIONAL — without it, `push-req` frames are logged and dropped; everything
> else works. The APNs `.p8`, key id, and team id are the SAME credential the desktop
> uses for Live Activities (`O8_APNS_*`); this is a second copy scoped to the relay.

## 2. Create the Railway service

1. Railway → the o8 project → **New → Empty Service** → name `o8-relay`. Do NOT reuse
   the license-server service (different scaling + blast radius, per D1).
2. Connect it to this repo, **root directory `services/relay`**. `railway.json`
   already pins NIXPACKS + `npm run build` + `npm start` + `/health`.
3. Add the env vars from §1.
4. Deploy (Q go): `railway up` from `services/relay/`, or push-to-deploy if the repo
   trigger is wired. NO database plugin — the relay is in-memory only.

## 3. DNS — `relay.o8.run`

1. Railway service → **Settings → Networking → Custom Domain** → add `relay.o8.run`.
2. Add the CNAME Railway shows at the DNS provider for `o8.run`.
3. Wait for the cert to issue (Railway provisions TLS). `wss://relay.o8.run` then resolves.

> Until this CNAME exists, entitled desktops quietly back off (capped 30s) trying to
> dial `wss://relay.o8.run/mac` — harmless, no LAN impact. They auto-connect once DNS is live.

## 4. Smoke test

```bash
curl -s https://relay.o8.run/health
# → {"ok":true,"service":"o8-relay","issuer":"o8-license","apns":"configured","macs":0,"devices":0}
```

`apns` reports `configured` / `disabled`; `macs`/`devices` are live socket counts.

## 5. Desktop / mobile activation

- Desktop connector defaults to `wss://relay.o8.run`; override with `O8_RELAY_URL`
  (e.g. a staging relay) or disable with `O8_RELAY_CONNECTOR=off`. It only dials when
  entitled (`relay.offNetwork` = paid tier) AND the operator toggle is on (default on).
- Mobile leg (mobile agent) derives `routingId` at connect and dials
  `wss://relay.o8.run/device/{routingId}`. See the wire contract in
  `docs/relay-v1-design.md` §"Wire contract (v1.1)".

## 6. Rollback

Stop / delete the `o8-relay` service (or clear its custom domain). Desktops fail the
dial and back off; **LAN + Tailscale keep working unchanged**. No data to migrate —
the relay is stateless.

## Pre-deploy verification (already green in-repo)

```bash
cd services/relay
npm install
npm run typecheck        # tsc --noEmit clean
npm run contract-test    # pure-logic invariants
npm run verify-e2e       # full wire-contract e2e on a random port
```
