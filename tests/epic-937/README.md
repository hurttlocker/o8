# Epic #937 — Multi-Harness Control Plane Validation

Validation harness for the thesis: **o8 implements zero of the in-loop harness components and operates as the multi-harness control plane** — the layer above Cursor / Claude Code / Codex CLI / Cline that coordinates across them.

Each child issue (#938-#943) gets a folder with a REPORT.md, raw outputs (JSON / transcripts), and any scratch scripts.

## Order

1. **t1-recall** (#938) — Brain recall vs naive grep vs long-context. Most diagnostic; runs first.
2. **t2-substitution** (#939) — Mid-packet runtime swap. Phase 1 mechanism check, then 5-scenario sweep.
3. **t3-parallel** (#940) — N parallel packets across heterogeneous runtimes vs serial baseline.
4. **t4-governance** (#941) — o8 governance scaffolding lifts a weaker model's merge-ready rate.
5. **t5-context-carry** (#942) — Cross-runtime sentinel decision propagation. Runs only if t1 + t2 pass.
6. **t6-mcp** (#943) — External MCP client drives full o8 dispatch lifecycle.

## Conventions

- All work on branch `epic-937-validation`. Never push without founder asking.
- Commit format: `test(<test-id>): <short note>`.
- Smoke gate (`npm run smoke:qa`, OPENROUTER_API_KEY required) must remain 6/6 across every test.
- Codex usage is budget-constrained — Gemini and opencode carry default load.
- Each REPORT.md ends with a final `RESULT: PASS | FAIL | INCONCLUSIVE` block once the test is done.

## Baseline

- Smoke pre-test: **PASS 6/6** (33986ms total, p50 5.3s) — captured 2026-04-30 evening.
- Smoke post-T1: **PASS 6/6** (20450ms total, p50 3146ms) — env unchanged.
- Brain DB: `~/.o8/cortex-ide.db` schema v20, 1995 facts.
- All 4 CLIs on PATH: claude 2.1.123, codex 0.121.0, gemini 0.38.2, opencode 1.4.3.

## Status (final, 2026-04-30)

| # | Test | Result | Headline |
|---|---|---|---|
| 938 | Brain recall vs grep vs long-ctx | **FAIL** | Brain wins 1/10 vs Grep, 2/10 vs Long-ctx (pass bar 7/10) — substrate is comment-heavy (1416/1995 facts) and starves doc/PR/directive retrieval. |
| 939 | Mid-packet runtime swap | **INCONCLUSIVE** | Mechanism exists via create_mission, but 3 production gaps surfaced: reset doesn't kill CLI children, headless tick auto-re-dispatches with same runtime, opencode silently fails launch. |
| 940 | Multi-runtime parallel dispatch | **DEFERRED** | All 3 dispatchable runtimes blocked in this env: codex hardcoded `--model gpt-5-codex` (upstream blocks ChatGPT accounts), gemini stream-json needs `GEMINI_API_KEY` (user has GOOGLE_GENERATIVE_AI_API_KEY), opencode default `gpt-5-nano` needs OpenAI auth. Plus `.cortex-worktrees/.meta.json` drift bug. |
| 941 | Governance lift on weaker model | **DEFERRED** | Same dispatch-layer blockers as T3. |
| 942 | Cross-runtime context carry | **DEFERRED** | Depends on T1 (FAILED) and T2 Phase 2 (not run); transitively unsatisfiable. |
| 943 | MCP-as-API external composition | **PARTIAL FAIL** | 1/7 MCP tools work end-to-end (`o8_status` only — others 401 unauthorized or repo-registry gate). MCP→HTTP auth bridge gap; concrete adapter fix shows. |

### Cumulative findings cluster

The dispatchers are configured against an OpenAI-centric default that doesn't match this user's environment. The 4 small fixes that would unblock everything:
1. **Codex adapter:** stop hardcoding `--model gpt-5-codex`. Either let Codex auto-resolve OR read from a per-runtime setting.
2. **Gemini adapter:** translate `GOOGLE_GENERATIVE_AI_API_KEY` → `GEMINI_API_KEY` in the spawn env (or doc the requirement).
3. **Opencode adapter:** don't default to `opencode/gpt-5-nano`. Detect available providers via `opencode providers list` and pick a matching model.
4. **MCP `apiFetch`:** include `Authorization: Bearer ${ws-token}` from `~/.o8/ws-token` instead of relying solely on loopback bypass.

Plus separate fixes for:
- **`reset_packet` should terminate spawned CLI children** (T2 finding 1) — currently leaks codex orphans.
- **`reset_packet` should not auto-re-dispatch with the same runtime** (T2 finding 2) — should set `queueState='paused'` or expose a `set_packet_runtime` API.
- **WorktreeManager metadata reconciliation** (T3 finding) — `.meta.json` should self-heal against disk on every operation, not just create/list.
- **Substrate ingestion balance** (T1 finding) — depth-distill recent PRs / outcomes / directives instead of comment-only.

### Cost incurred (total)

- T1: ~$0.96 OpenRouter Sonnet 4.6 (10×3 paths + 10 judge)
- T2: ~$0.10 (1 truncated codex packet, 1 failed opencode launch)
- T3: ~$0.01 (1 codex CLI direct probe)
- T4: $0 (deferred)
- T5: $0 (deferred)
- T6: $0 (probes only, no dispatch)
- **Grand total: ~$1.07** OpenRouter + minimal Codex
- **Codex quota:** mostly preserved (only 1 partial dispatch + 1 direct probe)
- **Gemini quota:** untouched (auth gap blocked dispatch)
