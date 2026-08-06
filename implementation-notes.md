# Implementation notes

## Plan

- `src-tauri/src/sidecar_lifecycle.rs`: cfg-branch `kill_tracked_children()`. Moved the existing Unix TERM→wait→KILL escalation verbatim into `kill_tracked_children_unix()` (`#[cfg(unix)]`, unchanged behavior). Added `kill_tracked_children_windows()` (`#[cfg(windows)]`) that force-kills each tracked PID's process tree via `taskkill /PID <pid> /T /F` — the simpler of the two directions in the issue (vs. a Job Objects rewrite), since Windows has no SIGTERM to escalate from anyway. Extracted the taskkill argv into a pure `taskkill_tree_args()` helper (not itself cfg-gated) plus a `#[cfg(test)]` unit test, so the Windows branch has coverage that runs on macOS/CI.
- `docs/internals/port-audit-windows.md`: marked Top-10 finding #3 and the "Update relaunch depends on Unix `kill`" section as fixed, within the file's diff budget.

## Deviations

None — implementation matches the packet's stated direction (taskkill over Job Objects, called out explicitly as the simpler option to pick).

## Notes for the operator

- All other Unix-only helpers in `sidecar_lifecycle.rs` (`lsof`/`pgrep`/`ps`/`process_cwd`/etc.) were already properly `#[cfg(unix)]`-gated behind cross-platform wrappers before this change — `kill_tracked_children()` was the only un-cfg'd Unix-only path in the file, matching audit finding #3 exactly.
- Loop-exit sites flagged at `sidecar_lifecycle.rs:157/170/180/306` are inside the pre-existing `#[cfg(unix)]` orphan-reap functions (unrelated to `kill_tracked_children`) — left untouched, out of scope for this packet.
- Doc cleanup-path sites flagged at `port-audit-windows.md:14/49/51/57` cover two different findings: worktree cleanup Windows lock semantics (#8 in the Top 10) and worker-spawn tree-ownership (Sidecar section, second item) — both are separate greenfield findings, not this issue (#1739's "shells out to Unix kill"). Only the "Update relaunch depends on Unix `kill`" section and Top-10 item 3 were updated.
