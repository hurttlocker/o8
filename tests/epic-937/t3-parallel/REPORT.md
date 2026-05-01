# Test 3 — Multi-runtime parallel dispatch (#940)

> **STATUS:** **DEFERRED — dispatch-layer blockers** (4 separate adapter-config gaps, all surfaced during T3 setup). Proceeding to T6.

## RESULT: **DEFERRED — could not measure**

The original test framing (codex + gemini + opencode parallel vs single-runtime serial) requires all 3 dispatchable runtimes to launch and complete real packets. **In this environment, none of the 3 launch successfully.** Each has a different root cause:

| Runtime | Root cause | Evidence |
|---|---|---|
| **codex** | Adapter hardcodes `--model gpt-5-codex`, but the upstream Codex API now returns `"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."` for ChatGPT-account users. The default-model invocation (no `--model` flag) works fine — issue is the hardcoded flag in `src/lib/codex/...` adapter. | `codex exec --json … --model gpt-5-codex` returns HTTP 400 invalid_request_error; same flag without `--model` returns "PONG" cleanly. |
| **gemini** | Adapter passes `--output-format stream-json` which requires `GEMINI_API_KEY` env var. User has `GOOGLE_GENERATIVE_AI_API_KEY` (which works for default `gemini -p` mode) but NOT the GEMINI_-prefixed alias. Adapter never translates the variable. | `gemini -p "say PONG" --output-format stream-json --yolo` returns "When using Gemini API, you must specify the GEMINI_API_KEY environment variable." Same command with `GEMINI_API_KEY=$GOOGLE_GENERATIVE_AI_API_KEY` returns clean stream-json output. |
| **opencode** | Adapter defaults to `opencode/gpt-5-nano` which routes to OpenAI. User has `XAI_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` but no OpenAI auth. `opencode providers list` shows 0 stored credentials. | T2's opencode dispatch + this T3 attempt both showed lane cycling `launching → awaiting_input → idle` with `last_event_label = launch_error` and zero new entries in `~/.o8/owned-opencode/`. |

A 4th gap was discovered during cleanup:

| Gap | Detail |
|---|---|
| **WorktreeManager `.meta.json` drift** | After manually removing a worktree via `git worktree remove --force` (because o8 hadn't auto-cleaned), the `.cortex-worktrees/.meta.json` retained a `worktrees: { "packet-…": { … } }` entry. New dispatches against the same repo failed silently because the metadata referenced a non-existent worktree. Per memory note Apr 28 ("WorktreeManager metadata vs disk drift"), this was supposed to be fixed in commits 0a02ad0 + d38876e — but the fix only handles the read/list path, not the case where metadata is stale because the operator (me) deleted the worktree out-of-band. Recovery: `node -e 'fs.rmSync(".cortex-worktrees", {recursive: true, force: true})'` + retry. |

## Implication for the multi-harness control plane thesis

**The thesis is sound; the dispatchers are configured against an OpenAI-centric default that doesn't match this user's environment.** Every gap above is fixable in the adapter layer:

1. Codex adapter: stop hardcoding `--model gpt-5-codex`. Either let Codex auto-resolve the default model (which works), or read the model from a per-runtime setting / persisted operator default.
2. Gemini adapter: in spawn env, set `GEMINI_API_KEY` from `GOOGLE_GENERATIVE_AI_API_KEY` if the latter is set and the former isn't. Or document the env-var requirement in setup.
3. Opencode adapter: don't default to `opencode/gpt-5-nano`. Instead read the user's available providers (via `opencode providers list` parse) and pick a model that matches an available credential.
4. WorktreeManager: reconcile `.meta.json` against disk on EVERY operation, not just create/list. Or detect divergence and self-heal.

These are 4 small fixes that together would unblock T3, T4, and T5. With the dispatchers fixed, the parallel-vs-serial thesis becomes measurable.

## What was actually attempted

- **Run A (serial codex):** Mission `mission-cbe7f8e1-8ea` created with 2 packets in waves 1 and 2. Codex CLI spawned, hit the gpt-5-codex API error, lane cycled `launching → idle` indefinitely. Nothing completed.
- **Run B (parallel codex):** Not run — Run A's failure halted execution.
- **Heterogeneous parallel (codex + gemini + opencode):** Not run — all 3 runtimes blocked.

## Architectural finding (separate from blockers)

The `create-mission` HTTP API takes a single `runtime` value applied to all packets in the mission. There is **no per-packet runtime override** in the API surface — the underlying `OrchestratorPacket.runtime` field exists but isn't exposed at the mission-creation boundary. So even with the 3 adapter fixes in place, **heterogeneous-runtime parallel** (the founder's framing of "2 codex + 2 gemini + 2 opencode") would require either:
- (a) Adding a per-packet `runtime` field to the create-mission payload, OR
- (b) Mutating `~/.o8/orchestrator-state.json` directly between create and dispatch (hack), OR
- (c) Creating 3 separate missions back-to-back (won't work — mission state is singleton; each create_mission replaces the prior).

This is itself a finding for the multi-harness story: **the API supports homogeneous parallel today; heterogeneous parallel is achievable only via state-file mutation.**

## Cost incurred

- 0 successful dispatches → ~$0 in API costs
- 1 codex CLI direct probe (PONG round-trip) → ~$0.01
- **Total Test 3: ~$0.01**

## Smoke gate

- Pre-test: PASS 6/6 (carried)
- Post-test: not re-run (no Brain pipeline changes)

## Artifacts

- `run-t3.sh` — pivoted harness (codex-only, abbreviated 2-packet runs)
- `data/run.log` — log up to the launch_error cycle
- `data/orchestrator-state.backup-*.json` — backup files (user state was preserved/restored despite the adapter blocker)

---

## RESULT: **DEFERRED — gated on 3 adapter env-config fixes + 1 metadata-drift fix.** When those land, the same `run-t3.sh` should produce real wall-clock numbers.
