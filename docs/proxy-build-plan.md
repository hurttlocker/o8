# o8 Managed-Inference Proxy — build plan

**Status:** ready to build (2026-06-16). The next major run after the free launch (Launch A).
**Parent:** `docs/monetization-and-free-tier-plan.md` (the why). This doc is the how.

## Goal

A hosted, metered inference endpoint the desktop authenticates to, so **users don't bring their own keys** — "what we give them." It powers, with **our** funded keys:

- the Brain's paid hops (the OpenRouter/Flash **speed tier** + embeddings),
- dictation (Whisper transcribe + Gemini polish),
- the default chat path (whatever replaces the deprecated assistant chat, if any),
- **Symon's brain** (re-adding the proxy that was de-Symonized — routed to the *same* gateway).

Free users get a small metered allowance (no sub required → newcomers can finally use o8). Paid users get a higher fair-use cap. This is what makes the Brain **fast** and lets **no-sub** users in — the two things Launch A leaves on the table.

## Non-goals (v1)

- **Premium ElevenLabs voice** — founder-only for now; not through the proxy at v1 (it's the runaway per-character cost; add later as a capped add-on).
- **Cloud agents** — separate, later.
- **Usage-metered billing** — flat plan + per-account cap first; meter the *usage data* to set the price, don't bill on it yet.

## Architecture

```
Desktop (o8.app)
  └─ provider key resolvers  (byok-keys.ts resolveOpenRouterKey, Gemini lookups)
        today:  process.env  →  BYOK vault  →  (skip / 503)
        new:    process.env  →  BYOK vault  →  ⟦plan token? → o8 proxy⟧
                                                        │
                                                        ▼
  o8 Inference Proxy   (Railway — extend the existing license-server, or a sibling service)
        ├─ auth:  the EdDSA plan token the desktop already holds (shared pubkey w/ license server)
        ├─ meter: per-account daily cap (free ~$0.10/day · paid ~$0.30/day · embeddings+dictation capped)
        ├─ route: OpenRouter (most models) + Gemini direct (embeddings/Flash) using OUR funded keys
        └─ log:   usage → Postgres  →  THE COGS DATA WE NEED TO SET PRICE
```

### Design decisions (locked by the plan doc)
1. **Proxy = a key-resolution fallback, not a rewrite.** Insert at the existing resolvers. When there's no local key AND the plan grants proxy access, the resolver returns a *proxy-routed* client (base URL = proxy, bearer = plan token) instead of skipping/erroring. Every existing paid hop inherits it with near-zero call-site change. (Plan §9: "route the BYO resolvers to the o8 gateway when plan==paid.")
2. **Reuse the entitlement for auth.** The Railway license server already mints an EdDSA token; the proxy validates the same token (shared pubkey). No new auth system.
3. **Per-account metering on the server** replaces the global $0.50/day desktop cap. Tiered by plan; embeddings + dictation get caps too (uncapped today).
4. **Our keys live only on the proxy** — never in the desktop build (preserves the "no bundled keys" guarantee).
5. **OpenRouter-first upstream** (one integration for most models) + Gemini direct for embeddings/Flash.

## Build order (each step shippable)

**Step 0 — finish the license loop (hard prereq).** Run `gen-keys`; put the **private** key on Railway, swap the **real public key** into desktop `src/lib/entitlement/license.ts` (still the placeholder), ship a build. Until this, no plan token verifies. (Plan §6; memory `m5_deploy_state`.)

**Step 1 — proxy service (Railway).** Extend the private `o8-license-server` (or a sibling): `POST /v1/inference` (OpenRouter-compatible passthrough) + `POST /v1/embeddings`. Validate the plan token → check the per-account meter → forward to OpenRouter/Gemini with our key → log usage to Postgres → `402` when over cap. Our keys as Railway env only.

**Step 2 — desktop resolver integration.** In `src/lib/cortex/qa/llm/byok-keys.ts` (`resolveOpenRouterKey`) + the Gemini key lookups, add the proxy tier: no local key AND plan token present → return a proxy client. Gate on the entitlement (`proxy.inference` flag). This auto-lights the **Brain speed tier, dictation, embeddings, and the default chat path** — no per-feature work.

**Step 3 — Symon brain → proxy.** Route key resolution in `src-tauri/src/agent/{gemini,openrouter,router}.rs` (+ `stt/keys.rs`) to the proxy when `plan==paid`. Re-adds the stripped Symon proxy, unified with o8's gateway. (Plan §5.1/§5.2.)

**Step 4 — free taste-allowance.** A small free-tier metered allowance (no sub) so newcomers + the default chat work out of the box. Server-side rate limit per install/account. **This is the "everyone" launch unlock** (turns Launch A into the full launch).

**Step 5 — per-account caps + telemetry.** Move the Brain cap server-side, per account, tiered. Surface usage so we can **do the pricing math from real COGS** (the data the operator wants before finalizing $19).

**Step 6 — pricing + checkout.** With Step-5 data: confirm/adjust $19, wire Stripe checkout (license server already mints), flip the Billing tab's "Coming Soon" rows → live, and (per plan §7 cleanup) fix the FTUX setup-detect + dictation 503 copy that still point at the hidden BYOK tab.

## Already built — reuse, don't rebuild
- **License server** on Railway (Stripe → EdDSA mint, beta-invite module) — extend the private `o8-license-server`.
- **Entitlement** flags + store + verifier (desktop) — repurpose a flag → `proxy.inference`. (`src/lib/entitlement/`)
- **`/api/v2/proxy/llm`** already enforces a per-user budget for non-free plans (the metering *seam*) — but only fires on authenticated non-loopback requests. The hosted proxy is that authenticated path.
- **`byok-keys.ts`** resolver chain — the single insertion point for Step 2.
- **Symon's direct-key path** (`agent/`, `stt/`, `tts/`) — the call sites for Step 3.

## Open for the proxy run
- Separate Railway service vs extend `license-server`? (Lean: extend — shared token + Postgres.)
- Free allowance size (the no-sub daily cap).
- Final pricing — **do the math after Step 5** (operator's call, real COGS data).

---
*Inputs verified 2026-06-16: classifier 5-tier fallback (`cortex/qa/classifier.ts`), key resolvers (`cortex/qa/llm/byok-keys.ts`), Symon TTS gate (`src-tauri/src/tts/mod.rs`), entitlement stack (`src/lib/entitlement/`), and the private `o8-license-server`.*
