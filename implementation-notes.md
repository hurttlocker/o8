## Deviations

- Branch route cache: added a focused helper module because the route's 74-line addition and 37-line deletion caps cannot accommodate the async, concurrency-capped snapshot implementation without exceeding its preservation budget.

- Symon o8-hosted PTYs: added a separate authenticated WS-bridge endpoint because the existing panel proxy intentionally exposes names only and always appends Enter, which cannot support metadata or raw control sequences.

- Pi permission-gate bridge: reused `src/lib/pi/permission-bridge.ts` from the existing packet commit and rewired `owned.ts` to it so `owned.ts` stays below the 800-line ceiling; no behavior deviation.
- Port-identity phase B (#1520): `scripts/dev.mjs` did not exist, so it was added and the
  package dev scripts rewired to call it.
- Port-identity phase B: `src-tauri/tauri.conf.json` left unchanged (outside the packet-owned
  file list); `cargo tauri dev` may need a follow-up devUrl update for the 47120 DEV block.
- Port-identity phase B: broad `sidecar_lifecycle::reap_o8_orphans()` untouched; the production
  port allocation path in `lib.rs` is identity-gated.

## Runtime expansion P1 notes

- Added Cursor CLI (`cursor`) and Grok Build (`grok`) adapters using the shared owned-session store and dispatch registry.
- Local CLI smoke skipped because `cursor-agent`, `grok`, and `grok-build` were not installed on this machine.
- Reused existing Cursor and Grok adapter scaffolding already present in this worktree; the conservative work was to close stale enum/docs surfaces instead of duplicating adapter files.

## Runtime expansion P3 notes (Pi)

- Pi adapter built from a stale pre-P1 worktree base (queued mission cut at create-time); orchestrator rebased onto current main and re-applied registry wiring against the 7-runtime state.
- Pi worker deviation (verbatim): packet scope reported only CLAUDE.md/docs/claude-code.ts as allowed paths; task required Pi runtime files — worker followed the task.
- No `pi` entry in /api/setup/detect tool detectors yet (only the hasCliAgent id list) — follow-up pebble.

## Setup-detect all CLIs notes

- Confirmed `src/lib/runtimes/shared/cli-locate.ts` needs no branching for cursor/grok/pi; the existing loop scans by binary name and returns null cleanly when a binary is absent.

## Symon escalation report-back

- Added an additive, authenticated Rust-to-ws-server bridge for terminal background Claude task completion. The existing task ledger, dock event, TTS, and notification paths remain in place.
- Mobile lane: handle `symon-task-complete` exactly as documented in `docs/symon-agent-mode.md` by forwarding it to the live WebRTC conversation as an assistant-visible item.
- Thread-restore pagination: used a short timeout chain for idle backfill because it is reliable in the Tauri webview where `requestIdleCallback` is not guaranteed.

- Lifecycle reconcile split: payload-reading consumers stay on the per-event channels (now carrying detail); only payload-blind bulk refetchers moved to the coalesced o8:lifecycle-reconcile signal.

- DesktopStatusBar composer centering: replaced the body-wide MutationObserver with explicit ComposerArea registration; remounts notify the status bar without transcript-stream layout work.

- Workspace restore reconciliation: persisted tabs now paint optimistically and retain the existing liveness/archive/lane filters as a generation-fenced background reconciliation.
- Repo-switch performance: AgentPanel now restores per-repo agent snapshots before reconciling; its unrendered commits/issues/PR reads were removed, while mounted activity surfaces retain their own fresh fetches.

## Governance approval posture (#1549)

- Persist `requireApproval` through the existing operator-defaults store and expose it through `o8_operator_defaults`.
- Carry the resolved mode into the existing lane policy context so `always` falls through to the current `lane-merge` approval rule.
- Keep `auto-review.ts` unchanged because standard and second-pass merge attempts already reach the same command policy gate.

## Deviations

- The packet path inventory omitted the operator-defaults store, API route, and test paths; the real persisted resolution seam required those files, so the implementation includes them instead of faking policy-only wiring.
- Extracted the existing Targeting Machine tier helpers into `src/lib/operator/targeting-tier.ts` because the first rule-check rejected any growth in the already-over-ceiling `defaults.ts`; public exports and behavior remain unchanged.

## Declarative CLI runtime adapter notes

- Added a declarative owned-session registry that renders CLI argument templates and normalizes JSONL or line-pattern logs into the existing `OwnedRuntimeAdapter` contract.
- Registered OpenCode through the declarative path while preserving its existing universal runtime adapter and public owned-session wrappers.
- Routed Pi as its own runtime/provider through the real mission path and exposed OpenCode and Pi in the MCP `create_mission` schema.
- Kept Pi's bidirectional RPC and permission bridge on its existing specialized implementation.

## Deviations

- The branch already used `dispatchable_runtimes` enforcement rather than `codex_only_production`; it was left unchanged because enforcement changes are explicitly outside this packet.

## Declarative worker expansion notes

- Added OpenHands, Goose, Qwen Code, Kimi Code, and Aider as configuration-only entries over one shared `AgentRuntime` bridge.
- Kept all five adapters one-shot because the verified launch contracts do not expose a stable thread id in the selected output modes; their owned stores still support launch, discovery, transcript, interrupt, review, and coarse telemetry.
- Kimi uses official `kimi -p` mode because that mode is already automatic and rejects `--auto` or `--yolo` when combined with `--prompt`.

## Deviations

- The existing declarative owned-session registration did not create the universal `AgentRuntime` required by mission dispatch, so one shared bridge was added rather than five hand-written adapters.

## LaunchAgent crash-loop alerting (#1538)

## Plan

- Trace the existing launch-agent health detector into the supervisor inbox and Incident Queue. Complete.
- Confirm the installed LaunchAgent reaches the dependency-light counter before shared/native module loading. Complete.
- Verify per-service crash counting, healthy-uptime reset, Incident Queue persistence, and real source boot. Complete.
- Run the mandatory TypeScript check and self-review before committing. Complete.

## Findings

- Local `main` and this packet both start at `9c8e451b`, `fix(supervisor): surface LaunchAgent crash-loops per service to the Incident Queue (#1538)`. The requested production implementation was already present when this packet began.
- The installed `com.rainwater.mcp-o8` plist launches Node directly under launchd, and `operator-mcp-server.ts` imports `operator-node22-reexec.ts` first. That seam records launchd starts before native/shared imports and preserves the launchd label across the Node 22 re-exec.
- The WebSocket bootstrap polls all persisted per-label counters once per minute and enqueues `launch_agent_crash_loop` incidents after three consecutive failed starts within one hour.

## Verification

- `npx vitest run src/lib/mcp/launch-agent-crash-counter.test.ts src/lib/supervisor/launch-agent-health.test.ts tests/mcp-source-boot.test.ts` — 3 files, 10 tests passed.
- `npx tsc --noEmit` — passed.
- Browser/UI smoke intentionally not run per packet sandbox guidance.

## Deviations

- No production source was changed because the exact #1538 fix was already the shared `main`/packet HEAD; adding a second implementation would create redundant behavior. This file records the audit and verification instead.

## Owned-session store decomposition (#1458)

### Approach

- Applied the preserved `5045d89a` extraction, then reconciled current-main behavior into the focused run-controller, review-tail, fleet, lifecycle, session-io, and store orchestration modules.
- Kept detached child-exit observation, completion persistence, and adapter-provided launch stdin payloads in `run-controller.ts`.
- Preserved current-main run-log caching, sandbox fail-closed behavior, Node PATH repair, cold resume, archived telemetry, session-state lookup, and guarded orphan cleanup.

### Verification

- `npx tsc --noEmit` passed.
- Focused owned-session and dispatch-spawn coverage passed: 7 files, 16 tests.
- Full `npm test` passed: 378 files and 2,421 tests passed; 1 file and 1 test skipped.
- Scoped ESLint passed for all six changed TypeScript files.
- `npm run rule-check -- --base=main` passed with zero violations.

### Deviations

- None.

## Product telemetry test isolation follow-up (#1601)

### Approach

- Snapshot and restore each telemetry test's `HOME`, `CORTEX_IDE_DATA_DIR`, `O8_DATA_DIR`, and `O8_PROXY_URL` values, reset persisted product telemetry to off after each test, and remove temporary roots in teardown hooks.
- Read the route-written operator defaults from a fresh, timeout-bounded Node process so restart persistence is exercised through a new module instance.
- Keep production telemetry behavior unchanged; this follow-up only hardens test lifecycle and acceptance coverage.

### Verification

- `npx tsc --noEmit` passed after one test-spy typing fix.
- Seven focused telemetry files passed: 7 files and 19 tests.
- Scoped ESLint passed for all three changed TypeScript test files.
- `npm run rule-check -- --base=main` passed with zero violations; all changed TypeScript files are tests, so the rule checker intentionally scanned 0 production files.
- `git diff --check` passed.

### Deviations

- None.

### Operator feedback closure

- `resetProductTelemetry` now asserts that the route reset returns HTTP 200, so teardown fails visibly instead of silently leaving telemetry consent enabled.
- `npx tsc --noEmit` passed.
- The seven focused telemetry files passed: 7 files and 19 tests.
- Scoped ESLint passed for `tests/product-telemetry-toggle.test.ts`.
- `npm run rule-check -- --base=main` passed with zero violations; the test-only TypeScript patch intentionally produced 0 scanned production files.
- `git diff --check` passed.
