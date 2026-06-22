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
- [ ] **Dictation polish** — `google/gemini-flash-lite-latest` → `gemini-2.5-flash-lite` (`src/app/api/dictation/polish/route.ts`). Audit cost; test **SPEED** (slow sometimes → tune the 2-model loop / timeouts) + **ACCURACY** (target near-perfect — must never change meaning). Needs the **founder-deliberate fix** (today routes only as a no-key fallback). Plus a **free-mode** answer (free/slow model when no key/local).
- [ ] **Premium STT** — `openai/whisper-large-v3-turbo` (`src/app/api/dictation/transcribe/route.ts`). Needs a sample audio clip (or generate via macOS `say`) → WER + speed + $/min.
- [x] **Symon brain = Claude CLI (FREE, sub-billed)** — CORRECTED 2026-06-22: NOT Gemini/managed (operator won't pay that bill). Drop from the cost sweep. Its test is a **PERF** check — the CLI flow (warm-pool) should be warm + fast + fine-tuned.
- [ ] **Proxy overhead** — license-server hop + cap-enforcement latency.

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

## G. Inference backends — local / BYO-key / managed (the big fix, operator 2026-06-22)

Today every inference path (Brain compose, dictation polish, STT) is **BYO-key or managed only — no local option.** Add a **local-model backend** so anyone with the CPU/GPU power runs inference **free on their own machine** (no key, no managed cost to us). The provider seam already exists (model-id-with-`/` → OpenRouter; a local provider slots into the same seam — `monetization-and-free-tier-plan.md` §8). Operator can't test local (no high-end Mac) — **build the path; someone with the hardware validates.**

Per-path backend choice (settings): **local (free, your hardware) · BYO-key (free, your key) · managed (founder included / future $19 paid).**
- [ ] Local-model provider + per-path selector (Brain compose · dictation polish · STT).
- [ ] **Free-tier fallback:** when no local + no key, route free users to a **free/slow model** so they still get *some* help (slow but functional) rather than nothing.
- [ ] Validate on capable hardware (not the operator's machine).

## Explicitly NOT this launch (future)

- $19 managed subscription tier (Phase 2, dormant) · Symon max/S2S tier (BYO-key now) · cheaper Symon-only SKU (idea). See [`symon_voice_tier_ladder`] + [`monetization-and-free-tier-plan.md`].
