# Founding Operator — launch checklist (working tracker)

**Purpose:** the whole punch-list for the first public version that ships the founder offer. Work through + fine-tune over time while the desktop app gets polished. Companion to the locked spec [`founding-operator-tier.md`](./founding-operator-tier.md).

**Status as of 2026-06-22:** the buy→activate machinery is **done and live in TEST mode**. What remains is (B) making the perks actually function in the app, (C) two builds, (D) the live-money flip, and (F) the speed/accuracy/cost tuning sweep.

**Working sequence (operator-set 2026-06-22):** save this doc → `/v1/founders` endpoint → the proxy (B-1) → speed/accuracy/cost sweep across all managed paths.

---

## A. Locked & live (test mode) — done

- ✅ Model + tiered ladder + perks spec (`founding-operator-tier.md`).
- ✅ Desktop founder entitlement **shipped 0.1.428** — `plan:'founder'`, `resolveFlags`→`proxy.inference` ON, early-access wired (4 `use-experimental-*` hooks read founder status), AccountTab badge.
- ✅ License server live — `/v1/founders/count`→`{count:0}` verified, founders table created, fair-use cap `PROXY_CAP_FOUNDER_USD=$2/day`, tiered mint `plan:'founder'`, hard 250-cohort cap.
- ✅ Stripe TEST prices ($150/$250/$500, prod `prod_UkSvhmawUvg1TZ`) + Railway env + Vercel env.
- ✅ o8.run/founding **live & verified** (test): cohort API → `{claimed:0,total:250,position:1,tier:1,priceUsd:150}`; page shows Tier 1 / $150 / 0 of 250.
- ✅ Dev Clerk auth powering o8.run.

---

## B. Make the perks actually WORK (fine-tune core — this is the app work)

- [~] **B-1 — Managed inference routing ("the proxy"). INVESTIGATED 2026-06-22.** Proxy auth seam wired (founder JWT from `entitlement.json` → Bearer → license-server proxy, cap enforced). Per path:
  - ✅ **Premium Whisper STT — FULLY WIRED** (`/api/dictation/transcribe` → `/v1/transcribe`, cap-metered).
  - 🟡 **Dictation polish — PARTIAL** (`/api/dictation/polish` routes via plan token, but gated on key-*absence* not founder — same fallback as free; no founder-specific behavior/signal).
  - ❌ **Fast Brain — NOT WIRED (the gap).** The Q&A cascade (`cortex/qa/ask.ts`, `composer.ts`, `classifier.ts`) is entitlement-BLIND — tier selection reads only the local `classAComposer` operator-pref (`composer.ts:~550`), never plan/`proxy.inference`. Founders don't auto-get the fast tier. **FIX:** thread `proxy.inference`/founder into composer+classifier → auto-prefer the fast managed tier (no-BYOK founders). (`proxy.inference` is read behaviorally in only 2 spots today: `voice/realtime-access.ts`, `Gate.tsx`.)
