# Windows Port Structural Audit

Audit target: o8 main repo in this packet worktree. Scope is greenfield Windows structural risk beyond the inception baseline in `docs/remote-and-cross-platform.md` and `docs/desktop-app-strategy.md`.

## Executive Top 10 Greenfield Findings

1. **Tauri ships one macOS-shaped window definition to all OSes** — STRUCTURAL — `src-tauri/tauri.conf.json:13`, `src-tauri/tauri.conf.json:23`, `src-tauri/tauri.conf.json:25`, `src-tauri/tauri.conf.json:30`
2. **`o8://` auth is handled at runtime but not registered for Windows packaging** — BLOCKER — `src-tauri/src/lib.rs:5600`, `src-tauri/src/lib.rs:5604`, `src-tauri/tauri.conf.json:68`
3. **Tracked sidecar shutdown uses a Unix `kill` binary from un-cfg'd code** — BLOCKER — `src-tauri/src/sidecar_lifecycle.rs:25`, `src-tauri/src/sidecar_lifecycle.rs:40`, `src-tauri/src/lib.rs:1772`
4. **Updater metadata publishes only Darwin artifacts, so Windows clients have no update channel** — BLOCKER — `scripts/release.mjs:48`, `scripts/release.mjs:109`, `scripts/release.mjs:139`
5. **Rollback/update UX assumes a mutable `/Applications/o8.app` bundle, not locked Windows installers** — STRUCTURAL — `scripts/rollback-release.mjs:15`, `scripts/rollback-release.mjs:43`, `scripts/rollback-release.mjs:151`, `src-tauri/src/lib.rs:1772`
6. **Node 22/better-sqlite3 ABI pin has only Unix/macOS discovery while Node bundling is disabled** — BLOCKER — `src-tauri/src/lib.rs:1222`, `src-tauri/src/lib.rs:1236`, `scripts/bundle-node.mjs:23`, `src/lib/mcp/operator-node22-locator.ts:63`
7. **Bundled `o8` CLI is a POSIX shell wrapper with symlink semantics and no Windows shim** — STRUCTURAL — `scripts/tauri-export.mjs:581`, `scripts/tauri-export.mjs:588`, `scripts/tauri-export.mjs:598`, `scripts/tauri-export.mjs:606`
8. **Windows WebView2 origin is not in the local trust/CORS allowlists** — BLOCKER — `src/middleware.ts:150`, `src/middleware.ts:154`, `src/ws-server.ts:4558`, `src/ws-server.ts:4561`
9. **Worktree cleanup lacks a Windows file-lock retry/quarantine path** — STRUCTURAL — `src/lib/worktree/manager.ts:1245`, `src/lib/worktree/manager.ts:1258`, `src/lib/lane/worktree-clone-removal.ts:72`, `src/lib/lane/worktree-clone-removal.ts:82`
10. **Repo/worktree scope parsing uses literal `/` separators in UI/API ownership logic** — ADJUSTMENT — `src/app/api/panel/workspaces/route.ts:112`, `src/app/api/panel/repos/route.ts:54`, `src/app/api/panel/branches/route.ts:165`, `src/app/api/panel/branches/route.ts:342`

## Tauri Shell And OS Integration

### One window config is macOS-shaped across all targets

- Evidence: `src-tauri/tauri.conf.json:13` enables private macOS APIs globally; `src-tauri/tauri.conf.json:23` uses `titleBarStyle: "Overlay"`; `src-tauri/tauri.conf.json:25` sets `trafficLightPosition`; `src-tauri/tauri.conf.json:30` sets `transparent: true`.
- Why Windows breaks: Windows does not have macOS traffic lights, and transparent overlay windows on WebView2 need a different chrome and hit-test strategy. A single config risks invisible drag zones, bad system buttons, and unsupported private-API settings in the Windows bundle.
- Linux impact: Partial. Linux also needs a non-vibrancy, non-traffic-light chrome path, though WebView2-specific behavior is Windows-only.
- Known vs greenfield: Greenfield. The baseline mentions vibrancy fallback, not titlebar/traffic-light/window config shape.
- Direction: Split per-OS window config or build the window programmatically with Windows-specific decorations, transparency, and drag regions.

