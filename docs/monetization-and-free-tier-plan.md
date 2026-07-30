# o8 Monetization & Free-Tier Plan (launch canonical)

**Status:** canonical as of 2026-06-16. Written for the public free launch.
**Supersedes the *framing*** (not the code) of `monetization-tiers.md`, `monetization-build-plan.md`, `monetization-issues.md` — those describe the M1–M6 "gate the moats behind Pro" plan. The directive changed: **o8 ships free; we monetize cost, not capability.** Those docs remain accurate as the history of what was *built*; this doc is what we *do*.

**Refined 2026-06-16 (PM):** this release ships **100% free with no Stripe in the loop** — no checkout, no paywall. The entitlement token is a **free account credential** (proxy-auth + usage attribution), *not* a receipt. We **gather usage data first, price later**. New near-term deliverable: a **usage-analytics dashboard** on the o8 front-end (§11). The paid levers in §5 stay designed-but-dormant until the data tells us what to charge for.

Grounded in a full codebase map (6-domain workflow, 2026-06-16). Every claim here traces to a file; key files are listed per section.

---

## 1. The model in one line

> **You pay o8 only when o8 spends money on your behalf.**

- **Free** = anything that runs on *your* machine, *your* CLI subscription, or a *local* model. The whole governance moat, organizational memory, canvas, orchestration, multi-repo fleet, single- *and* second-pass review, mobile on your own network, and basic local Symon.
- **Paid** = only the three places where **we** carry a marginal cost for you:
  1. **Managed-inference proxy** — you don't want to bring your own key. (o8 Brain + Symon brain + premium voice/STT.)
  2. **Off-network relay** — reach your Mac from anywhere, not just your LAN. (Mobile away-from-home.)
  3. **Cloud compute** — agents that run while your laptop is closed. *(Future — not a launch lever.)*

This line is also the COGS guarantee: because the paid boundary is *defined* as "where we'd spend," the free tier's cost to us is provably ~$0. It's a clean open-core story and it matches how the code already behaves.

---

## 2. Where we actually stand (the surprising part)

**"Everything free" is already the de-facto state in code.** The Pro/entitlement system was fully *built* but the milestone that would have actually paywalled anything (**M6**) **never shipped**:

- `Gate` and `UpgradePrompt` have **zero importers** anywhere in `src/`. No feature branches on any entitlement flag.
- `EntitlementProvider` is mounted (`dashboard/page.tsx`) and fetches `/api/panel/entitlement` on boot, but the only consumer of the result is the Billing settings tab's marketing matrix.
- The desktop license verifier still ships a **placeholder public key**, so even a real Stripe-minted license can't be validated by the installed app yet.

**Implication: the free launch is low-risk.** There are no gates to remove — you ship what you have. The work is (a) one cosmetic fix, (b) one COGS confirmation, (c) building the *first paid lever* when you're ready. Nothing blocks downloads today.

*Key files:* `src/lib/entitlement/{flags,store,license,context,Gate,UpgradePrompt}.ts(x)`, `src/app/api/panel/entitlement/route.ts`, `src/components/desktop/settings/BillingTab.tsx`, and the private `o8-license-server`.

---

## 3. The free tier — what the world gets

Everything below ships **free and ungated today**, at **~$0 cost to us**, because the work runs on the user's own subscription or locally.

| Surface | Runs on | Our cost |
|---|---|---|
| Canvas (cards, drag/resize, zoom, glass, tour, reel) | Client + localStorage | $0 |
| Orchestrator chat (canvas + default view) | User's Codex/ChatGPT sub (default) or Claude REPL sub | $0 (BYO) |
| Dispatched worker coding (Codex/Gemini/opencode in worktrees) | User's CLI sub | $0 (BYO) |
| Merge gate — single-pass governance | Pure heuristic, no LLM | $0 |
| AI review + blind second-pass (AGREE-gate) | User's orchestrator sub | $0 (BYO) |
| Engineering Brain Q&A (cited repo answers) | User's Claude/Codex sub first; our OpenRouter only as a capped fallback | ≤ cap (§4) |
| Cortex directives + session ledger (org memory) | Local SQLite + FTS5 | $0 |
| Multi-repo fleet orchestration (no repo cap) | User's CLI subs | $0 (BYO) |
| AgentPanel / O8Panel (fleet, diff, activity, inbox, PRs, spec) | Local git + SQLite + GitHub API | $0 |
| Embedded browser agent (read/click/type/probe) | Pure DOM; "thinking" is the orchestrator (BYO) | $0 |
| Mobile operator control **on LAN / Tailscale** | User's Mac backend (BYO inference) | $0 |
| Basic Symon — dictation + voice | Apple Speech (STT) + macOS `say` / edge-tts (TTS), all local | $0 |
| Push notifications, QR pairing, beta-invite share | VAPID-direct / local SQLite | $0 |