- [ ] **B-2 — Early-access reload caveat.** Founder who signs in mid-session needs a reload before `experimental*` flips (module-cache; #1275 class). Decide: fix vs accept.
- [x] **B-3 — Exclusive "o8" theme — FIRST ONE DONE** (operator, 2026-06-22). Future: more founder themes + picture/ASCII canvas backgrounds — backlog, not launch.
- [ ] **B-4 — Founder badge.** Verify "Founding Operator #N" renders in the desktop AccountTab.
- [ ] **B-5 — Founders wall.** Shows "warming up" until the list endpoint (C-1) + a seeded/claimed #1.

---

## C. Remaining builds

- [x] **C-1 — `GET /v1/founders` list endpoint** ✅ **LIVE** — returns `{founders:[{position,displayName}]}` (deployed to Railway, verified `{founders:[]}`; wall now shows "claim seat #1"). Reads optional `perks_json.displayName` (privacy-safe — null → "Founding Operator"; never exposes email).
- [ ] **C-2 — Exclusive founder theme** (= B-3).
- [ ] **C-3 — Finish/verify managed routing** (= B-1).

---

## D. Go-live switches (real money) — ~15 min when ready

- [ ] Create **LIVE** Stripe prices ($150/$250/$500).
- [ ] Swap **LIVE** Stripe secret + webhook on Railway + Vercel (currently test).
- [ ] Register the live Stripe webhook endpoint.
- [ ] *(recommended for scale)* Production Clerk instance — dashboard + DNS on o8.run. Dev Clerk works for the soft launch.
- [ ] Flip env test→live both services, redeploy, verify.

---

## E. Pre-launch fine-tune

- [ ] Testimonials (live now) — confirm Sydney's & Taradio's quotes are approved to publish.
- [ ] Founder copy — final pass (currently on-spec, "not a stake in the company").
- [ ] **Founder #1** — seed `#1 Marquise`, or claim it live on stream (operator's call).
- [ ] Full hands-on e2e (4242 → webhook → count → desktop activation) — the stream test.

---

## F. Speed / accuracy / cost sweep (tune the managed layer)

Goal: measure every managed-inference path so we know what to push/adjust — better for founders now, subscription tier later. Metrics per path: **p50/p95 latency**, **cost** (the license server already logs `proxy_usage` micro-USD per call), **accuracy** (spot-check / eval set).

Paths to sweep:
- [x] **Fast Brain** — DONE (results below): `gemini-2.5-flash-lite` wins.
- [~] **Dictation polish — SWEPT + BUG FIXED 2026-06-22** (`scripts/founder-polish-sweep.mjs`). **Found:** the primary `google/gemini-flash-lite-latest` is an INVALID OpenRouter id — failed *every* call, forcing a wasted round-trip before the fallback = a major "slow sometimes" cause. **Fixed:** `POLISH_MODELS` now leads with `gemini-2.5-flash-lite` (0.37s, ~$0.00005/polish, accurate, coverage ~1.0 / no summarizing) → `deepseek-chat` fallback. **Still pending:** founder-deliberate routing (today a no-key fallback), free-mode, and passing the open-files anchor for spoken code-identifier accuracy (e.g. "class a composer" → `classAComposer`).
- [x] **Premium STT — TESTED 2026-06-22** (`scripts/founder-stt-sweep.mjs`, hits the real route). `openai/whisper-large-v3-turbo`: **1.09s** for a ~7s clip, **~5% WER** (1 word: "brain"→"brand") — and that residual recognizer miss is exactly what the **polish** pass corrects from context. Cost negligible (~$0.0001/clip). Wired + working.
- [x] **Symon brain = Claude CLI (FREE, sub-billed)** — CORRECTED 2026-06-22: NOT Gemini/managed (operator won't pay that bill). Drop from the cost sweep. Its test is a **PERF** check — the CLI flow (warm-pool) should be warm + fast + fine-tuned.
- [ ] **Proxy overhead** — license-server hop + cap-enforcement latency.

**Complete inference inventory (app-wide audit 2026-06-22) — answers "is there anything else?":**
- **Founder user-facing PERKS (managed, what they pay for):** fast Brain · dictation polish · premium STT. **That's it — nothing new.**
- **Background managed COGS** (small, runs for EVERYONE — do NOT gate founder-only; it's free-tier infra): embeddings (OpenAI `text-embedding-3-small`, Brain storage), spec image-captioning (Gemini vision), contradiction-detection (Gemini, over directives), project-suggestions (Gemini, cache-heavy), Q&A classify (Gemini). Matters for subscription COGS, not the founder edition.
- **Free to us — BYO-sub** (user's Claude/Codex CLI): orchestrator + dispatched workers (coding), auto-review, GitHub intake, heal-bot, auto-compact, fact/doc distillation, **Symon's Claude/Opus brain**.
- **BYO-key only** (no o8 fallback): ElevenLabs voice, Google TTS, OpenAI realtime/S2S, Symon Gemini-direct.
- Net: founder managed perks = exactly {fast Brain, polish, premium STT}; everything else is tiny background COGS for all users or already free via their sub/key.

Tuning levers to evaluate: model choice per path, caching, context trimming, fallback ordering. (See the S2S cost research — caching + trimming was the dominant lever; expect similar on Brain.) Output: a table the operator reads to decide tunes.

**Sweep v1 results — Brain compose model comparison (2026-06-22, `scripts/founder-brain-sweep.mjs`, n=1/q over 3 repo Qs):**

| model | avg latency | ~$/query | verdict |
|---|---|---|---|
| **`google/gemini-2.5-flash-lite`** | **0.48s** | **~$0.00004** | **WINNER** — fastest + cheapest, accurate |
| `deepseek/deepseek-chat` | 0.41s | ~$0.00009 | comparable, viable fallback |
| `x-ai/grok-4.3` | 0.48s | ~$0.0013 | same speed, ~30× cost → skip |
| `anthropic/claude-sonnet-4-6` | 1.32s | ~$0.0019 | 3× slower, ~45× cost; most thorough → quality/escalation tier only |

**DECISION: route founder fast-Brain to `gemini-2.5-flash-lite`** (already the cascade's 'fastest' primary). Empirical solvency: a heavy founder (100 q/day) ≈ **$0.12/mo** vs the $2/day cap = huge headroom → "managed Brain included for life" is near-free, and **30–60× faster than the 15–30s CLI** free users get. `grok`/`sonnet` = paid "quality" escalation only, not default. (Harness re-runnable as a baseline; add p95/multi-run + polish + STT paths next.) **→ feeds the B-1 wiring (step 3): gate founders to this tier.**

---

## G. Inference backends — local / BYO-key / managed (SCOPED 2026-06-22)

**Full build-spec: [`local-inference-backend-scope.md`](./local-inference-backend-scope.md).** Headline: **~80% already built** — embeddings run local Ollama, operator-defaults carry `localInferenceBaseUrl`/`localEmbedModel`, the Settings "LOCAL MODELS" section exists, and Codex dispatch runs local. **The gap:** `inference-route.ts` has no local branch → local is invisible to Brain compose/classify + polish + STT.

**v1 (~7–8h):** wire a **liveness-gated `local` branch** into `resolveOpenRouterRoute()` (chain: **local → BYO-key → managed → free/slow**), add `localChatModel` + a "Chat model" Settings row + a `/api/setup/local-inference/probe` route. Ollama, `qwen2.5-coder:7b` suggested default. Local **backstops** the paid OpenRouter call (keeps fast CLI tiers). Free/slow fallback already exists (the cascade's Flash/heuristic/sources floor).
- [ ] Build v1 per the scope doc (one global setting, opt-in; fresh installs unchanged).
- [ ] **Critical:** the cached liveness-probe gate (a dead Ollama must NOT hang the chat path) — needs hardware validation (operator can't test).
- [ ] **Open question (operator):** local *backstops* the paid call (v1 rec) vs local *leads* everything — confirm.
- [ ] Deferred: local STT (whisper.cpp), MLX, model auto-pull UX, Symon (Rust) local config.

## Explicitly NOT this launch (future)

- $19 managed subscription tier (Phase 2, dormant) · Symon max/S2S tier (BYO-key now) · cheaper Symon-only SKU (idea). See [`symon_voice_tier_ladder`] + [`monetization-and-free-tier-plan.md`].
