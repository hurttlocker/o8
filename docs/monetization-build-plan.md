# o8 Monetization — Build Plan (open-core)

**Status:** canonical build plan · 2026-06-07 · **internal** (exclude from the OSS mirror — see M7). Pairs with `docs/monetization-tiers.md` (the Free/Pro matrix).

## Architecture (the load-bearing insight)
o8 ships as a signed `.dmg` — a runtime `if(plan==='pro')` protects nothing (untar the `.app`, read the JS). So **the moats must be PHYSICALLY ABSENT from the public OSS artifact**, not flag-hidden. Open-core resolves to: **one private monorepo (source of truth) + a scripted, allowlist-driven public mirror** (`hurttlocker/o8`) that copies only free-core paths. Pro dirs are never listed → never mirrored.

**Entitlement = dual-layer:** Layer 1 (truth) — a verifier in the OSS core checks a signed license JWT against a public key baked into source (same trust model as the Tauri updater; private key on Railway). Layer 2 (UX) — a client `EntitlementProvider` + `<Gate flag fallback={<UpgradePrompt/>}>`. In the OSS build the Pro modules are absent → dynamic import throws → falls back to free. **Server-gate the genuinely-valuable surfaces** (team, license validation, future cloud) — a cracked client can't fake those.

**Verified, de-risking the build:** Clerk middleware already wired (`src/middleware.ts`); `users.plan` enum + `subscriptions` table already in `schema.ts` (`plan` read in exactly one place, a token-budget check — no enforcement to rip out); the FREE single-pass review gate is cleanly separable (the Pro second-pass is only reached via `requiresSecondPass`/`tier==='high'`). `src/lib/entitlement/` + `src/lib/pro/` are greenfield.

## Milestones (~9, ~6-9 weeks before public GTM)
| # | Milestone | Est | Deps |
|---|---|---|---|
| **M1** | Entitlement reader + flag derivation (`src/lib/entitlement/` store/flags/types + `GET /api/panel/entitlement`) — gating-independent, ZERO behavior change | small | none |
| M2 | Client `EntitlementProvider` + `<Gate>`/`<UpgradePrompt>` | small | M1 |
| M3 | Settings Plan/Billing tab + finish Clerk profile wiring | medium | M2 |
| M4 | License verifier (offline-first, 30-day grace, signed JWT) | medium | M1 |
| M5 | Railway entitlement server + Stripe checkout (the payment stack) | large | M3, M4 |
| M6 | Gate the Pro features (dual-layer: server 402 + client `<Gate>`); fresh-free-DB smoke proving single-pass still blocks | large | M4, M5 |
| M7 | OSS-core carve: `oss-manifest.json` allowlist + `build-oss-mirror.mjs` + cleaning + standalone OSS CI | large | M6 |
| M8 | README-as-storefront + o8.run landing tie | medium | M7 |
| M9 | Launch (Show HN on the gate moment, Reddit wedge, 90-day activation loop) | medium | M5, M8 |

Each ships independently on the existing `npm version patch && npm run ship` loop. **Build native (Claude workflows + me); conserve Codex.** Governance on the diff: PR → CI → validate → merge.

## Open decisions (operator — needed by M5/M8, NOT blocking M1-M4)
1. **Pricing** — floated $29/mo solo Pro · $49/seat team (unvalidated). Provisional number needed before M8; lock by ~day 75 from paid betas.
2. **Trial shape** — rec: **none, Free IS the trial** (moats are depth, not time). Confirm before M5.
3. **OSS license** — rec: **BUSL-1.1** (source-available, blocks competitor resale) vs MIT (max stars). Blocks M8.
4. **Clerk vs license-key auth** — rec: **Clerk login for Pro purchase** (maps stripeCustomerId→userId), license-key works offline thereafter. Affects M3/M5.
5. **Telemetry** — rec: **opt-in aggregate, OFF by default, no PII** (install + first-dispatch activation). Approve payload + copy before M9.
6. **Windows/Linux** — rec: **macOS-first + transparent "v2"** (caps launch reach ~40%).

## Top risks (mitigations baked into the milestones)
- Desktop binaries inspectable → **accept**; physical absence + server-gate, not client DRM.
- M7 seam refactor invasive → standalone OSS CI is the forcing function; gate per-domain.
- License-server outage must not brick Pro → **offline grace from day one (M4)**.
- Activation regression → M6 fresh-free-DB smoke proving single-pass still blocks a bad merge.
- Activation depends on real bugs → seed betas with messy refactors; headline the gate moment.
- Brain ingestion / codename leak on mirror → ship OSS-safe spec files; allowlist + blocklist grep gate.
