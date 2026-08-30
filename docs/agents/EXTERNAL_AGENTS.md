# EXTERNAL_AGENTS.md — driving o8 from the outside

How any external agent (Claude Opus/Sonnet via MCP, or anything that can run a CLI) controls o8 proficiently with zero UI touches. The o8 desktop app must be running (it hosts the API the tools call).

## Setup (one time)

1. Launch o8.app once — it writes the discovery files:
   - `~/.o8/api-port` — the local API port (fallback: 3001)
   - `~/.o8/ws-token` — Bearer token (only required for non-loopback callers; localhost requests skip auth)
2. **MCP**: spawn the operator server from the repo root — `.mcp.json` already does this for Claude Code sessions opened here:
   ```json
   { "mcpServers": { "o8": { "command": "npx", "args": ["tsx", "src/lib/mcp/operator-mcp-server.ts"] } } }
   ```
   Env overrides honored: `O8_API_PORT`, `O8_API_TOKEN`.
3. **CLI**: `o8` is symlinked to `/usr/local/bin/o8` after first app launch. `o8 doctor` verifies port/token resolution. JSON output by default; `--human` for ANSI.

## The dispatch loop (the core recipe)

```
o8_operator_defaults({})                          # read current brains/gates
o8_operator_defaults({orchestratorModel: "...",   # optionally pick the brain for this work
                      thinkingEffort: "high"})    # (GLOBAL + persistent — restore after!)
create_mission({issues: [495] | issues_inline: [{title, body}], repoPath, runtime})
get_mission_status() / mission_tail({packetId})   # watch
o8_packet_diff({packetId})                        # read the actual code (byte-bounded)
o8_merge_preview({packetId})                      # dry-run the governance gates
submit_review({packetId, approved, findings})     # ALWAYS record this first (audit trail);
approve_and_merge({packetId})                     # then ship. In that order.
```

Small Codex tasks typically complete in 2–5 minutes — `wait_for_mission_ready` with the default 10-min timeout is usually one call.

If a gate blocks: `o8_merge_preview` names the check; `o8_packet_diff` shows the offending lines; `rerun_with_feedback` or `submit_review({approved:false, findings})` sends it back with instructions. Never bypass a gate.

## Packet states & failure triage

- **Terminal-good:** `awaiting_review` (your cue to diff + gate-check) · `released` (merged).
- **Terminal-bad:** `failed` · `archived` — but `archived` after a worker failure is often **recoverable**: if the transcript shows an external cause (quota, auth), `rerun_with_feedback` can revive the packet on a fresh lane.
- **Stuck — needs YOUR intervention; more waiting will not help:** `blocked` / `awaiting_input`, and last-events like `silent_exit_no_work` or `agent_failed`. `wait_for_mission_ready` does **not** treat these as terminal — inspect `get_mission_status` on every wake; a timeout does NOT mean still-running.
- **First move on any failure or empty diff: read `o8_packet_transcript`.** The worker's real error (quota exhaustion, auth, build break) lives in the transcript, not in the status label.
- **Recovery selection:** warm parked session → `steer_packet` · dead/no-work session → `rerun_with_feedback` (fresh worker, same packet) · start truly clean → `reset_packet` then `dispatch_mission`. One rework round, then stop and report to the operator.
- **Worker quota exhaustion** (e.g. Codex usage limits) presents as `silent_exit_no_work` or `agent_failed` — the diff may be empty OR partially complete (work committed before the wall). **Always confirm in the transcript**; don't infer from the diff alone. Then wait for the reset or switch runtime — do not redispatch into the same wall.
- **After any merge, verify with git** (`git -C <repo> log --oneline -1` via the operator or `o8 packet info`): a `merged:true` / `alreadyReleased` response is bookkeeping, not proof a commit landed (see hurttlocker/o8 lane-drift issue).

## Tool inventory (by job)