**The crafty spot, confirmed:** the *work itself* — every orchestrator turn and every dispatched coding agent — runs on the **user's own CLI subscription** by construction. The repo never puts an API key in the dispatch path; `claude-code` dispatch is even **hard-disabled** specifically so it can't bill the Agent SDK pool (`src/lib/runtimes/claude-code.ts`). That's why o8 doesn't *need* to charge: the expensive part is already paid for by the user's Claude/Codex sub.

---

## 4. The COGS map — every place a free user could cost *us* money

These are the **only** inference paths that can spend real money. All of them resolve keys **`process.env` first, then the user's stored (BYOK) key**.

| Path | Key source | Cap today | Risk |
|---|---|---|---|
| Brain Q&A — OpenRouter tier | env → BYOK | **$0.50/day per install** (`O8_QA_OPENROUTER_DAILY_CAP_USD`) + 2-strike breaker | Bounded |
| Brain — semantic-cache embeddings (Gemini) | env → BYOK | **none** | Small but uncapped |
| Dictation — Whisper transcription | env → BYOK | **none** | Uncapped; 503s with no key |
| Dictation — Gemini polish | env → BYOK | **none** | Uncapped; no-ops with no key |
| "Operator" branded chat | Gemini Flash → free OpenRouter model | n/a (free model floor) | Low |
| Symon brain / premium STT / **ElevenLabs voice** (Tauri) | env → `~/.o8/dictation.json` | **none anywhere** | ElevenLabs bills **per character** — scariest curve |

### The one decision that gates a safe free launch: **bundled keys**

Every path above checks `process.env` *first*. So the question is: **does the public release build ship with our inference keys in its environment?**

- **Today's default is safe-by-absence.** The founder's keys are *forwarded from the login shell at runtime* (`load_ai_keys_from_login_shell`, `src-tauri/src/lib.rs`) — they exist on the founder's Mac, **not** on a public user's machine. So a vanilla public build naturally resolves *no* central key: free-tier COGS = **$0**, and the user either BYOs a key or uses the local/free fallbacks.
- **Confirmed clean (2026-06-16):** `.gitignore` excludes all `.env*` (only `.env.example` is tracked); **no hardcoded key literals** exist in `src/` or `src-tauri/`; the release scripts (`release.mjs`, `sign-and-notarize.mjs`) inject **only Apple signing creds**, never AI keys. The only baked-in key is the Clerk *publishable* key (`NEXT_PUBLIC_*`), which is public by design. So the public build ships with **no funded key** — see the registry in §10.
- **The trap to avoid:** baking a real key into the distributed app/env. A key in a shipped binary is extractable and would let every free user (and every attacker) spend against us — and dictation/embeddings/Symon have **no cap at all**.

**Recommendation:** **Launch with no central inference keys.** Free = BYO-key or local fallbacks; the *managed key is the paid product* (§5.1). This is also what the code already wants — `keys/route.ts` literally comments that BYOK should be "killed before official release in favour of the hosted subscription tier."

**The UX cost of that** (and the follow-up): with no key, first-run dictation 503s and Symon's brain is dead for a user who hasn't brought a key. If we want first-run to "just work," the answer is **not** a bundled key — it's a **hosted metered proxy with a small free allowance** (a server endpoint the free app calls, rate-limited per user), shipped as part of the proxy product, not before it. Launch on strictly-BYO/local; add the taste-allowance with the proxy.

---

## 5. What we monetize — the paid levers, ranked by readiness

### 5.1 Managed-inference proxy — the spine (o8 + Symon, unified)