### Windows deep-link registration is not wired

- Evidence: the Rust runtime handles deep links in `RunEvent::Opened` (`src-tauri/src/lib.rs:5600`, `src-tauri/src/lib.rs:5604`), while `src-tauri/tauri.conf.json:68` only configures the updater plugin and has no protocol/deep-link bundle declaration.
- Why Windows breaks: Handling an opened URL is not enough. Windows must register the `o8://` protocol through installer/registry integration. Without that, Clerk desktop sign-in cannot return to the app.
- Linux impact: Yes, Linux also needs `.desktop`/MIME/protocol registration.
- Known vs greenfield: Greenfield. The baseline mentions Keychain/DPAPI and signing, not auth protocol registration.
- Direction: Add a Tauri v2 deep-link/protocol registration plan per installer target and test cold-start plus already-running handoff.

### Single-instance/deep-link handoff has no visible Windows policy

- Evidence: `RunEvent::Opened` buffers auth links when no window exists (`src-tauri/src/lib.rs:5617`, `src-tauri/src/lib.rs:5622`), but the dependency/plugin scan shows no single-instance or deep-link plugin registration in `src-tauri/Cargo.toml:34` through `src-tauri/Cargo.toml:44`.
- Why Windows breaks: On Windows, protocol activations often launch a new process unless the app enforces a single-instance handoff. The current buffer only helps inside the process that receives `RunEvent::Opened`.
- Linux impact: Yes, similar issue for desktop-file protocol launches.
- Known vs greenfield: Greenfield.
- Direction: Choose a single-instance mechanism and verify protocol callback delivery to the existing main process on Windows.

## Sidecar And Process Lifecycle

### Sidecar shutdown calls Unix `kill` from un-cfg'd code

- Evidence: `kill_tracked_children()` is always compiled (`src-tauri/src/sidecar_lifecycle.rs:25`) and shells out to `kill -TERM` and `kill -KILL` (`src-tauri/src/sidecar_lifecycle.rs:40`, `src-tauri/src/sidecar_lifecycle.rs:55`). `restart_app()` depends on it before relaunch (`src-tauri/src/lib.rs:1772`, `src-tauri/src/lib.rs:1774`).
- Why Windows breaks: Windows has no `kill` command or POSIX signals. Restart/update will leave Next/ws-server children alive or fail cleanup before relaunch. Killing only the direct PID is also insufficient for child trees.
- Linux impact: No, the command exists on normal Linux installs.
- Known vs greenfield: Greenfield extension of the known "no Unix process model" bucket. The baseline calls out no `setsid`/Unix signals generally; this specific un-cfg'd Rust cleanup path is not in the inception docs.
- Direction: Introduce a sidecar process-supervision abstraction: Unix signals on Unix, Windows Job Objects or `taskkill /T` fallback on Windows, with confirmed port release.

### Dev-server API uses `sh -c`, detached POSIX groups, and negative PID kill

- Evidence: `spawn('sh', ['-c', command])` starts dev servers (`src/app/api/panel/dev-server/route.ts:68`), `detached: true` is set (`src/app/api/panel/dev-server/route.ts:71`), and stop uses `process.kill(-server.process.pid, 'SIGTERM')` (`src/app/api/panel/dev-server/route.ts:149`, `src/app/api/panel/dev-server/route.ts:152`).
- Why Windows breaks: There is no `/bin/sh`, negative PIDs are not process groups, and `SIGTERM` semantics differ. Dev servers become unstartable or unkillable from the app.
- Linux impact: No.
- Known vs greenfield: Greenfield for this operator-facing dev server route.
- Direction: Spawn via a platform shell adapter (`cmd.exe`/PowerShell or direct package-manager command parsing) and own the process tree with a Windows job.

