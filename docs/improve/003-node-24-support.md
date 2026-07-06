# 003 — Node-24-only machines: app must not be dead on first launch (#1456)

## What & why
GitHub issue #1456 (open): better-sqlite3's native module is ABI-pinned to Node 22. The app locates a runtime via `find_preferred_node_22()` in `src-tauri/src/lib.rs:898` (`PREFERRED_NODE_MAJOR = 22`, line ~894). A user whose machine has **only Node 24** (now the LTS default — increasingly the common case for new installs) gets a dead app on first launch. This is the #1 "app won't open" blocker for new users and part of the beta-gate new-user path.

## Exact change
Read `find_preferred_node_22()` and its call sites in `src-tauri/src/lib.rs` first, then implement a fallback ladder (in order of preference):
1. Keep preferring a discovered Node 22 (nvm/fnm/volta/system paths — the existing logic).
2. If none: fall back to prebuilt better-sqlite3 binaries for the found Node major. Check whether `patches/` or `scripts/postinstall.mjs` already vendor prebuilds; better-sqlite3 publishes prebuilds per ABI — bundling the Node-24 ABI `.node` alongside the Node-22 one and selecting at runtime is likely the smallest root fix.
3. If neither is feasible in-scope: at minimum replace the silent death with a visible, actionable first-launch error dialog ("o8 needs Node 22 — install via …") — a dead app with no message is the unacceptable state. But treat this as the floor, not the fix; #1456 asks for the app to work.

Also add the missing Rust test coverage for the discovery ladder: unit test `find_preferred_node_22`-style discovery against temp dirs mimicking nvm/fnm/volta layouts (test the pure path-selection logic; don't shell out to real node).

## What NOT to touch
- Do not bump the pinned dev Node version or the better-sqlite3 dependency version as a side effect.
- Do not touch the updater/packaging scripts beyond what shipping a second prebuild requires (mind the AppleDouble trap: `COPYFILE_DISABLE=1` stays — `scripts/sign-and-notarize.mjs`).

## Acceptance criteria (reachability-grade)
- On a machine (or PATH-sandboxed shell) where only Node 24 resolves: the built app launches, DB opens, dashboard renders. Simulate by hiding Node 22 installs from the discovery paths and launching the dev harness the same way the app does.
- On a Node-22 machine: behavior unchanged.
- `cargo test` includes the new discovery-ladder tests and passes.

## Verification
```bash
cd src-tauri && cargo test
npm run typecheck && npm test
```
Then live: launch with Node 22 hidden (rename nvm dir / strip PATH in a controlled shell) and verify the app boots and a dispatch round-trips SQLite.

## Failure path
If the prebuild-per-ABI route fights the bundler after 3 attempts: stop, land the visible-error floor (step 3) only, revert the rest, and report what blocked the real fix on #1456.

## Executor tier
Opus (Rust + packaging judgment). Review by `reviewer` agent before done.