One product wearing two faces: **"we host the inference key, metered, behind your subscription."**

**BYOK is being removed (2026-06-16 directive).** It serves nobody: developers already have their work covered by their CLI subs (Claude / Codex / opencode), and new-to-AI users don't know what an API key is. The proxy *is* "what we give them" — it replaces BYOK entirely. Keep the code (`keys/route.ts` + `APIKeysTab`) but hide the tab; bring it back only if a user explicitly asks.

**Consequence — the proxy is closer to a launch prerequisite than a follow-on.** With no BYOK *and* no bundled key, the only thing that can power the Brain's paid tier, the "operator" assistant chat, Symon's brain, and **any user who has no CLI sub at all** is the proxy. The orchestrator + workers still need a Claude/Codex sub (there is no operator-provided coding backend today), so until the proxy's free allowance ships, day-one o8 effectively serves **developers who already have a sub.** A true newcomer can't run the core loop until the proxy gives them one. That makes the proxy's free metered allowance the gate between a *dev-first* launch and an *everyone* launch (see §9).

**The proxy is also what makes the Brain *fast*.** Verified in the cascade: classify never hard-fails (it falls through OpenRouter → Flash → Codex CLI → a lexical heuristic), and compose runs on the user's own Claude/Codex sub — so **the Brain works end-to-end with zero keys, for any user who has a sub.** But without the OpenRouter/Flash speed tier it pays a **15–30s CLI process bootstrap per query** — correct, but sluggish. So at launch A the Brain is functional-but-slow for sub users; the proxy's hosted speed tier is what makes "the chat" feel instant (and what makes it work at all for no-sub users). Since the assistant chat is being retired in favor of the Brain, this is the surface that matters.

**One plan, both products (2026-06-16).** The primary paid plan covers o8 **and** Symon under one subscription (managed inference for both). An optional cheaper **Symon-only** SKU can exist for people who just want the voice assistant, but the clean default is one unified plan.

- **For o8:** backs the Brain's OpenRouter tier, dictation transcription/polish, embeddings, and the "operator" default chat with a hosted key instead of forcing BYO.
- **For Symon:** backs the brain (Gemini), premium STT (Whisper), and premium voice (ElevenLabs).

**State:** the *enforcement seam already exists* — `/api/v2/proxy/llm` enforces a per-user `tokenBudgetUsd` and returns `402` for non-free plans. But on loopback desktop, auth is null, so nothing is metered today. Making the proxy real means the desktop must **authenticate to the proxy** (a hosted endpoint, or the local route starts requiring a plan token).

**Symon caveat — this is a *reversal*:** Symon was deliberately **"de-Symonized"** — the proxy/license route from the acquired app was **deleted**; it's direct-API/BYO-key now. Monetizing Symon = **re-adding a proxy at the `run_loop`/transcribe/synthesize call sites** — but it should route to the **same o8 gateway**, not a separate one. Unify, don't fork.