### Crash-survivable worker interrupts assume Unix process groups even on Windows

- Evidence: Windows detached spawn exists (`src/lib/runtimes/shared/owned-session/store.ts:684`, `src/lib/runtimes/shared/owned-session/store.ts:687`), but interrupts still use `process.kill(-session.activeRun.pid, 'SIGINT')` (`src/lib/runtimes/shared/owned-session/store.ts:845`, `src/lib/runtimes/shared/owned-session/store.ts:851`) and shared escalation does the same (`src/lib/runtime/interrupt-escalation.ts:51`, `src/lib/runtime/interrupt-escalation.ts:58`).
- Why Windows breaks: The code has a Windows spawn branch but no matching Windows interrupt branch. Active Codex/Claude runs may survive stop/reset, leaving worktrees locked.
- Linux impact: No.
- Known vs greenfield: Greenfield because it identifies the post-spawn interrupt path, not just initial ConPTY/tmux absence.
- Direction: Store a platform process-tree handle per run and route interrupt/escalation through a Windows implementation.

## Release, Ship, And Update Pipeline

### Release manifest only publishes Darwin platforms

- Evidence: release artifacts are hardcoded to `dmg` and `macos/o8.app.tar.gz` (`scripts/release.mjs:48`, `scripts/release.mjs:50`), and `latest.json` contains only `darwin-x86_64` and `darwin-aarch64` (`scripts/release.mjs:109`, `scripts/release.mjs:114`).
- Why Windows breaks: Tauri updater on Windows looks for a Windows platform key and a Windows installer/update artifact. A Windows build would never see an available update.
- Linux impact: Yes, Linux platform keys are also absent.
- Known vs greenfield: Greenfield. The baseline says per-OS signing/CI, not that the current manifest excludes all non-Darwin platforms.
- Direction: Generate platform-specific `latest.json` entries and upload NSIS/MSI artifacts alongside Darwin artifacts.

### Silent rollback assumes swapping `/Applications/o8.app`

- Evidence: rollback docs say it extracts and swaps `/Applications/o8.app` (`scripts/rollback-release.mjs:15`), defaults `APP_PATH` to `/Applications/o8.app` (`scripts/rollback-release.mjs:43`), renames the current app bundle (`scripts/rollback-release.mjs:151`, `scripts/rollback-release.mjs:155`), then copies with `ditto` (`scripts/rollback-release.mjs:162`, `scripts/rollback-release.mjs:164`).
- Why Windows breaks: Windows cannot overwrite a running `.exe`/installed app tree the same way, and installer-based rollback may need elevation/UAC and app exit choreography.
- Linux impact: Partial, depending on install location and package format.
- Known vs greenfield: Greenfield. The baseline mentions signing/CI, not update rollback semantics.
- Direction: Define Windows update/rollback as installer-managed: app exits, installer/updater runs out-of-process, restart happens after file handles close.

### Post-build signing/notarization script is the ship path, not just a Mac add-on

- Evidence: `sign-and-notarize` expects Apple env in `~/.zshenv` (`scripts/sign-and-notarize.mjs:25`, `scripts/sign-and-notarize.mjs:29`), scans Mach-O binaries with `file` (`scripts/sign-and-notarize.mjs:93`, `scripts/sign-and-notarize.mjs:104`), runs `codesign` (`scripts/sign-and-notarize.mjs:113`, `scripts/sign-and-notarize.mjs:153`), repackages `.app.tar.gz` (`scripts/sign-and-notarize.mjs:183`, `scripts/sign-and-notarize.mjs:192`), and builds a DMG with `/Applications` symlink (`scripts/sign-and-notarize.mjs:211`, `scripts/sign-and-notarize.mjs:216`).
- Why Windows breaks: The "ship" path is not parameterized by target OS. A Windows release cannot pass through this script, and native modules need a different signing and artifact pass.
- Linux impact: Yes.
- Known vs greenfield: Known-adjacent. The baseline mentions Authenticode/per-OS CI; this is concrete evidence of where the Mac-only path is embedded.
- Direction: Split release into target-specific artifact builders and a common manifest/upload step.

