# Founding Operator — the $150 tier (LOCKED 2026-06-21)

**Status:** locked. This is the authoritative spec for what the one-time **$150 Founding Operator** tier gets vs. free users. It refines `monetization-and-free-tier-plan.md` §12 (the earlier "finite credit block" framing is **dropped**). Written for the build agents (front-end + others) so everyone implements against the same model.

It does not change the core thesis — **monetize cost, not capability; distribution-first; the app is free either way.** It defines the one optional "fund the build" tier on top.

---

## The model in one line

> **Free = run it on your own keys/CLIs (works, but slower / manual). Founder = we run the fast, automatic, managed version for you — included for life, within fair use.**

$150 one-time. **First 100 operators only.** The app is 100% free with or without it. The $150 funds the build and turns the managed-inference layer ON for the believers — permanently. It must **never** add friction to the free install.

---

## What free users get (everything — ungated)

The whole product ships free at ~$0 cost to us, because the work runs on the user's own CLI subscription or locally:

- Governance / merge-gate / review, the Engineering Brain, multi-repo fleet, orchestration, AgentPanel/O8Panel, embedded browser agent.
- **Canvas** — full surface, **light + dark themes**, drag/resize/zoom/glass.
- **Brain Q&A** — works on the user's own Claude/Codex sub. Correct, but pays a **15–30s CLI bootstrap per query** (no managed speed tier).
- **Dictation / voice** — local Apple Speech (STT) + Edge / macOS `say` / Google Neural2 (TTS). The same default voice serves both o8 desktop and Symon.
- **Symon agent** — runs on the user's Claude CLI (free).
- **Mobile** — on your own LAN / Tailscale.
- **ElevenLabs premium voice + speech-to-speech** — **bring-your-own-key** (free if you have the key). Not part of any paid tier yet.

Free is never the crippled version. Light/dark stay genuinely beautiful — the canvas is the viral demo, and the "wait, this is free?" moment is the go-to-market.

---

## What the $150 Founding Operator gets

Founders get **TIME, STATUS, MONEY, and VOICE — never a locked door in front of a feature.**

### Managed inference — included for life (fair-use capped)

The "use us instead of your own CLI/local" layer, turned **ON automatically** and **included for life**:

- **Fast Brain** — managed speed tier → instant answers instead of 15–30s on your own sub.
- **Dictation polish** — Gemini, automatic.
- **Premium STT** — Whisper (so dictation is end-to-end premium, not polished-text-from-a-worse-transcript).
- *(optional)* managed Symon brain.

Founders **never pay the future ~$19 infra tier** — it's just on for them. A **fair-use cap applies** (never lifetime-unlimited metered — that's the solvency rule, non-negotiable).

**NOT included** (stays BYO-key for everyone, founder or not): **ElevenLabs premium voice** and **speech-to-speech**. These are per-character / realtime costs we don't carry yet. Revisit local S2S once better local-model hardware is available.

### Early access — the headline perk

> "Experimental is always on for you, forever."

Founders are permanently a release-channel ahead — new surfaces land for them weeks before they graduate to everyone. This is **timing, not a wall**: every feature reaches free users eventually. (Implemented by flipping the existing `experimental*` operator flags ON for the founder plan.)

### Exclusive theme — the founder flex

Free users get **light + dark** (kept beautiful). Founders get an exclusive **"o8" signature theme**, with more founder-only themes over time. This is **additive cosmetic only** — we never remove theming from free. (Note: the theme registry only has light/dark today, so the signature theme is a small build.)

### Status + community

- Founding Operator **badge**, numbered (first 100).
- **Name on the founders wall** (in-app + o8.run).
- **5 collectible founding invite passes** to hand out (#1249) — doubles as distribution.
- Founders' channel + roadmap input.

---

## The seam map (free vs founder)

| Inference seam | Free path (your CLI / local) | Founder ($150) |
|---|---|---|
| Engineering Brain | Works on your sub — correct but 15–30s/query | Managed speed tier ON → instant |
| Dictation polish | raw transcript, none | Gemini polish ON, automatic |
| Dictation STT | Apple Speech (local) | Premium Whisper |
| Symon brain | Claude CLI (free) | optional managed Gemini |
| Voice / TTS | Edge / `say` / Neural2 | same (no premium TTS tier) |
| ElevenLabs voice | BYO key | BYO key — **not founder** |
| Speech-to-speech | BYO key | BYO key — **not founder** |
| Canvas theme | light + dark | + exclusive "o8" signature theme |
| Mobile relay / cloud | (not built) | locked-in when it ships |

---

## Why included-for-life is solvent

It's affordable *because* the cohort is bounded and self-selecting:

- **First 100 only** — a capped, finite cohort.
- **Dev-heavy / sub-backed** — founders almost all have their own Claude/Codex CLI subs, so most inference rides their sub (compose is free to us) — real managed COGS is ~pennies/month each.
- **Fair-use cap** — the per-account daily COGS ceiling (§5.5) bounds the worst case.
- **COGS drops over time** — new/cheaper models on the real surfaces push our cost down further.

Order of magnitude: ~$15k in vs. ~$100–300/mo total COGS across all 100. The cap, not the price, is the solvency guarantee.

---

## Implementation notes (for the build)

- Add `'founder'` to the plan type. A redeemed founding pass (#1249) issues a signed `plan: 'founder'` token → written to `entitlement.json`.
- `resolveFlags('founder')` flips `experimental*` flags ON (early access) **and** `proxy.inference` ON (managed tier).
- Managed inference routes through the o8 gateway with a **server-side per-account fair-use cap**.
- Build the exclusive **"o8" canvas theme** (registry currently ships light/dark only).
- **Drop** the honor-system "founder rate / finite credit block" — replaced by "managed essentials included for life, fair-use-capped."
- Keep the existing `<Gate>` component for capability-gating UNUSED — founders get *more* (managed + early access + theme), free users are never capability-gated.

---

## Still open (numbers only)

- Founder **count** — 50 vs 100.
- **Price** — $150 vs $199.

Everything else above is locked.
