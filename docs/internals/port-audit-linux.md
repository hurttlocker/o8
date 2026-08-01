# Linux Port Structural Audit

Scope: greenfield Linux blockers and structural seams in the current o8 implementation.

## Executive Top 10 Greenfield Findings

1. **BLOCKER — Linux Tauri builds can fail before launch because macOS voice sidecars are bundled unconditionally.** Evidence: `src-tauri/tauri.conf.json:47`, `src-tauri/build.rs:80`, `scripts/build-speech-local.mjs:27`. Blocks: desktop client.
2. **BLOCKER — The ship/updater pipeline publishes only macOS artifacts and Darwin `latest.json` platforms.** Evidence: `scripts/release.mjs:49`, `scripts/release.mjs:105`, `scripts/release.mjs:139`, `src/lib/app-update/client-restart.ts:49`. Blocks: desktop client.
3. **STRUCTURAL — Native Node addons are copied from the build host, so Linux needs a Linux-built server bundle for `better-sqlite3` and `node-pty`.** Evidence: `scripts/tauri-export.mjs:403`, `scripts/tauri-export.mjs:425`, `scripts/tauri-export.mjs:500`, `package.json:105`. Blocks: desktop client and headless node.
4. **BLOCKER — `o8://` auth deep links are macOS-plist/runtime only; Linux has no `.desktop`/MIME scheme registration.** Evidence: `src-tauri/Info.plist:74`, `src-tauri/src/lib.rs:4568`, `src-tauri/src/lib.rs:5624`, `src-tauri/tauri.conf.json:61`. Blocks: desktop client.
5. **STRUCTURAL — Stale-listener cleanup calls a macOS-only kill-and-wait helper; Linux returns `false` on reachable startup paths.** Evidence: `src-tauri/src/lib.rs:809`, `src-tauri/src/lib.rs:5330`, `src-tauri/src/sidecar_lifecycle.rs:445`, `src-tauri/src/sidecar_lifecycle.rs:482`. Blocks: desktop client.
6. **STRUCTURAL — Headless live-session/orphan logic depends on optional `lsof`, `pgrep`, and GNU/BSD `ps` shapes.** Evidence: `src-tauri/src/sidecar_lifecycle.rs:219`, `src-tauri/src/sidecar_lifecycle.rs:319`, `src/lib/runtimes/claude-code.ts:721`, `src/lib/runtimes/shared/codex-process-cwd.ts:37`. Blocks: headless node.
7. **STRUCTURAL — Native Browser Pane / agent-grab is compiled as macOS-only and silently no-ops on Linux.** Evidence: `src-tauri/src/browser_view.rs:60`, `src-tauri/src/browser_view.rs:90`, `src-tauri/src/browser_view.rs:333`, `src-tauri/src/browser_view.rs:353`. Blocks: desktop client.
8. **STRUCTURAL — Repo/file picker API routes shell out to `osascript`, so Linux desktop chooser flows return null.** Evidence: `src/app/api/panel/browse-folder/route.ts:7`, `src/app/api/panel/browse-folder/route.ts:21`, `src/app/api/panel/file-io/route.ts:133`, `src/app/api/panel/file-io/route.ts:150`. Blocks: desktop client.
9. **ADJUSTMENT — Web dictation/realtime voice uses WebKitGTK-sensitive `getUserMedia`, `MediaRecorder`, and browser speech APIs, independent of the known Swift/Symon cut.** Evidence: `src/components/desktop/dictation/useDictation.ts:9`, `src/components/desktop/dictation/useDictation.ts:46`, `src/components/desktop/dictation/useDictation.ts:170`, `src/lib/voice/realtime-client.ts:206`. Blocks: desktop client.
10. **ADJUSTMENT — First-run autostart/background settings use macOS launch semantics while the UI exposes a generic launch-at-login control.** Evidence: `src-tauri/src/lib.rs:4709`, `src-tauri/src/background.rs:13`, `src-tauri/src/background.rs:122`, `src-tauri/src/background.rs:183`. Blocks: desktop client.

## Full Catalog

### Packaging, Build, and Distribution

#### Unconditional macOS sidecars in Linux Tauri bundle

