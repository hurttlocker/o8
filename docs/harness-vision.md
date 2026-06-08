# o8 — The Harness Vision (CLI + MCP, top-of-class + 2028-ahead)

**Status:** vision doc · 2026-06-07 · derived from the "Harness Engineering 2026" framework ([[harness_engineering_2026]]) + a multi-angle design pass. Internal.

## Executive vision
**o8 is the productized, governed, *self-tuning* harness** — the OS layer any agent (Codex, Claude Code, Gemini, opencode, whatever ships next) boots into to ground itself in org memory, get a structured impact map before touching a file, pass an independent skeptic, and clear a merge gate. Today o8 is ⅔ of that: a strong agent-side CLI + a deep governance core (doer/judge/skeptic AGREE-gate, grounded scope, the Brain) that's **trapped behind the desktop/MCP path**. Three moves complete it and then leap past the article:
1. **Lift** the MCP-only governance loop into **headless CLI verbs** → the moat enforced in **CI**, not just chat.
2. **Materialize** the article's missing artifacts (JSON feature-list tracker, 7-step boot, grounded impact map, sprint contract, shell-driven wave engine).
3. **Self-measure & self-delete** — every gate runs a sampled A/B shadow vs. the live model; per-component lift is written to `harness_component_metrics` keyed on **model id**; an operator-gated lifecycle (RETAINED → CANDIDATE → SHADOW-ONLY → RETIRED, **bidirectional**) sheds scaffolding the model outgrew and re-arms it when a new model regresses. **The harness gets a metabolism.**

> The agent is swappable. The governance is fixed + scriptable. The harness *knows when to get out of the model's way* — and can prove the +Npp it buys. No competitor has that.

## CLI additions (the harness CLI — wraps any agent, isn't a coding CLI)
- `o8 dispatch <issue|--prompt> --repo --wait --json` — headless create+launch; `--wait` lets CI gate on the lane. **#1 gap.**
- `o8 review <id> --skeptic` · `o8 approve <id> --require skeptic-agree` · `o8 reject --feedback` — the doer/judge/merge gate as verbs; **`--require skeptic-agree` = the moat enforceable in CI.**
- `o8 feature list --failing|next|verify|add|status` — the **JSON feature-list verify tracker** (absent today; the long-autonomous-run core loop).
- `o8 ground <issue> --repo [--apply]` — the **grounded impact map** before code (real paths/symbols/acceptance; auto-computed but invisible today).
- `o8 boot` — the 7-step session-init envelope in one call. `o8 ask "<q>" --cite` — the Brain from any shell.
- `o8 sprint start|tick` — shell-drive the wave engine. `o8 contract <id> --negotiate --accept` — generator/evaluator handshake before code.
- `o8 harness status|measure|retire|arm` — **build-to-delete management** (the differentiator surface). `o8 bench harness-lift` — prove the +Npp.
- `o8 ci --config o8.ci.json` (+ a GitHub Action) — boot→ground→contract→dispatch→verify→review→gate as one CI contract. `o8 observe` — write postmortems back to the Brain.

## MCP additions (harness-as-a-service for the whole ecosystem)
- **`o8_evaluate_diff` — THE killer wedge.** Standalone skeptic-as-a-service: Cursor/Codex/Gemini generate, then call o8 for a **blind second pass that never saw their generation** → `{tier, verdict, finding, scopeTraces}`. Harness lift sold to a model o8 never ran, without holding their keys. Makes o8 *infrastructure*, not a wrapper.
- `o8_feature_list_*` (get/next/mark) · `o8_ground_task` (+confirm; dispatch gated on a grounded map) · `o8_session_boot` (role-aware) · `o8_negotiate_contract` · `o8_verify` (computational feedback as a service).
- `o8_harness_lift_*` (per-component decay report + deletion recommendations) · **`o8_capabilities`** — discovery manifest: available artifacts, recommended call order (boot→ground→contract→dispatch→verify→evaluate→merge), and **per-model skip recommendations** so the harness adapts its own depth. Turns o8 from "a server with tools" into "the harness the ecosystem boots into."

## Ahead-of-everyone differentiators
1. **Self-measuring / self-deleting harness** (lead with this). A harness with a metabolism — measures each gate's lift per model, retires dead scaffolding, re-arms on regressions. Primitives already exist in o8 (`three-way-runner.ts`, `substrate-eval-thresholds.ts`, `decay.ts`+`proposer.ts`) → unify into `src/lib/harness/`. **Generalization, not greenfield.**
2. **Evaluator/skeptic-as-a-service** (`o8_evaluate_diff`) — the wedge that makes o8 ecosystem infrastructure.
3. **Proven harness lift** (`o8 bench`) — o8 owns the `session_outcomes` ledger (+ `mergedClean`); only o8 can report "harness health" / "+Npp" / "Brain-vs-grep delta."
4. **Harness discovery manifest** + **portable HarnessBundle** (export directives/policies/audit/lift-curves; on-prem) — portability = the adoption funnel; the **per-model lift curves** (fed by every operator's shadow runs) = the compounding moat.
5. **Operator signal as the training loop** — edits/rejections → auto-directive proposals → the Brain learns; the loop closes without prompt tuning.

## Phased roadmap
- **Phase 0 — Headless governance loop:** `o8 dispatch/review/approve/reject` (thin wrappers over existing HTTP routes). Lowest effort, highest leverage — unlocks everything; the moat becomes CI-enforceable. *No new data model.*
- **Phase 1 — Feature ledger + grounded artifacts:** `features`/`feature_checks` tables + `o8 feature` + `o8 ground` (gate dispatch on a grounded map) + `o8 boot`/`o8 ask`. The two confirmed-absent artifacts.
- **Phase 2 — Contract negotiation + sprint engine:** `o8 contract` + `o8 sprint` + `o8_verify`. Closes "plan ≠ execution" + the feedforward quadrant.
- **Phase 3 — Self-measuring / self-deleting harness (the differentiator):** `src/lib/harness/` — A/B shadow hooks, `harness_component_metrics` (model-keyed), weekly cron, the lifecycle, `o8 harness` + Settings→Diagnostics Harness Health panel.
- **Phase 4 — Harness-as-ecosystem-OS:** `o8_capabilities`, hardened `o8_evaluate_diff`, `o8 ci` + Action, HarnessBundle export/import, on-prem.

## Monetization tie
- **FREE** = the full *single-operator* harness (agent-side CLI + headless governance loop + `o8 ask/boot/feature/ground` + one harness profile). Frictionless adoption → o8 on every machine + CI.
- **PRO/TEAM** = the harness's **brain + metabolism** (the layer models can't commoditize): the self-measuring/self-deleting subsystem + Harness Health + per-model lift curves; multi-repo fleet + mobile; `o8_evaluate_diff` at fleet/CI volume + the AGREE-gate as a required CI check; the per-model lift *intelligence* (only o8 has it).
- **ENTERPRISE** = harness ownership/portability (signable HarnessBundle, on-prem, audit, registry).
- **Rule:** charge for the platform layer + the lift data — *never* the harness features. Portability is the funnel; the lift data is the lock-in. Stay upstream (governance + signal + measurement); let the ecosystem innovate on engines downstream.

## Top-3 bets (if only three)
1. **Lift the governance loop into headless CLI** (Phase 0) — turns the MCP-only moat into something a GitHub Action enforces. Precondition for everything.
2. **Ship the self-measuring / self-deleting harness** (Phase 3) — the one thing no competitor has + the article's punchline; primitives already exist.
3. **Build the feature ledger + grounded map** (Phase 1) — the two absent artifacts that make long autonomous runs actually converge.