## Node Runtime And Native Modules

### Node 22 discovery is Unix/macOS-only while Node bundling is disabled

- Evidence: required major is pinned at `src-tauri/src/lib.rs:1222`; discovery scans `.nvm`, `.fnm`, `.volta`, Homebrew paths (`src-tauri/src/lib.rs:1236` through `src-tauri/src/lib.rs:1242`); `scripts/bundle-node.mjs` exits immediately with "Node.js bundling disabled" (`scripts/bundle-node.mjs:23`, `scripts/bundle-node.mjs:28`).
- Why Windows breaks: Windows users may have Node from winget, MSI, Chocolatey, Scoop, or nvm-windows. None are scanned. Since better-sqlite3 ABI is pinned to Node 22, "any node on PATH" is not enough.
- Linux impact: Partial. Linux has nvm/fnm/volta paths but no distro package scan.
- Known vs greenfield: Greenfield. The baseline mentions login-shell PATH; this is the native ABI and distribution decision.
- Direction: Either bundle Node per platform or implement Windows Node 22 detection/repair with explicit ABI validation.

### MCP Node 22 re-exec has the same Unix path model

- Evidence: candidate paths are generated under `.nvm`, `.fnm`, `.volta`, `/opt/homebrew`, and `/usr/local` (`src/lib/mcp/operator-node22-locator.ts:63`, `src/lib/mcp/operator-node22-locator.ts:86`), and the fallback warning tells users to `brew install node@22` or `nvm install 22` (`src/lib/mcp/operator-node22-locator.ts:126`, `src/lib/mcp/operator-node22-locator.ts:128`).
- Why Windows breaks: Even if the Tauri sidecar is fixed, packaged MCP servers can still run under the wrong Node and crash on `better-sqlite3`.
- Linux impact: Partial.
- Known vs greenfield: Greenfield.
- Direction: Share one cross-platform Node resolver across Tauri, MCP, and CLI entrypoints.

### Bundled CLI wrapper is POSIX-only

- Evidence: `tauri-export` writes `out/server/bin/o8` as `#!/bin/sh` (`scripts/tauri-export.mjs:581`), follows symlinks with `readlink` (`scripts/tauri-export.mjs:588`), probes `zsh`/`bash`/`sh` (`scripts/tauri-export.mjs:598`), and makes it executable with `chmod` (`scripts/tauri-export.mjs:606`).
- Why Windows breaks: The packaged CLI has no `.cmd`/PowerShell shim, no `%PATH%`/PATHEXT behavior, and no Windows symlink strategy. Worker callbacks that rely on `o8` on PATH will fail.
- Linux impact: No, except shells may vary.
- Known vs greenfield: Greenfield.
- Direction: Emit `o8.cmd` and/or `o8.ps1`, register it in an app-local bin directory, and avoid symlink-dependent resolution.

## WebView2, Origins, And Local Networking

### Local auth/CORS trusts `tauri://localhost` but not Windows WebView2 origins

- Evidence: middleware explicitly trusts `origin === 'tauri://localhost'` (`src/middleware.ts:150`, `src/middleware.ts:154`); ws-server CORS allowlist includes `tauri://localhost` only (`src/ws-server.ts:4558`, `src/ws-server.ts:4561`).
- Why Windows breaks: Windows WebView2/Tauri can use `http://tauri.localhost`-style origins. Those requests can fail the loopback gate or CORS preflight even though they are local app requests.
- Linux impact: Yes, depending on WebKitGTK origin.
- Known vs greenfield: Greenfield. The baseline only says the middleware accepts loopback/token and remote SSH can preserve loopback.
- Direction: Normalize trusted desktop origins by actual socket peer plus a small platform-origin allowlist; add tests for `http://tauri.localhost`.