- Severity: BLOCKER
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD. The inception docs say the voice/Symon stack is Mac-only; they do not call out that sidecar packaging can break a Linux build even when voice is out of scope.
- Evidence:
  - `src-tauri/tauri.conf.json:47` declares `externalBin` entries for `helpers/speech_recognizer` and `helpers/speech-local`.
  - `src-tauri/build.rs:80` says the Swift recognizer build is a no-op on non-macOS.
  - `scripts/build-speech-local.mjs:27` exits early on non-Darwin.
  - `src-tauri/src/stt/mod.rs:232` and `src-tauri/src/stt/whisper.rs:133` look for `*-apple-darwin` suffixed sidecars.
- Why it breaks on Linux: Tauri validates declared sidecars during build, but the current generators only create Darwin-named binaries. Linux bundling needs either conditional sidecars or Linux target sidecar names.
- Suggested direction: split voice sidecars behind target-specific bundle config or generate harmless Linux stubs only when the desktop build still declares them. Prefer not declaring these `externalBin` entries for Linux.

#### Mac-only release and updater artifacts

- Severity: BLOCKER
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `scripts/release.mjs:49` expects a DMG path.
  - `scripts/release.mjs:50` and `scripts/release.mjs:51` expect `o8.app.tar.gz` and its signature.
  - `scripts/release.mjs:105` emits only `darwin-x86_64` and `darwin-aarch64` updater platforms.
  - `scripts/release.mjs:139` uploads only the macOS asset set.
  - `src/lib/app-update/client-restart.ts:49` uses the Tauri updater uniformly from the client.
- Why it breaks on Linux: Linux installs will never see a matching updater platform in `latest.json`. `UpdateCard` can keep checking and attempting install semantics that only make sense for the Darwin asset set.
- Suggested direction: decide the Linux distribution floor and package channels first. If AppImage is the only auto-updatable Linux channel, gate the silent/idle update UX by package type and send deb/rpm users to manual download or distro repository instructions.

#### Native Node addon ABI/OS coupling

- Severity: STRUCTURAL
- Blocks: desktop client and headless node
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `scripts/tauri-export.mjs:403` copies the Next standalone `node_modules`.
  - `scripts/tauri-export.mjs:425` explicitly copies `better-sqlite3` and `node-pty`.
  - `scripts/tauri-export.mjs:500` marks native addons external because `.node` addons cannot be bundled.
  - `scripts/release.mjs:32` guards Node ABI but only for the build machine's Node major.
  - `package.json:105` depends on `better-sqlite3`; `package.json:106` depends on `node-pty`.
- Why it breaks on Linux: native addons are OS/libc/arch-specific. A macOS-built `out/server/node_modules` cannot run on Linux, and a Linux headless node cannot consume a Darwin Tauri export.
- Suggested direction: build the headless node artifact on Linux with Node 22 and the intended libc floor. For desktop, produce per-OS server bundles, not one copied native tree.

#### WebKitGTK floor is implicit

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: PARTIALLY KNOWN. WebKitGTK testing is known; the packaging floor is not.
- Evidence:
  - `src-tauri/Cargo.lock:6180` includes `webkit2gtk` through Tauri/Wry.
  - `src-tauri/Cargo.toml:33` pins Tauri `2.10.3`.
  - `src-tauri/tauri.conf.json:45` uses `targets: "all"` without per-distro floor.
- Why it breaks on Linux: Tauri v2 Linux packages depend on system WebKitGTK packages whose names and versions vary by Ubuntu/Debian/Fedora/Arch. No code currently states a floor or package prerequisite.
- Suggested direction: pick Ubuntu 24.04 LTS as the practical floor for desktop testing and publish dependency notes for Debian/Fedora/Arch. Headless node should not depend on WebKitGTK at all.

### Tauri Desktop Shell

#### Deep link registration is macOS-only

- Severity: BLOCKER
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/Info.plist:74` declares the `o8://` URL scheme for macOS.
  - `src-tauri/src/lib.rs:4568` buffers auth deep links.
  - `src-tauri/src/lib.rs:5624` handles `RunEvent::Opened` only under `#[cfg(target_os = "macos")]`.
  - `src-tauri/tauri.conf.json:61` has a `macOS` bundle block but no Linux `.desktop` protocol registration.
- Why it breaks on Linux: Clerk desktop sign-in depends on `o8://auth/callback`, but Linux needs a `x-scheme-handler/o8` entry in the `.desktop` file plus runtime handling outside the macOS `Opened` branch.
- Suggested direction: add a Tauri deep-link strategy that works cross-platform and validate the Linux `.desktop` registration from an installed package.

#### Stale-listener kill path is compiled out on Linux