**Pricing:** the built `$19 solo / $29 team` was scoped to gate *zero-marginal-cost flags*. The proxy has **real COGS**, so it needs either a fair-use cap or metering. The license server only does **flat subscription** today (no usage metering). **Recommendation:** launch the proxy as a **flat plan with a fair-use cap** tuned to COGS; treat **premium ElevenLabs voice** as a higher tier or give it its own character budget (it's the one cost that can run away).

*Key files:* `src/app/api/v2/proxy/llm/route.ts`, `src/lib/cortex/qa/llm/{openrouter-adapter,brain-spend,byok-keys}.ts`, `src-tauri/src/{agent,stt,tts}/`, and the private `o8-license-server`.

### 5.2 Symon paid (brain + premium voice/STT)

The clearest *consumer* lever — nobody pastes an API key into a voice assistant; the convenience **is** the product. The free/paid line is already there as graceful degradation:

- **Free Symon:** Apple Speech STT + macOS `say`/edge-tts + the local voice-command grammar ("cancel", "new line", "say…"). Works with **zero keys** — already shippable.
- **Paid Symon:** the proxied brain (turns it from a dictation tool into an *agent*), premium Whisper STT, audio-grounded Gemini polish, and ElevenLabs voice.

**At launch, ElevenLabs is founder-only.** It's already key-gated in `tts/mod.rs` (selected only when `tts_provider == elevenlabs` AND a key resolves), so "off for users" = simply don't ship the key. The user-facing default is the **free** voice — Google Neural2 falling back to macOS `say` when no key is present, so a fresh public machine speaks out of the box at zero cost. Premium ElevenLabs voice is a **later add-on**, not a launch lever — which removes the single biggest per-user COGS risk from day one.

**Honor the existing promise:** the voice AccountTab currently says *"Voice, dictation, and history are free forever."* Keep that — monetize the **inference on top**, never the dictation feature itself.

### 5.3 Mobile — free on your network, paid off it

Mobile is **real and shippable**: an in-repo PWA *and* a separate native Expo app (`hurttlocker/o8-mobile`, ~18 screens, QR-pairs to a physical iPhone). It remote-controls the user's **own Mac backend**, so the agent inference runs on the desktop's BYO creds — **mobile carries ~$0 inference cost.**

Because it costs us nothing on-LAN, a blanket mobile paywall would be a pure feature-gate, not cost-recovery. **Recommendation, consistent with §1:**
- **Free:** mobile on the same LAN / Tailscale (pairing is already direct, zero hosted cost).
- **Paid:** the **off-network relay** — reach a sleeping / NAT'd Mac from anywhere. That relay is a genuine recurring infra cost and an honest thing to charge for.

**Two wiring facts to decide before charging:** (a) `mobile.control` flag exists but is **enforced nowhere** — gating mobile means a **server-side** check on `/api/mobile/*`, never a client check; (b) the native app is a **separate repo** that doesn't consume this monorepo's entitlement — its gate lives in `o8-mobile` + the server, or via App Store IAP. Also: the free PWA would be a bypass of a paid native app — retire it or gate both.

### 5.4 Cloud — future, not a launch lever

**Not ready to charge for.** The `cloud` runtime is registered but `launch()` only enqueues to an **in-memory map**; `resume`/`readTranscript`/`getChangedFiles` throw `notImplemented`; there's **no worker CLI**. The headline "24/7, laptop-closed" cloud agents (Vercel Workflows + Sandbox) are **vision-only** (`docs/cloud-agents-open-agents.md`, status: research).

When it's built it splits into two products with different cost models: **(a) self-hosted worker pool** = BYO customer compute (enterprise license, no infra cost to us) vs **(b) managed cloud agents** = we carry metered sandbox + workflow cost (must be usage-priced). Don't promise either at launch. Confirm the half-built `cloud` runtime is **hidden from the picker**, not just present in the registry.

### 5.5 What a paid user actually costs us (Brain + Symon)

The plan's margin hinges on two variable costs. Order-of-magnitude (the **driver** in bold):

**Brain Q&A — cost depends on whether `compose` rides the user's own sub or our proxy.** (The cascade *already* prefers the user's Claude sub via the warm REPL pool; OpenRouter is a fallback.)
- classify (grok/flash-lite) + retrieval embeddings ≈ **$0.0003/query** — negligible, always ours.
- compose on the **user's Claude/Codex sub = $0 to us**; compose on **our proxy** at a Sonnet-class model ≈ **$0.005–0.02/answer**.
- So a **sub-backed** user costs ~**$0.20/mo** (pennies). A **no-sub** user on full proxy costs ~**$6/mo** at 20 q/day; a heavy no-sub user can exceed a whole $19 plan — which is exactly why the cap matters.

**Symon — dominated by ElevenLabs (per-character TTS).**
- brain (Gemini Flash, ~10 turns) ≈ $0.003–0.01/interaction — cheap.
- premium STT (Whisper, ~$0.006/min) ≈ **$5/mo** for a heavy (30 min/day) user — manageable.
- **ElevenLabs voice ≈ $0.04–0.10 per spoken reply** → a heavy voice user blows past **$30–60/mo**. Unlimited premium voice is **untenable** under a $19 plan.

