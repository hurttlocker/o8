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

# Implementation Notes — #1538 LaunchAgent crash loops

## Plan

- Trace every launchd registration that wraps an o8-owned process.
- Reuse the existing supervisor incident persistence and Incident Queue presentation path.
- Add a bounded rolling-window failure detector, real-entry-point coverage, and focused verification.

## Decisions

- Reused the supervisor inbox's existing `launch_agent_crash_loop` kind and label-based incident deduplication.
- Discover counter files instead of hardcoding one service, with the launchd-provided `XPC_SERVICE_NAME` as the label.
- Reset a service's sequence after five minutes of continuous uptime so the alert measures consecutive respawns rather than unrelated restarts in one hour.

## Verification

- `npx vitest run src/lib/mcp/launch-agent-crash-counter.test.ts src/lib/supervisor/launch-agent-health.test.ts src/lib/inbox/card-copy.test.ts`
- `npx vitest run tests/mcp-source-boot.test.ts`
- `npx tsc --noEmit`
- `npm run rule-check -- --base=main`
- Changed-file ESLint completed with one unrelated existing warning in `src/ws-server.ts` at line 2611.

## Deviations

- The packet base already contained a service-specific #1538 implementation from `ad3a85e5`, so this patch closes its generic-service and consecutive-respawn gaps instead of duplicating the existing Incident Queue path.