- **Configure**: `o8_operator_defaults` (read/set orchestratorModel, thinkingEffort, overlapGate, parallelCap, defaultDispatchRuntime, healBot, supervisor, promptCaching — global, persistent)
- **Dispatch**: `create_mission` (creates + dispatches by default), `dispatch_mission` (rare — post-reset), `reset_packet`, `retry_packet`, `rerun_with_feedback`
- **Watch**: `o8_status`, `get_mission_status` (`includeCost: true` for spend), `mission_tail` (cursor long-poll), `o8_lane_events`, `o8_packet_transcript`, `wait_for_mission_ready`
- **Review/ship**: `o8_packet_diff`, `o8_merge_preview`, `submit_review`, `o8_review_state`, `approve_and_merge` (idempotencyKey supported), `o8_approve` / `o8_reject` (chat-level)
- **Steer**: `o8_send` (new task or nudge a session), `steer_packet`
- **Task pool**: `o8_task_list/create/brief/claim/dispatch/block/report/archive/prune`
- **Repo/project**: `o8_register_repo`, `o8_init_repo`, `o8_create_project`, `o8_scaffold`, `get_packet_scope`, `o8_user_context`
- **Brain**: `cortex_ask` (query project memory/directives), `cortex_propose_observation` (proposal queue — not a direct write)
- **Spec (o8.md)**: `o8_spec_read/review_index/pending_feedback/validate/comment/reply/resolve/suggest`
- **UI automation (last resort)**: `o8_view_*` (screenshot, snapshot, click, type, read, eval, navigate, scroll, press_key, wait_for, console_errors, active_route) — prefer the API tools above; the webview is for verification and the rare UI-only surface.

## Model & cost control

- **Orchestrator brain**: `o8_operator_defaults({orchestratorModel})`. Default is Opus-class; drop to `claude-sonnet-4-6` for routine sweeps. `thinkingEffort`: `adaptive | low | medium | high | max | xhigh`.
- **Worker runtime**: per-mission via `create_mission({runtime: "codex" | "gemini"})`; the global default via `o8_operator_defaults({defaultDispatchRuntime})`. The Codex worker model itself is configured in `~/.codex/config.toml` (not exposed here).
- **Defaults are global and persist.** If you change them for one mission, read-before-write and restore afterward.
- Cost visibility: `get_mission_status({includeCost: true})`.

## Governance posture (read before you automate)

- `overlapGate`: `strict` blocks parallel packets touching the same files; `advisory` warns. Tune per sprint via `o8_operator_defaults`, restore after.
- Merge gates are the product. An external agent's job is to **satisfy** them — read the diff, fix the violation, re-run — never to route around them. The four: **security-patterns** (regex scan for dangerous calls/secrets), **diff-budget** (size limit on the change), **untracked-imports** (no imports of files outside the packet's scope), **self-review-integrity** (the worker's self-review must match the actual diff).
- **PR-only dogfood mode:** a repo may be configured so merge-to-main is blocked — `approve_and_merge` returns an honest `merged:false` naming PR-only mode, with gates listed as passing. That IS the governed success state for an agent: stop there and report; a human opens/merges the PR. Do not hand-merge with git and do not treat it as a failure.
- `cortex_propose_observation` is a proposal queue by design; directives are operator-approved.

## CLI quick reference

```
o8 status · o8 doctor · o8 run [--detach] <cmd>
o8 task {list,create,brief,claim,dispatch,block,report,archive,prune}
o8 packet {info,scope,diff,commit,heartbeat,review,report,capture,mirror-proof,log,runtime-drift}
o8 spec {read,index,pending,validate,comment,reply,resolve,suggest}
o8 cortex observe · o8 lane touches
```
Exit codes: 0 ok · 1 invalid args · 2 connection refused · 3 unauthorized · 4 not found · 5 conflict.

## Gotchas

- The app must be running; `connection refused` (CLI exit 2) means launch o8.app.
- Long-poll calls (`wait_for_mission_ready`, `mission_tail`) can transiently report "API unreachable" while the app is fine — re-probe with `get_mission_status` and resume. Only a hard `connection refused` means the app is down.
- `o8_packet_diff` is byte-bounded (64KB default, 512KB cap via `maxBytes`) — check `truncated` before judging a large diff.
- `create_mission` dispatches immediately by default — pass `dispatch: false` to stage.
- Claude runs as the orchestrator only; packet workers are Codex/Gemini.
- Loopback callers need no token; anything non-local needs `Authorization: Bearer $(cat ~/.o8/ws-token)`.

## Acceptance bar

A fresh external agent reading only this file should be able to: register a repo → set its preferred brain/effort → create + dispatch a mission → watch it → read the diff → fix a gate violation via feedback → merge — without touching the UI.
