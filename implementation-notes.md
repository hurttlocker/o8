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