- Severity: STRUCTURAL
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/src/lib.rs:809`, `src-tauri/src/lib.rs:5330`, and `src-tauri/src/lib.rs:5349` call `kill_orphan_and_wait`.
  - `src-tauri/src/sidecar_lifecycle.rs:445` implements it only for macOS.
  - `src-tauri/src/sidecar_lifecycle.rs:482` makes non-macOS return `false`.
- Why it breaks on Linux: the identity-gated port allocator can identify a stale o8 listener, call the helper, and still fail to reclaim the port because the Linux branch is a no-op.
- Suggested direction: promote the Unix `term_then_kill` and bind-poll logic into a Linux-capable helper. Avoid relying on `lsof` where `/proc/<pid>` is available.

#### Native Browser Pane is macOS-only

- Severity: STRUCTURAL
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD for Linux client; the inception doc only says the native browser-view stays local for remote-node MVP.
- Evidence:
  - `src-tauri/src/browser_view.rs:60` gates `open` on macOS.
  - `src-tauri/src/browser_view.rs:90` creates a `WebviewWindowBuilder` with external URL and initialization script.
  - `src-tauri/src/browser_view.rs:308` attaches as an AppKit child window.
  - `src-tauri/src/browser_view.rs:333` makes non-macOS `open` return `Ok(())`; `src-tauri/src/browser_view.rs:353` makes eval return `native browser-view is macOS-only`.
- Why it breaks on Linux: the UI can believe the browser pane opened, while the native window and eval/agent-grab path do nothing.
- Suggested direction: either hide Browser Pane agent-grab on Linux or implement a Wry/WebKitGTK-specific host path with explicit feature detection and honest UI capability flags.

#### Autostart/background semantics are macOS-shaped

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/src/lib.rs:4709` initializes autostart with `MacosLauncher::LaunchAgent`.
  - `src-tauri/src/background.rs:13` says launch-at-login defaults ON.
  - `src-tauri/src/background.rs:122` enables autostart on first run.
  - `src-tauri/src/background.rs:183` opens macOS System Settings targets and no-ops off macOS.
- Why it breaks on Linux: Linux autostart is `.desktop` based, desktop-environment-dependent, and not tied to macOS voice hotkeys. The Settings UI can show a generic launch-at-login switch whose reason and behavior are Mac-specific.
- Suggested direction: gate default-on autostart to macOS voice builds; on Linux make it opt-in and verify the plugin writes a valid autostart `.desktop` entry.

#### Tray and notifications need Linux runtime dependencies

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/Cargo.toml:33` enables Tauri tray icons.
  - `src-tauri/Cargo.lock:7070` includes `libappindicator`.
  - `src-tauri/src/lib.rs:2676` builds a tray menu and `src-tauri/src/lib.rs:2776` sends native notifications.
  - `src-tauri/tauri.conf.json:37` defines a tray icon.
- Why it breaks on Linux: tray visibility depends on AppIndicator support and distro packages such as libayatana-appindicator; notifications depend on a desktop portal/notification daemon.
- Suggested direction: document Linux package prerequisites and add startup capability logging so a missing tray backend is visible rather than silent.

### Headless Execution Node

#### Live session discovery depends on optional userland tools

- Severity: STRUCTURAL
- Blocks: headless node
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/lib/runtimes/shared/codex-process-cwd.ts:37` shells to `ps`; `src/lib/runtimes/shared/codex-process-cwd.ts:63` shells to `lsof`.
  - `src/lib/codex/sessions.ts:274` reads process CWD through `lsof`.
  - `src/lib/codex/sessions.ts:291` parses environment using `ps eww`.
  - `src/lib/runtimes/claude-code.ts:721` uses `bash -c "ps ... | grep ..."`, then `src/lib/runtimes/claude-code.ts:737` uses `lsof`.
  - `src-tauri/src/sidecar_lifecycle.rs:319` uses `pgrep`; `src-tauri/src/sidecar_lifecycle.rs:346` uses `lsof`; `src-tauri/src/sidecar_lifecycle.rs:365` and `src-tauri/src/sidecar_lifecycle.rs:384` use `ps`.
- Why it breaks on Linux: `lsof` is often absent from minimal server images, `pgrep` lives in procps, and `ps` flags/output vary. On a headless node this degrades liveness, ownership, interrupt, and orphan cleanup.
- Suggested direction: create a Linux process-inspection provider using `/proc/<pid>/cwd`, `/proc/<pid>/cmdline`, `/proc/<pid>/environ`, and `/proc/net/tcp*`; keep shell-outs as fallback.