### WebSocket URL builder treats only `localhost` and `127.0.0.1` as local

- Evidence: desktop WS code checks `hostname === 'localhost' || hostname === '127.0.0.1'` (`src/components/desktop/hooks/useDesktopWebSocket.ts:56`, `src/components/desktop/hooks/useDesktopWebSocket.ts:60`) and otherwise connects to the current host/port (`src/components/desktop/hooks/useDesktopWebSocket.ts:66`, `src/components/desktop/hooks/useDesktopWebSocket.ts:67`).
- Why Windows breaks: If the WebView2 app origin is `tauri.localhost`, the code may not switch to the sidecar WS port returned by `getBrowserWsPort()`.
- Linux impact: Yes for non-`localhost` app origins.
- Known vs greenfield: Greenfield.
- Direction: Treat `.localhost` app origins as local, or always use the injected sidecar port for Tauri desktop.

## Worktree, Git, And Filesystem

### Worktree deletion has no Windows lock retry/quarantine

- Evidence: cleanup calls `git worktree remove` with a 15s timeout (`src/lib/worktree/manager.ts:1245`, `src/lib/worktree/manager.ts:1246`) then falls back to `rm(..., { recursive: true, force: true })` once (`src/lib/worktree/manager.ts:1258`, `src/lib/worktree/manager.ts:1259`). Clone-removal fallback similarly tries `git worktree remove --force` then `rmSync` once (`src/lib/lane/worktree-clone-removal.ts:72`, `src/lib/lane/worktree-clone-removal.ts:83`).
- Why Windows breaks: Windows refuses deletion while any process, shell, editor, node watcher, Git process, or Defender scan holds a handle. A single fallback can leave half-removed trees and stale metadata.
- Linux impact: Less severe; open files can be unlinked.
- Known vs greenfield: Greenfield. The baseline mentions merge-by-local-path, not Windows file-lock lifecycle.
- Direction: Add Windows cleanup states: terminate owning job, retry with backoff, rename-to-quarantine, defer deletion, and keep lane metadata until confirmed.

### Path ownership and worktree classification use literal forward slashes

- Evidence: `normalizeScopePath` strips `~` only before `/` and trailing `/` (`src/app/api/panel/repos/route.ts:51`, `src/app/api/panel/repos/route.ts:54`); repo/worktree derivation checks `/.cortex-worktrees/` and splits on `/` (`src/app/api/panel/workspaces/route.ts:112`, `src/app/api/panel/workspaces/route.ts:114`); Claude worktree hiding checks `/.claude/worktrees/agent-` (`src/app/api/panel/branches/route.ts:165`); branch worktree creation concatenates with `/../.worktrees/` (`src/app/api/panel/branches/route.ts:342`).
- Why Windows breaks: Backslash paths, drive letters, and UNC paths will not match these sentinels, so repo ownership and ghost-worktree filtering become wrong.
- Linux impact: No.
- Known vs greenfield: Greenfield.
- Direction: Normalize with `path.resolve`, `path.relative`, and separator-insensitive marker helpers before comparing.

### Worktree-created Claude hooks assume `node` command, not resolved Node 22

- Evidence: injected hook commands are `node "<path>"` (`src/lib/worktree/manager.ts:1078`, `src/lib/worktree/manager.ts:1089`, `src/lib/worktree/manager.ts:1097`).
- Why Windows breaks: Even with `O8_NODE_BIN`, hook execution depends on the agent shell resolving `node`. On Windows this can hit the wrong Node or no Node, and quoted command behavior differs by shell.
- Linux impact: Partial if Node 22 is not on PATH.
- Known vs greenfield: Greenfield.
- Direction: Write hooks with the resolved `O8_NODE_BIN` path or a platform shim.

