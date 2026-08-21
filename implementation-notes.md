# Implementation notes

## Plan

Shell-neutral npm scripts (#1744) — inventory of all 60 scripts, then convert only what
converts without risk.

- `scripts/run-lib.mjs` — shared plumbing. `resolveSpawn()` maps `next`/`tsx` to the JS
  entry their `node_modules/.bin` symlink points at and runs it under `process.execPath`
  (on Windows `.bin` holds a `.cmd` shim that Node >= 20.12 refuses to exec without a
  shell); anything else keeps PATH resolution with `shell` on win32 only, the pattern
  `scripts/postinstall.mjs` and `scripts/smoke.mjs` already use. `parseEnvPrefixArgv()`
  splits `KEY=VALUE … -- cmd args` on the FIRST `=` so `NODE_OPTIONS=--import=…` survives.
- `scripts/build.mjs` replaces the `sh -c` build one-liner; `scripts/start.mjs` replaces
  `sh -c 'next start -p "${PORT:-3001}"'`; `scripts/run.mjs` is the generic `VAR=value`
  prefix runner (11 call sites); `scripts/kill-port.mjs` replaces the
  `lsof | xargs kill -9` side-stack cleanup with `lsof` on POSIX and
  `netstat -ano` + `taskkill /PID <pid> /T /F` on Windows (same call the #1739 sidecar
  reaper uses). Both `kill-port` parsers are pure and unit-tested.
- `scripts/dev.mjs` — the one behavioral fix outside package.json: `run()` spawned bare
  `next`/`tsx`, which is ENOENT on Windows. Routed through `resolveSpawn()` so the PID it
  registers for cleanup stays the real child rather than a wrapper `cmd.exe`.
- `tests/script-shell-neutral.test.ts` + two `.d.mts` declaration files (repo-wide
  `allowJs: false`, so a `.ts` test cannot import a `.mjs` untyped).
- `README.md` Quickstart: one sentence stating no Git Bash is needed. `port-audit-windows.md`:
  Status line on the "Dev and diagnostic scripts are POSIX-shell-only" finding.

## Deviations

- **TW-10 APFS default plumbing lives in a focused operator module.** `defaults.ts` already
  exceeds the standard file ceiling, so the changed-line rule rejects any growth there.
- **`ship`, `tauri:build:signed`, `tauri:build:nonotary` left as `sh -c` verbatim.** They
  read the minisign key with `$(cat ~/.tauri/cortex-ide.key)` and `unset APPLE_ID …`,
  and the whole chain (`cargo tauri build` + `sign-and-notarize`) is macOS-only. Converting
  them would touch the release path for zero Windows benefit. `ship` and `tauri:prebuild`
  are plain `&&` chains, which cmd.exe supports, so no change was needed there either.
- **`measure:render|cli|socket|mcp` left as `bash scripts/*.sh`.** Neutralizing them means
  rewriting four shell diagnostics, not the npm scripts; out of scope and documented instead.
- **`.github/workflows/` untouched** per the packet. Port Build keeps
  `npm config set script-shell bash` until a real Windows run proves this conversion.

## Notes for the operator

- **How I convinced myself `build` is byte-equivalent on macOS.** The old command did four
  things: run `bust-stale-patch-cache.mjs` and abort on non-zero; delete four env vars
  (`env -u`); set `NODE_ENV`/`NODE_OPTIONS`; exec `next build --webpack`. `build.mjs` does the
  same four in the same order with `spawnSync(…, {stdio:'inherit'})`, propagating the child's
  status. The only substitution is `node <require.resolve('next/dist/bin/next')>` instead of
  the PATH lookup for `next` — and `node_modules/.bin/next` is a symlink to exactly that file
  with an `#!/usr/bin/env node` shebang, so under `npm run` (which puts the same node on PATH)
  it is the same program under the same interpreter. Verified by a full green `npm run build`.
- `${PORT:-3001}` falls back on unset **and** empty, which is what `process.env.PORT || '3001'`
  does — not `??`.
- `kill-port` matches listeners by foreign address (`0.0.0.0:0` / `[::]:0`) rather than the
  `LISTENING` state word, which is localized on non-English Windows.

## Packet #1796

### Deviations

None.

### Edge-case review

- The codename loop, principal null sentinels, archive summary ordering, lane command error handlers, dogfood guard, and worktree reconciliation do not read mission model or carrier fields. They remain outside this patch.