#### Local filesystem adjacency remains in merge and cleanup paths

- Severity: STRUCTURAL
- Blocks: headless node
- Known vs greenfield: KNOWN for merge via local-path fetch; GREENFIELD for cleanup/status implications.
- Evidence:
  - `src/lib/lane/worktree-side-merge.ts:145` takes both `repoPath` and `worktreePath`.
  - `src/lib/lane/worktree-side-merge.ts:151` fetches from the worktree filesystem path.
  - `src/lib/lane/worktree-side-merge.ts:183` fetches from the main repo path back into the worktree.
  - `src/lib/lane/worktree-side-merge.ts:616` creates a local manager from `lane.repoPath`; `src/lib/lane/worktree-side-merge.ts:619` maps by local path.
- Why it breaks on Linux headless: the inception doc already calls out merge-via-local-path-fetch; the adjacent cleanup/status code also assumes the control plane can stat and manage the same worktree path.
- Suggested direction: model `worktreeHost` explicitly. Remote nodes should compute diff/status/cleanup on the node and send artifacts; central o8 should merge from origin refs only.

#### Node discovery is desktop-login-shell oriented

- Severity: ADJUSTMENT
- Blocks: desktop client and headless node
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/src/lib.rs:1211` describes `zsh -> bash -> sh` login-shell node lookup.
  - `src-tauri/src/lib.rs:1236` looks for Homebrew Node paths at `/opt/homebrew` and `/usr/local/opt`.
  - `src-tauri/src/lib.rs:1280` tries `zsh -l`, `bash -l`, then `sh -l`.
  - `src-tauri/src/lib.rs:1349` includes `Library/pnpm` plus XDG pnpm paths.
- Why it breaks on Linux: headless systemd/SSH services may not have `zsh`, interactive shell init, Homebrew, or user dotfiles. The intended node binary should be part of the execution-node contract, not inferred from desktop login behavior.
- Suggested direction: require an explicit `O8_NODE_BIN` or packaged Node for headless nodes; keep login-shell discovery only for interactive desktop installs.

#### Development script cleanup uses `lsof`

- Severity: ADJUSTMENT
- Blocks: headless node and developer Linux workflows
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `package.json:43` uses `lsof -ti :3010 -sTCP:LISTEN | xargs kill -9`.
  - `src/ws-server.ts:5716` also uses `lsof` to find listeners before binding.
- Why it breaks on Linux: dev scripts and server startup cleanup fail on minimal systems where `lsof` is not installed.
- Suggested direction: replace port discovery with a Node implementation or Linux `/proc` fallback; keep `lsof` as an optional fast path.

### Filesystem and Worktree Semantics

#### APFS clone path is safely gated but its config still leaks into cross-platform planning

- Severity: ADJUSTMENT
- Blocks: neither by default; headless performance feature only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/lib/worktree/apfs.ts:78` disables APFS CoW outside Darwin.
  - `src/lib/worktree/manager.ts:50` has `O8_APFS_COW_WORKSPACES`.
  - `src/lib/worktree/manager.ts:972` documents `cp -cR`.
  - `src/lib/worktree/manager.ts:993` shells to `cp -cR` only after APFS capability passes.
- Why it matters on Linux: this does not currently break Linux because capability gating is correct, but Linux execution nodes need a different fast hydration story for large repos.
- Suggested direction: document Linux as `git-worktree` only for now; later consider reflink-aware `cp --reflink=auto` under an explicit Linux capability detector.

#### Case-sensitive path scan did not find duplicate tracked source paths

- Severity: none
- Blocks: neither
- Known vs greenfield: GREENFIELD negative finding.
- Evidence:
  - `git ls-files 'src/*' | awk '{print tolower($0)}' | sort | uniq -d` produced no duplicates.
  - `find src -type f | sed 's#^src/##' | awk '{print tolower($0)}' | sort | uniq -d` produced no duplicates.
- Why it matters on Linux: Linux's case-sensitive default should not immediately explode due to duplicate source paths.
- Suggested direction: still rely on `npx tsc --noEmit` on Linux to catch import-case mismatches.

### WebKitGTK Structural Seams