**Guardrails this implies (the Brain-cost decision):**
1. **Always lead the Brain cascade with the user's own sub** (compose free to us) — already the design; keep it.
2. **Move the cap from global-per-install to PER-ACCOUNT on the proxy server.** The desktop $0.50/day cap is meaningless for proxy economics.
3. **Tier models by plan:** free = cheapest (flash-lite/haiku-class) under a low cap (**~$0.10/day ≈ $3/mo ceiling**); paid = Sonnet-class under a fair-use cap (**~$0.30/day ≈ $9/mo ceiling**).
4. **Default Symon voice to a cheap engine** (Google TTS / edge-tts); reserve **ElevenLabs for a capped character budget** or a higher "Voice" add-on. **Single most important cost guardrail in the product.**
5. **Cap embeddings + dictation** (uncapped today).

**Net:** a $19 unified plan with these guardrails runs ~**$3–6/mo average COGS** — profitable. Without the ElevenLabs cap, one heavy voice user is a loss. The cap, not the price, is what keeps the plan solvent.

---

## 6. Reconciliation — M1–M6 → the new model

| Built in M1–M6 | Was for | Becomes |
|---|---|---|
| `flags.ts` 5-flag matrix (governance/brain/fleet/mobile/team) | Gate moats behind Pro | **Repurpose.** Nothing consumes it; redefine keys toward `proxy.inference`, `symon.brain`, `relay.offNetwork`, `cloud.runners`. The moats stay **free**. |
| License server (Stripe → signed EdDSA) | Mint Pro/Team tokens | **Reuse as-is.** Repoint price-ids at proxy/relay SKUs. Already ships a beta-invite/founding-pass module. |
| Desktop license verifier | Validate tokens offline | **Finish when the first paid lever ships:** run `gen-keys`, swap the real pubkey into `license.ts`, ship a build. Non-functional until then (placeholder key) — fine, nothing's paid yet. |
| Billing settings tab | Show plan + flag matrix | **Cosmetic fix required before launch** (see §7). |
| `$19 solo / $29 team`, no trial | Flat feature-gate plan | Carry the numbers to the **proxy** plan, or reset for a managed-inference SKU with real COGS. |

**The single biggest reconciliation fact:** "freeing most of M6" is essentially a **no-op**, because none of M6's gates were ever wired. Governance, the Brain, fleet, and mobile are *already free in the running app.*

---

## 7. Must-do before public downloads (free launch checklist)