### File watching uses recursive Git refs watch

- Evidence: ws-server watches refs with `watch(refsDir, { recursive: true })` (`src/ws-server.ts:5668`, `src/ws-server.ts:5674`), while doc watcher intentionally avoids recursive directory watching by using one handle per file (`src/lib/cortex/indexer/doc-watcher.ts:523`, `src/lib/cortex/indexer/doc-watcher.ts:529`).
- Why Windows breaks: Recursive `fs.watch` semantics differ by platform and can miss or duplicate events on Windows, especially under `.git/refs` churn.
- Linux impact: Yes; recursive watch is not uniformly supported.
- Known vs greenfield: Greenfield.
- Direction: Reuse a file/per-directory watcher strategy or poll Git state on Windows.

## Shell-Outs And Native UI Routes

### Folder/file pickers are implemented as server-side AppleScript

- Evidence: browse-folder documents macOS Finder via `osascript` (`src/app/api/panel/browse-folder/route.ts:7`, `src/app/api/panel/browse-folder/route.ts:21`); file picker does the same (`src/app/api/panel/file-io/route.ts:133`, `src/app/api/panel/file-io/route.ts:150`).
- Why Windows breaks: Windows has no `osascript`. These routes return null and make folder/file selection unusable.
- Linux impact: Yes.
- Known vs greenfield: Greenfield.
- Direction: Use Tauri dialog plugin from the desktop surface, with web fallback only for browser mode.

### "Open in Finder/Terminal/Xcode" is hardcoded to macOS commands

- Evidence: editor map uses `open`, `open -a Terminal`, and `open -a Xcode` (`src/app/api/panel/open-in/route.ts:13` through `src/app/api/panel/open-in/route.ts:20`), and availability is checked with `which` (`src/app/api/panel/open-in/route.ts:45`, `src/app/api/panel/open-in/route.ts:47`).
- Why Windows breaks: Windows needs Explorer, Windows Terminal/cmd/PowerShell, `where.exe`, and app execution semantics through ShellExecute.
- Linux impact: Yes, needs `xdg-open`.
- Known vs greenfield: Greenfield.
- Direction: Platform-map open targets and expose only those available on the current OS.

### Diff stats shell out through `sh -c`

- Evidence: `broadcastDiffStats()` runs `execFile('sh', ['-c', 'git diff ...; git diff ...'])` (`src/ws-server.ts:5529`, `src/ws-server.ts:5532`).
- Why Windows breaks: No `sh` by default. Review diff stats silently stop.
- Linux impact: No.
- Known vs greenfield: Greenfield, small.
- Direction: Run the two `git diff --shortstat` commands separately with `execFile('git', args)`.

## What The Inception Docs Already Cover

Filtered known baseline items from `docs/remote-and-cross-platform.md`:

- No tmux/ConPTY persistence rewrite: known. I did not count terminal persistence itself as greenfield.
- No Unix sockets/`setsid`: known. I only counted concrete un-cfg'd sidecar and worker cleanup paths where Windows behavior is currently mismatched.
- No `lsof`/`pgrep`/`ps` parsing: known. I used those sites as supporting evidence only, not top-level credit.
- Login-shell PATH model: known. I separated the Node 22/native ABI distribution question because it is broader than PATH.
- DPAPI vs Keychain: known. I did not count master-key storage as greenfield.
- Authenticode signing/per-OS CI: known. I counted missing Windows update artifacts and rollback semantics because they are separate product/update flow breaks.
- Mac voice/Symon stack: known. I did not count Fn hotkey, paste, STT, AX, voice, or dock-only Symon issues.
- Vibrancy to solid fallback: known. I counted titlebar/traffic-light/transparent window config because it is separate from visual vibrancy.
- Merge-via-local-path-fetch: known. I did not count `worktree-side-merge.ts` local path fetch as greenfield.

## Verification

- Static audit only. No UI server or browser smoke was run.
- No existing files were modified.