#### Web mic and recorder APIs need Linux WebKitGTK validation

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD because this is the web dictation path, not the known Swift/Symon Mac stack.
- Evidence:
  - `src/components/desktop/dictation/useDictation.ts:9` selects `MediaRecorder` MIME types.
  - `src/components/desktop/dictation/useDictation.ts:46` probes browser `SpeechRecognition` / `webkitSpeechRecognition`.
  - `src/components/desktop/dictation/useDictation.ts:170` calls `navigator.mediaDevices.getUserMedia`.
  - `src/lib/voice/realtime-client.ts:206` gates realtime voice on `getUserMedia`.
- Why it breaks on Linux: WebKitGTK builds and distro GStreamer stacks vary in MediaRecorder/audio codec support, and Web Speech API availability is not a safe assumption.
- Suggested direction: make dictation capability-driven. Expose a disabled state on Linux unless `getUserMedia`, `MediaRecorder`, and accepted audio MIME are present.

#### `window.open` has mixed handling

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/lib/desktop/open-external.ts:4` says `window.open` is a no-op inside Tauri and wraps Tauri shell open.
  - Some surfaces still call `window.open` directly, e.g. `src/components/desktop/settings/AboutTab.tsx:126`, `src/components/desktop/settings/GitHubTab.tsx:322`, and `src/components/desktop/thoughts/mission-panel/review-card/PacketBuyinDocPane.tsx:47`.
- Why it breaks on Linux: even if WebKitGTK allows popups in some cases, direct `window.open` behavior is inconsistent with the Tauri shell-open wrapper and can silently fail.
- Suggested direction: route all desktop external opens through `openExternalUrl`; treat raw `window.open` as web/mobile only.

#### Service worker logic is Tauri-gated but Linux desktop still needs confirmation

- Severity: ADJUSTMENT
- Blocks: desktop client only
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/app/layout.tsx:61` registers service worker cleanup only when `!window.__TAURI_INTERNALS__`.
  - `src/lib/mobile/push-client.ts:59` registers `sw-push.js` for mobile push.
- Why it matters on Linux: the Tauri internal marker must be present in WebKitGTK consistently; otherwise desktop could register/retain mobile push service workers in the app webview.
- Suggested direction: verify the marker on Linux WebKitGTK and consider a server-injected desktop flag independent of Tauri internals.

### Security, Data, and OS Integration

#### Key storage has a Linux fallback but not a secret-service integration

- Severity: ADJUSTMENT
- Blocks: neither for launch; impacts desktop security posture
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src/lib/db/master-key.ts:5` says `O8_MASTER_KEY` wins for headless/CI.
  - `src/lib/db/master-key.ts:6` uses macOS Keychain only on Darwin.
  - `src/lib/db/master-key.ts:42` creates `~/.o8/master-key`.
  - `src/lib/db/master-key.ts:54` writes mode `0600`.
- Why it matters on Linux: the fallback is operationally workable, but Linux desktop installs usually expect Secret Service/KWallet/GNOME Keyring for long-lived app secrets.
- Suggested direction: keep file fallback for headless nodes, but consider `libsecret`/Secret Service for full desktop client if Linux becomes a supported user-facing platform.

#### Unix socket path is acceptable but token/socket lifecycle needs Linux multi-user testing

- Severity: ADJUSTMENT
- Blocks: neither by default
- Known vs greenfield: GREENFIELD.
- Evidence:
  - `src-tauri/src/lib.rs:4743` defaults `O8_TAURI_MCP_SOCKET` to `/tmp/tauri-mcp-o8-<user>.sock`.
  - `src-tauri/src/lib.rs:4751` writes a token beside the socket with `0600`.
  - `src-tauri/src/sidecar_lifecycle.rs:495` cleans stale socket files on Unix.
- Why it matters on Linux: `/tmp` is sticky and shared; username-derived paths avoid most collisions but not all container/user-namespace edge cases.
- Suggested direction: prefer `$XDG_RUNTIME_DIR/o8/tauri-mcp.sock` on Linux when available; keep `/tmp` as fallback.

## What the Inception Docs Already Cover

No credit taken for these already-known items:

- WebKitGTK needs testing for the Linux desktop client.
- Vibrancy/glass should fall back to solid surfaces on Win/Linux.
- Voice/Symon native stack is Mac-only and should be cut from remote/headless scope.
- Merge via local-path fetch is the central remote-node wall.
- tmux persistence is a good Linux primitive and should remain part of the headless node design.
- Windows is a larger and separate campaign.