1. **Confirm the release build ships with NO central inference keys** (§4). This is the one thing standing between "free tier costs ~$0" and "free tier bills us." Verify the signed build's env carries no `OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `ELEVENLABS_API_KEY`.
2. **Fix the Billing tab copy.** It currently renders *"Free — all moats Locked"* with taglines advertising governance/Brain/fleet/mobile as Pro — directly contradicting the everything-free posture. Reword to the new levers (managed inference / off-network mobile / cloud), or hide the matrix. (Symon's "free forever" copy is aligned — keep it.)
3. **Confirm the half-built `cloud` runtime is hidden** from the runtime picker so users don't hit `notImplemented`.
4. **Decide free dictation's first-run story** (§4 / §8): strictly local+BYO at launch (zero work, rough first-run with no key), or hold launch for a metered taste-allowance. Recommended: ship strictly-BYO/local, add the allowance with the proxy.

Nothing else gates the free download. The paid levers (§5) are follow-on builds, not launch blockers.

---

## 8. The local-only roadmap (free-tier hardening, post-launch)

The path to a *true* offline free tier and less proxy dependence:

- **STT:** already local (Apple Speech). ✅
- **TTS:** already local (macOS `say` / edge-tts). ✅
- **Brain reasoning:** needs a local-model provider. The STT/TTS/brain layers already have a provider abstraction (model id with a `/` routes to OpenRouter; `agent_models.json` is a one-flip config) — a **local provider slots into the same seam.**

**Constraint (operator-stated):** no high-end AI Mac on hand to test local-model capability. So: **design the interfaces now** (the abstraction exists), **slot local providers in when hardware's available.** This is *hardening*, not a launch blocker — the free tier already works today via BYO + local STT/TTS. Local models make free *better* for capable hardware and unlock an offline tier; sequence after launch.

---

## 9. Open decisions (the forks only you can call)

Deduped from all six domain maps. My recommendation in **bold**.

### Locked (operator-confirmed 2026-06-16)
- ✅ **No bundled keys** — free = local/sub, proxy = the hosted key. Confirmed none bundled. (§4, §10)
- ✅ **First-run** — strictly local/sub at launch; metered taste-allowance ships *with* the proxy (server endpoint, never a baked key). (§4)
- ✅ **Mobile** — free on LAN/Tailscale, paid off-network relay. (§5.3)
- ✅ **Kill BYOK from the default UI** — devs use their CLI subs, newcomers can't BYOK; nobody's served. Keep the code, hide the tab; restore only if asked. (§4, §5.1, §10)
- ✅ **One unified plan = o8 + Symon** (managed inference for both); optional cheaper Symon-only SKU.
- ✅ **Brain stays free at launch**, led by the user's sub, capped low — not gated. (§5.5)
- ✅ **Launch sequence: A (dev-first) now.** Ship to users who already have a Claude/Codex sub; the proxy is the **immediate next build** — it's how newcomers get in AND how we gather real subscription-cost data before pricing. (§5.1)
- ✅ **BYOK hidden now** — env-gated (`NEXT_PUBLIC_O8_SHOW_BYOK`), restorable for askers without a logic change. The assistant-chat casualty is moot (it's deprecated). (§5.1)
- ✅ **ElevenLabs is founder-only at launch** (premium voice later). Default Symon voice is free — Google Neural2 → macOS `say` fallback. Voice-COGS landmine defused: no per-user voice cost at launch. (§5.2)
- ✅ **Assistant chat (`llm-chat`) deprecated** — the Engineering Brain (ScratchChat / Cortex on canvas) is "the chat." It leads with the user's own sub, so it's free to us. (§5.5)
- ✅ **This release is free — no Stripe in the loop.** No checkout/paywall ships now. The account token is a *free* credential (proxy-auth + usage attribution), not a payment receipt; the paid levers stay dormant. Price later, once data says what to charge for. (§11)
- ✅ **Data-first.** Gather who-uses-what-how before pricing. Deliverable: a usage-analytics dashboard on the o8 front-end, fed by a license-server aggregate read API + coarse desktop telemetry (counts + account id only, never code/prompts). (§11.2)

### Open — your call
- **Proxy pricing.** **Rec: $19 unified (o8 + Symon) with a per-account fair-use cap; a cheap default voice ships free, premium voice is a later add-on.** (§5.5)
- **Brain cap values** — confirm free ~$0.10/day, paid ~$0.30/day, moved per-account on the server. (§5.5)
- **Trim the entitlement flags** to proxy/relay/cloud/Symon keys. (§6)
- **Symon proxy re-add** — route the existing BYO resolvers to the o8 gateway when `plan==paid` (one proxy, two faces). (§5.1)

---

## 10. Provider accounts & keys — funding & replacement registry

**No secret values live in this repo, in memory, or in the vault — only the names + locations below.** Keep the actual values in a password manager (1Password / Keychain); the app reads them from your login shell or the encrypted on-disk stores listed here. Verified 2026-06-16: present keys confirmed by name only, never echoed.

### Accounts that carry recurring cost — keep funded
| Account | Env var(s) | Powers | Stored | Fund / replace |
|---|---|---|---|---|
| **OpenRouter** | `OPENROUTER_API_KEY` | Brain OpenRouter tier, dictation Whisper + polish, Symon OpenRouter brain | login shell (`~/.zshenv`) + `~/.o8/.env.local` (encrypted BYOK) | openrouter.ai/keys — top up credits |
| **Google / Gemini** | `GEMINI_API_KEY` (+ `GOOGLE_AI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) | Brain embeddings, "operator" default chat, Symon Gemini brain/polish/ask | login shell (`~/.zshenv`) | aistudio.google.com / Cloud console billing |
| **ElevenLabs** *(Symon premium voice — experimental)* | `ELEVENLABS_API_KEY` | Pitch-preserving premium voice (Symon TTS); **per-character** billing | `~/.o8/dictation.json` (not shell today; currently unset) | elevenlabs.io |
| **Stripe** *(license server on Railway)* | `STRIPE_SECRET_KEY`, webhook secret, price IDs | Mints paid licenses (the proxy SKU, later) | Railway env (`o8-license-server`) | dashboard.stripe.com |

### Optional / BYO-only — no funding unless used
| Account | Env var | Notes |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | BYOK only; the *work* path uses your Claude **subscription** (REPL), not a key |
| OpenAI | `OPENAI_API_KEY` | optional BYOK |
| DeepSeek | `DEEPSEEK_API_KEY` | optional BYOK |
| Brave Search | `BRAVE_SEARCH_API_KEY` | optional web-search tool |
| Vercel | `VERCEL_TOKEN` | deploys panel (o8-site only) |

### Non-API secrets that are still critical
| Secret | Location | Why it matters |
|---|---|---|
| **Release signing key** (minisign) | `~/.tauri/cortex-ide.key` | Every auto-update is signed with it. Rotating it **breaks updates for every installed app**. Back it up. |
| Apple Developer creds | `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_PASSWORD` (env at ship time) | Code-sign + notarize the build |
| Clerk **publishable** key | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (baked into build — public by design) | Sign-in. The **secret** key lives only on o8-site/Vercel, never in the desktop app |
| GitHub App | `~/.o8/github-app.pem` + `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` | Higher GitHub rate limits (falls back to `gh` CLI) |
| WS token / VAPID / JWT | `~/.o8/ws-token`, VAPID keys, `~/.o8/.jwt-secret` | Auto-generated per install; not funded |

**Funding reality for the proxy:** when the managed-inference plan goes live, the three accounts the proxy actually spends against are **OpenRouter** (primary), **Google/Gemini**, and **ElevenLabs** (premium voice). Those are the meters to watch; the rest are BYO or one-time.

### Where users bring their own keys (BYOK)
- **o8 → Settings → API Keys** (`APIKeysTab`, registered in `SettingsPage.tsx`). Currently offers **OpenRouter, DeepSeek, Anthropic**. Stored AES-256-GCM encrypted in `~/.o8/.env.local`; master key in the macOS Keychain. (`src/app/api/v2/keys/route.ts`, `PROVIDERS` array.)
- **Gap:** **Gemini-direct is not in that tab** — a BYO user reaches Gemini only via OpenRouter routing or a shell var. If free-tier Gemini features should be BYO-able, add a `google`/`gemini` entry to `PROVIDERS` in `keys/route.ts`.
- **Symon → voice settings window** — its keys (incl. ElevenLabs) live in `~/.o8/dictation.json`, separate from the o8 BYOK tab. (Matches "ElevenLabs is Symon, experimental.")

---

## 11. This release: free, data-first (Stripe deferred) — 2026-06-16 (PM)

**This version ships 100% free with no Stripe in the loop.** No checkout, no paywall, no payment to install or to use anything. The point of the current release is **adoption + data**: get o8 onto real machines and learn *who uses it and how* before we price anything. The levers in §5 stay designed-but-dormant until the data says what to charge for.

**The account token is a free credential, not a receipt.** The EdDSA entitlement JWT (in `~/.o8/entitlement.json`, applied via `/api/panel/entitlement` → `license.ts`) is issued **without payment** in this phase. Its two jobs:
1. **Proxy auth** — the bearer the managed-inference proxy needs to meter spend per account, so keyless machines get Brain/voice through our gateway (§5.1, the laptop test proved this path end-to-end).
2. **Usage attribution** — a stable per-install `sub` so the telemetry below can count distinct users and tie usage to an account.

It is **not** a feature key — the entitlement flags carry no moat-gating (see §6 + the `flags.ts`/`types.ts` fix). A future paid plan reuses the *same* token plumbing; today every token is effectively a free account. **There is no shipped issuance path yet** (neither free-on-signup nor paid-via-Stripe is end-to-end) — tokens are minted via the license-server admin endpoint for now; auto-issuing a free account token at first run is part of the work below.

### 11.1 What we gather (and where it already lives)
- **Proxy spend ledger** — `proxy_usage` (license server; integer micro-USD per call, per account, per `kind`: inference / embeddings / transcribe / gemini). Already capturing real COGS per account.
- **Account roster** — `subscriptions` / entitlement rows on the license server (distinct `sub`s = user count).
- **Product usage — TO BUILD.** Which surfaces get used (orchestrator turns, dispatches, Brain asks, canvas, Symon, mobile), how often, success/merge rates. No product-event pipeline exists today — only proxy COGS + account rows are captured.

### 11.2 Deliverable — usage-analytics dashboard (o8 front-end)
A founder/operator view answering **how many users, what they're using, how they're using it.** It lives on the **o8 front-end** as an operator-only surface, fed by an aggregate read API on the license server — the only place with cross-user data (the desktop app only knows itself).

- **Server** (`o8-license-server`): a new aggregate/admin read endpoint (Bearer `ADMIN_TOKEN`) over `proxy_usage` + accounts → user counts, DAU/WAU, per-`kind` spend, top surfaces. Plus a lightweight **product-event ingest** (`POST /v1/telemetry`: account `sub`, event name, coarse props) so usage beyond raw inference is visible.
- **Desktop emit**: a thin telemetry client that posts coarse events (surface opened, dispatch started, Brain asked, merge approved) with the account token — opt-out-able, no payload content.
- **Front-end**: an operator-gated analytics surface in o8 (count cards + per-surface usage + spend), reading the aggregate API. Not shown to normal users.

**Privacy guardrail:** telemetry is **coarse counts + account id only** — never code, repo names, prompts, or file contents. The "no secrets / personal-lane" posture applies.

*Tracked as issues filed 2026-06-16 (entitlement repurpose + analytics-dashboard epic).*

---

## 12. GTM posture — distribution first; the founding tier is patronage (2026-06-21)

**This phase's KPI is installs, not revenue.** With no audience yet, optimizing for $150 conversions optimizes the wrong variable. The install base *is* the asset: it's the funnel the build-in-public stream feeds, and it compounds into the Phase-2 metered business (worth ~8× founding revenue within a year). The stream's job is laptops, not sales — revenue is a *lagging* indicator of having put o8 on enough machines.

- **Phase 1 (now → there's a base AND cloud/relay/voice ship):** 100% free, frictionless; `/issue-free` mints a free credential at first run. **No paywall or signup wall ever touches the install funnel.** Track installs → weekly-active → "would be sad if it went away." Ignore MRR.
- **Phase 2 (base exists + infra levers shipped):** turn on the metered tier (~$19 unified + fair-use cap, §5.5). This is the real recurring revenue — cost-justified, sticky, scaling with the base Phase 1 built.

**The Founding Operator tier is patronage, not a revenue target.** It's the `/invites/*` founding-pass already built (#1249). **Grants (LOCKED 2026-06-21 — full spec in [`founding-operator-tier.md`](./founding-operator-tier.md)):** the app (free anyway) + the **managed-inference layer included for life, fair-use-capped** (fast Brain + dictation polish + premium Whisper STT — founders *never* pay the future infra tier) + **early access** as the headline perk (experimental always-on) + an exclusive **"o8" canvas theme** (free keeps light/dark) + status (badge, numbered, name on the wall, 5 founding passes). **The earlier "finite credit block" framing is dropped.** ElevenLabs premium voice + speech-to-speech stay **BYO-key for everyone** (not a founder perk).
- **Honest verdict on "will they buy at $150": almost nobody yet — and that's fine.** Price it as a tip jar for true believers, never a gate. The build-in-public ownership effect converts a handful; they become the advocate + feedback core and a willingness-to-pay signal. Model it as advocacy, not income.
- **LOCKED: 250 founders, tiered** — #1–100 $150, #101–200 $250, #201–250 $500 (~$65k raised, ~$33k lifetime-COGS cushion). Price climbs to reward earliness; cohort hard-capped at 250 for scarcity. Full ladder + solvency reasoning in [`founding-operator-tier.md`](./founding-operator-tier.md).
- **Discipline (non-negotiable):** the founding tier must never add friction to the free install — it's an optional "fund the journey" button. And **never sell lifetime-*unlimited* metered infra**: the per-account daily COGS caps (§5.5) + the capped cohort + BYO-key-is-free are what keep a one-time founder license solvent.

---

*Inputs: 6-domain codebase map 2026-06-16. History: `monetization-{tiers,build-plan,issues}.md`, `cloud-agents-open-agents.md`, `harness-vision.md`. Memory: `monetization_direction_pro_tier`, `m5_deploy_state`, `symon_o8_bridge_build_locked`, `o8_native_mobile_app`.*
