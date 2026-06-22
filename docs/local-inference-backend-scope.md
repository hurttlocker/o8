# Local-model inference backend — build scope (2026-06-22)

**Goal:** users with the CPU/GPU power run inference **free on their own machine** (no API key, no managed cost). Per-path backend becomes **local · BYO-key · managed**, with a free/slow fallback when none. Companion to [`founding-launch-checklist.md`](./founding-launch-checklist.md) §G.

## Headline: ~80% already built

Already shipped (the precedent + plumbing):
- **Embeddings run local Ollama** — `src/lib/cortex/embeddings.ts:106-110` (local-first → OpenAI fallback).
- **Operator-defaults carry local fields** — `localInferenceBaseUrl` + `localEmbedModel` (+ env `O8_LOCAL_INFERENCE_BASE_URL`/`O8_LOCAL_EMBED_MODEL`, sync resolvers) in `src/lib/operator/defaults.ts`.
- **Settings UI exists** — `src/components/desktop/settings/LocalModelsSection.tsx` (SECTION 10 "LOCAL MODELS", Ollama/LM Studio preset chips).
- **Codex worker dispatch already runs local** — `src/lib/codex/local-model.ts` (`ollama:`/`lmstudio:` → `--oss --local-provider`).

**The gap:** `src/lib/cortex/qa/llm/inference-route.ts` has **no local branch** — `resolveOpenRouterRoute()` + `resolveTranscribeRoute()` go direct-key → proxy → null. So local is invisible to **Brain compose/classify + dictation polish + STT.** v1 = wire local into that seam.

## Architecture (v1)

- Add `'local'` to `InferenceRoute.via` + an optional `model?: string` on the route. Local endpoints (Ollama/LM Studio) are OpenAI-compatible (`/v1/chat/completions`) so the request body is identical — consumers need ~no change for the happy path.
- **Local-first branch at the top of `resolveOpenRouterRoute()`**, gated by a **cached liveness probe** (see Risk #1). Resolution chain: **local → BYO-key (direct) → managed (proxy) → null** (→ the existing free/slow CLI/Flash/heuristic tiers).
- **Model-id fix:** callers pass cloud ids (`google/gemini-2.5-flash-lite`) a local endpoint won't know. The resolver returns `route.model` (the configured local chat model); callers do `body.model = route.model ?? body.model`. One-line per caller; routing stays in the resolver.
- **Local = the tier-3 HTTP replacement (backstop), not the lead** — it replaces the *paid* OpenRouter call, preserving the fast subscription-CLI tiers. (Local-leads is a deferred composer reorder.)
- **One global setting** (`localChatModel`), not per-path. Default `''` = cloud → fresh installs unchanged, local is opt-in.
- **Skip the spend-cap + spend-record on `via:'local'`** (it's free).

## Runtime + models
- **Ollama for v1** (already the precedent; OpenAI-compatible; `GET /api/tags` = free model detection; one-line install). LM Studio rides free (also OpenAI-compatible, already a preset). **MLX deferred.**
- Chat/compose/polish suggested default: `qwen2.5-coder:7b` (16GB-friendly) / `:32b` for more RAM / `llama3.1:8b` alt — *UI suggestions, user picks*.
- Embeddings: `nomic-embed-text` (already wired). STT-local (`whisper.cpp`): **deferred to v2**.

## v1 files + effort (~7–8h)

| File | Change | Effort |
|---|---|---|
| `src/lib/cortex/qa/llm/inference-route.ts` | `'local'` via + `model`; local-first branch w/ cached liveness gate | M (~1.5h) |
| `src/lib/operator/defaults.ts` | `localChatModel` field/fallback/env/resolver (mirror `localEmbedModel`) | S |
| `src/lib/cortex/qa/composer.ts` | apply `route.model`; log `via:'local'` | S |
| `src/lib/cortex/qa/llm/openrouter-adapter.ts` | honor `route.model`; skip cap/spend-record on local | S |
| `src/app/api/dictation/polish/route.ts` | use `route.model` when local | XS |
| `src/components/desktop/settings/LocalModelsSection.tsx` | "Chat model" row + presets + liveness badge | M (~1h) |
| `src/components/desktop/settings/OperatorDefaultsTab.tsx` | thread `localChatModel` (3 spots) | S |
| `src/app/api/panel/operator-defaults/route.ts` | accept/validate `localChatModel` | XS |
| `src/app/api/setup/local-inference/probe/route.ts` | **new** GET → proxies `/api/tags` → `{running, models}` (setup family, no token) | S |
| `src/lib/cortex/qa/llm/inference-route.test.ts` | local-branch + dead-endpoint-fallthrough cases | S |
| `.env.example` + `CLAUDE.md` (Cortex billing) | document `O8_LOCAL_CHAT_MODEL` + the local chat tier | XS |

**Order:** (1) `localChatModel` default → (2) probe route → (3) inference-route local branch + liveness gate → (4) consumer model-id threading → (5) Settings UI → (6) tests + docs. Steps 1–2 parallel; 3 needs 1+2; 4 needs 3.

## Deferred (later)
Local STT (whisper.cpp sidecar — `resolveTranscribeRoute` branch, audio/Tauri packaging) · MLX · model auto-pull UX · local-as-primary-compose-tier (post-benchmark) · Symon (Rust `src-tauri/src/agent/`) local config.

## Risks / open questions (heightened — operator can't test local)
1. **Dead-endpoint HANG (#1 risk):** a `fetch` to a stopped Ollama hangs/ECONNREFUSEs and burns the timeout. The **cached liveness-probe gate is MANDATORY** — skip the local branch unless a recent `/api/tags` probe (~30s cache) succeeded. Hardware-validator acceptance cases: (a) up + model pulled, (b) up + model NOT pulled, (c) down.
2. **Model-id mismatch** silently 404s without the `route.model` override — verify the body carries the local name.
3. **Quality cliff:** does `qwen2.5-coder:7b` respect the compose citation-handle contract (`rowDisplayTitle` sources)? Validator must check; bump the default suggestion if it breaks.
4. **Embedding-dim drift:** switching embed model (cloud 1536 ↔ local 768) makes stored vectors incompatible → needs re-index. Pre-existing; flag on change.
5. **OPEN QUESTION (operator):** v1 = local *backstops* (replaces the paid OpenRouter call, keeps fast CLI tiers) vs local *leads* everything. **Rec: backstop for v1**, revisit after benchmarks.
