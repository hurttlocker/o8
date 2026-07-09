# Linux Port Structural Audit

Scope: greenfield Linux structural issues beyond `docs/remote-and-cross-platform.md` and `docs/desktop-app-strategy.md`. This audit covers the full Tauri desktop client and the planned headless execution node.

## Executive Top 10 Greenfield Findings

1. **Linux bundle cannot build with the current externalBin set** — **BLOCKER**, desktop client, evidence: `src-tauri/tauri.conf.json:47`, `src-tauri/tauri.conf.json:48`, `src-tauri/tauri.conf.json:49`, `src-tauri/build.rs:80`, `src-tauri/build.rs:84`, `scripts/build-speech-local.mjs:27`.
2. **Release/updater pipeline publishes only macOS artifacts and darwin updater metadata** — **BLOCKER**, desktop client, evidence: `scripts/release.mjs:48`, `scripts/release.mjs:49`, `scripts/release.mjs:50`, `scripts/release.mjs:109`, `scripts/release.mjs:110`, `scripts/release.mjs:114`, `src-tauri/tauri.conf.json:69`.
3. **Packaged server copies host-built native modules without per-Linux arch/ABI rebuild** — **BLOCKER**, desktop client and headless node, evidence: `package.json:8`, `package.json:9`, `scripts/tauri-export.mjs:424`, `scripts/tauri-export.mjs:425`, `scripts/tauri-export.mjs:430`, `scripts/postinstall.mjs:51`, `scripts/postinstall.mjs:52`.
4. **Headless worker execution is still a local detached process with local cwd/log files** — **STRUCTURAL**, headless node, evidence: `src/lib/runtimes/shared/owned-session/store.ts:571`, `src/lib/runtimes/shared/owned-session/store.ts:634`, `src/lib/runtimes/shared/owned-session/store.ts:636`, `src/lib/runtimes/shared/owned-session/store.ts:684`, `src/lib/runtimes/shared/owned-session/store.ts:691`, `src/lib/runtimes/shared/owned-session/store.ts:692`.
5. **Linux EADDRINUSE recovery hard-requires `lsof` and exits if it is absent** — **ADJUSTMENT**, headless node, evidence: `src/ws-server.ts:5715`, `src/ws-server.ts:5716`, `src/ws-server.ts:5730`, `src/ws-server.ts:5734`.
6. **Main git watcher uses `fs.watch(..., { recursive: true })` on `.git/refs`** — **ADJUSTMENT**, headless node, evidence: `src/ws-server.ts:5668`, `src/ws-server.ts:5671`, `src/ws-server.ts:5674`.
7. **Doc indexing opens one inotify watch per whitelisted file across every registered repo** — **STRUCTURAL**, headless node, evidence: `src/lib/cortex/indexer/doc-watcher.ts:502`, `src/lib/cortex/indexer/doc-watcher.ts:508`, `src/lib/cortex/indexer/doc-watcher.ts:523`, `src/lib/cortex/indexer/doc-watcher.ts:526`, `src/lib/cortex/indexer/doc-watcher.ts:529`.
8. **Linux auth deep-links have no registered `.desktop`/scheme wiring and the runtime handler is macOS-only** — **BLOCKER**, desktop client, evidence: `src-tauri/Info.plist:74`, `src-tauri/Info.plist:77`, `src-tauri/src/lib.rs:4568`, `src-tauri/src/lib.rs:5599`, `src-tauri/src/lib.rs:5603`, `src-tauri/src/lib.rs:5604`.
9. **Native browser view APIs become success no-ops on Linux** — **STRUCTURAL**, desktop client, evidence: `src-tauri/src/browser_view.rs:333`, `src-tauri/src/browser_view.rs:335`, `src-tauri/src/browser_view.rs:343`, `src-tauri/src/browser_view.rs:357`.
10. **Window configuration enables transparent overlay chrome globally, with no Linux compositor split** — **STRUCTURAL**, desktop client, evidence: `src-tauri/tauri.conf.json:23`, `src-tauri/tauri.conf.json:29`, `src-tauri/tauri.conf.json:30`, `src-tauri/src/dock_window.rs:401`, `src-tauri/src/spatial_ink_window.rs:420`.

## Full Catalog

### Tauri Desktop Shell

#### Linux externalBin build break

- Evidence: `src-tauri/tauri.conf.json:47-49` declares `helpers/speech_recognizer` and `helpers/speech-local` as bundle external binaries.
- Evidence: `src-tauri/build.rs:80-84` makes the Swift `speech_recognizer` sidecar build a macOS-only branch.
- Evidence: `scripts/build-speech-local.mjs:21-29` stages only `speech-local-aarch64-apple-darwin` and `speech-local-x86_64-apple-darwin`, then exits immediately on non-macOS.
- Why it breaks: Tauri validates externalBin paths for the target platform. The repo has no Linux-suffixed sidecars and no non-macOS generation path, so a Linux desktop bundle can fail before app code runs.
- Known vs greenfield: greenfield. The inception docs call the voice stack Mac-only, but not that the still-declared sidecars can block Linux packaging.
- Suggested direction: remove voice sidecars from Linux bundles via target-specific config or generate harmless Linux stubs while the feature is disabled.

#### Transparent overlay chrome is not Linux-split

- Evidence: `src-tauri/tauri.conf.json:23-30` globally sets `titleBarStyle: "Overlay"`, `decorations: true`, and `transparent: true`.
- Evidence: non-macOS dock/spatial windows are no-ops at `src-tauri/src/dock_window.rs:401-411` and `src-tauri/src/spatial_ink_window.rs:420-430`, but the main window config remains transparent.
- Why it breaks: Wayland/X11 compositors vary in transparent-window support; transparent WebKitGTK windows are the class most likely to hit white/blank/compositing failures on NVIDIA and older drivers. The app has no Linux config branch to force an opaque main window even though the auxiliary glass windows are disabled.
- Known vs greenfield: greenfield. The docs mention solid-surface fallback, not native window transparency and titlebar configuration.
- Suggested direction: make Linux main-window config opaque/decorated by default, then gate transparency behind a compositor capability flag.

#### Deep-link registration is macOS-only

- Evidence: `src-tauri/Info.plist:74-83` registers the `o8://` scheme for macOS.
- Evidence: pending auth callback buffering is generic at `src-tauri/src/lib.rs:4568-4583`, but event handling is behind `#[cfg(target_os = "macos")]` at `src-tauri/src/lib.rs:5599-5604`.
- Why it breaks: Linux needs `.desktop` MIME/scheme registration and a runtime `RunEvent::Opened` branch. Without both, desktop sign-in callbacks can never reach the app.
- Known vs greenfield: greenfield.
- Suggested direction: add Tauri Linux scheme metadata plus a non-macOS opened-url handler or document that Linux auth must use a loopback browser callback instead of `o8://`.

#### Native browser view no-ops look successful

- Evidence: Linux `browser_view::open` returns `Ok(())` at `src-tauri/src/browser_view.rs:333-345`.
- Evidence: Linux `navigate` also returns `Ok(())` at `src-tauri/src/browser_view.rs:356-358`, while `eval_result` returns an explicit macOS-only error at `src-tauri/src/browser_view.rs:352-354`.
- Why it breaks: callers that rely on successful `open`/`navigate` will believe a browser surface exists on Linux when nothing was created.
- Known vs greenfield: greenfield. The inception docs say the native browser view stays local/Mac, but not that the Linux branch should fail visibly instead of no-op success.
- Suggested direction: return `Err("native browser-view is macOS-only")` for non-macOS `open` and `navigate`, then map it to a visible UI fallback.

#### Global hotkey and overlay stack disable silently

- Evidence: `src-tauri/src/fn_hotkey.rs:1365-1366` implements `start` as an empty function off macOS.
- Evidence: `src-tauri/src/dock_window.rs:401-411`, `src-tauri/src/point_overlay.rs:769-773`, and `src-tauri/src/spatial_ink_window.rs:420-430` no-op the voice HUD, point overlay, and spatial ink windows off macOS.
- Why it breaks: desktop Linux can boot with UI controls that imply hotkey/overlay availability unless feature discovery hides them. Under Wayland, system-wide key capture is not a CGEventTap-equivalent problem; it needs a portal/global-shortcut strategy and a clear unsupported state.
- Known vs greenfield: known for voice/Symon being Mac-only; greenfield for the silent success/no-op branch behavior.
- Suggested direction: expose a capability endpoint that marks these features unsupported on Linux and make commands fail loudly when invoked.

#### Unix socket path is mostly fine but not collision-safe enough

- Evidence: stale socket cleanup uses `/tmp/tauri-mcp-o8-${USER}.sock` at `src-tauri/src/sidecar_lifecycle.rs:495-499`.
- Evidence: it removes a dead socket after a failed connect at `src-tauri/src/sidecar_lifecycle.rs:506-516`.
- Why it breaks: `/tmp` is sticky but shared. A username-only path can collide across simultaneous display sessions, containers, or root/user namespace cases. Permissions are delegated to the plugin, and this cleanup does not verify owner before unlinking.
- Known vs greenfield: greenfield.
- Suggested direction: move Linux sockets under `$XDG_RUNTIME_DIR/o8/` with `0700` parent permissions; keep `/tmp` only as a fallback with owner checks.

### Packaging, Distribution, and Update

#### Release path publishes macOS only

- Evidence: `scripts/release.mjs:48-51` hardcodes `bundle/dmg`, `bundle/macos/o8.app.tar.gz`, and its signature.
- Evidence: `scripts/release.mjs:109-118` writes updater metadata only for `darwin-x86_64` and `darwin-aarch64`.
- Evidence: `src-tauri/tauri.conf.json:43-46` asks Tauri for all bundle targets and updater artifacts, but the ship script ignores Linux outputs.
- Why it breaks: Linux AppImage/deb/rpm artifacts may be produced by `cargo tauri build`, but the release pipeline will neither require nor upload them. Linux updater checks will find no platform entry.
- Known vs greenfield: greenfield.
- Suggested direction: split release artifact discovery by target OS and emit `linux-x86_64` updater metadata for AppImage only; deb/rpm should show a package-manager/manual update path.

#### Silent-update UX assumes the Tauri updater works everywhere

- Evidence: updater is enabled in config at `src-tauri/tauri.conf.json:69-73`.
- Evidence: launch updater emits available/clear events from `src-tauri/src/launch_updater.rs:21-52`.
- Evidence: desktop `UpdateCard` imports the Tauri updater plugin at `src/components/desktop/UpdateCard.tsx:151-154`.
- Why it breaks: Tauri's updater path is AppImage-oriented on Linux; deb/rpm installs generally need the package manager or a manual download. The current UpdateCard has no installer-kind branch, so deb/rpm Linux users can be offered an update action that cannot complete.
- Known vs greenfield: greenfield.
- Suggested direction: persist installer kind at first launch and branch UpdateCard copy/actions: AppImage can self-update; deb/rpm should link to release/package instructions.

#### Node native addons are copied from the build host

- Evidence: package engines pin Node 22 at `package.json:8-9`.
- Evidence: postinstall rebuilds `better-sqlite3` and `node-pty` in-place at `scripts/postinstall.mjs:51-52`.
- Evidence: export copies the built native module directories into the packaged server at `scripts/tauri-export.mjs:424-430`.
- Why it breaks: the packaged server inherits whatever native binaries were built on the packaging host. A macOS-built bundle cannot supply Linux `.node` files; a Linux bundle built under the wrong Node 22 minor/ABI or libc baseline can still fail on the execution node.
- Known vs greenfield: greenfield.
- Suggested direction: build Linux artifacts on the Linux floor image, run `npm rebuild` there, and make release validation inspect each `.node` with `file`/`ldd` before upload.

#### WebKitGTK floor should be Debian 12/Ubuntu 22.04 with 4.1, but the matrix is not encoded

- Evidence: Linux packaging has no dependency list in `src-tauri/tauri.conf.json:61-66`; only macOS bundle metadata is customized.
- External package references checked on 2026-07-09: Ubuntu 22.04 has `libwebkit2gtk-4.1-0` 2.50.4, Debian 12 has 2.50.6, Fedora 43 has `webkit2gtk4.1` 2.52.4, and Arch has `webkit2gtk-4.1` 2.52.4.
- Why it breaks: without an explicit floor, testers can accidentally validate only fresh rolling distros while deb/rpm metadata omits the required WebKitGTK/libsoup3/GStreamer dependency shape.
- Known vs greenfield: greenfield.
- Suggested direction: set the Linux desktop floor to Debian 12 / Ubuntu 22.04 with WebKitGTK 4.1 and libsoup3; include GStreamer base/good/bad/ugly guidance if any video/audio surfaces are retained.
- Sources: Ubuntu package search for `libwebkit2gtk-4.1-0` on Jammy (https://packages.ubuntu.com/search?keywords=webkit2gtk&searchon=names&section=all&suite=all), Debian package search for `libwebkit2gtk-4.1-0` (https://packages.debian.org/libwebkit2gtk-4.1-0), Fedora package page for `webkit2gtk4.1` on Fedora 43 (https://packages.fedoraproject.org/pkgs/webkitgtk/webkit2gtk4.1/fedora-43-updates.html), Arch package page for `webkit2gtk-4.1` (https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/).

### Headless Execution Node

#### Worker spawn is local-process/local-filesystem

- Evidence: `spawnOwnedRun` prepares stdout/stderr files under a local session directory at `src/lib/runtimes/shared/owned-session/store.ts:571-576`.
- Evidence: it builds a local shell pipeline at `src/lib/runtimes/shared/owned-session/store.ts:634-636`.
- Evidence: non-Windows launch uses local `nice` and `cwd: session.repoPath` at `src/lib/runtimes/shared/owned-session/store.ts:684-698`.
- Why it breaks: a headless node can run this code if the node owns the worktree, but a Mac governance plane cannot use this path to start a remote worker without first moving the whole process to the remote. The missing RunHost is deeper than CLI invocation: stdout/stderr paths, session dirs, cwd validation, and child-exit observation are all local.
- Known vs greenfield: adjacent to known RunHost seam, but greenfield in the concrete crash-survivable detached path.
- Suggested direction: make `OwnedSessionStore` host-bound. A local host writes local logs; an SSH host creates remote session dirs and streams or fetches JSONL over the control channel.

#### Port cleanup assumes `lsof`

- Evidence: EADDRINUSE recovery calls `lsof -ti :PORT -sTCP:LISTEN` at `src/ws-server.ts:5715-5716`.
- Evidence: any failure logs and exits at `src/ws-server.ts:5730-5734`.
- Why it breaks: slim Linux images commonly omit `lsof`. An otherwise healthy headless node can fail to start during stale-port recovery.
- Known vs greenfield: greenfield.
- Suggested direction: prefer a pidfile owned by ws-server; fallback to `ss -ltnp`, then `fuser`, then clear guidance. Do not exit solely because `lsof` is absent.

#### Watcher model can exhaust inotify and miss `.git` events

- Evidence: main repo refs use recursive `fs.watch` at `src/ws-server.ts:5668-5674`.
- Evidence: doc watcher loads registered repos and watches every whitelisted file individually at `src/lib/cortex/indexer/doc-watcher.ts:502-529`.
- Why it breaks: Linux inotify limits are per user and low on many distros. A fleet with many `.cortex-worktrees` clones and registered sibling repos can exhaust handles or queue limits, causing missed review/doc updates.
- Known vs greenfield: greenfield.
- Suggested direction: add watcher health metrics, detect `ENOSPC`, and either raise `fs.inotify.max_user_watches` guidance or switch high-cardinality paths to polling/coalesced scans on headless nodes.

#### Shell and PATH resolution still carries Mac-first assumptions

- Evidence: PTY fallback PATH includes `/opt/homebrew/bin` and `/usr/local/bin` before Linux paths at `src/lib/ws-server/pty-support.ts:21-24`.
- Evidence: preferred shells try `$SHELL`, `/bin/zsh`, `/bin/bash`, `/bin/sh` at `src/lib/ws-server/pty-support.ts:28-40`.
- Evidence: CLI resolver login-shell fallback tries `zsh`, `bash`, then `sh` at `src/lib/runtimes/shared/cli-resolver.ts:302-313`.
- Why it breaks: this does not hard-fail on Linux, but it biases diagnostics and startup latency toward Mac install conventions. On minimal nodes without zsh, repeated failed probes are expected; on distro installs, CLIs may live under `/usr/bin`, `/usr/local/bin`, `~/.local/bin`, or tool-managed paths.
- Known vs greenfield: greenfield.
- Suggested direction: make Linux host profiles explicit: default shell `/bin/bash` or `/bin/sh`, XDG-aware CLI directories, and one-shot environment capture during node registration.

#### Master-key fallback is file-based, not OS keyring-backed

- Evidence: resolver order says `O8_MASTER_KEY`, macOS Keychain, then file fallback at `src/lib/db/master-key.ts:4-10`.
- Evidence: non-darwin returns absent for keychain at `src/lib/db/master-key.ts:77-79`.
- Evidence: fallback creates `~/.o8/master-key` with `0600` at `src/lib/db/master-key.ts:42-55`.
- Why it breaks: this is workable for headless, but Linux desktop installations should decide whether secrets belong in libsecret/KWallet or in a local file. For execution nodes, the file fallback must be part of provisioning/backup because losing it or changing users can orphan encrypted blobs.
- Known vs greenfield: greenfield.
- Suggested direction: headless node should require `O8_MASTER_KEY` or a provisioned key file; Linux desktop should evaluate `secret-service` integration separately.

### Worktree and Git Machinery

#### APFS CoW path must stay Mac-only

- Evidence: worktree creation branches into `apfs-cow-clone` at `src/lib/worktree/manager.ts:351-360`.
- Evidence: hydration uses `cp -cR` at `src/lib/worktree/manager.ts:991-995`.
- Why it breaks: GNU `cp` does not support macOS `-c` clonefile semantics. The code appears guarded by capability resolution, but the Linux port should verify that `getApfsCowCapability` never returns true off Darwin and that configuration cannot force this mode.
- Known vs greenfield: greenfield.
- Suggested direction: make `apfs-cow-clone` reject immediately unless `process.platform === 'darwin'`; use reflink-capable `cp --reflink=auto` only as a separate Linux mode.

#### Hook injection assumes local checkout paths

- Evidence: safety hooks write absolute commands to `node "${path.join(o8Root, 'dist/hooks/...')}"` at `src/lib/worktree/manager.ts:1073-1098`.
- Why it breaks: a remote/headless worker needs hooks that point to the node's o8 installation, not the Mac control plane path. If metadata is authored centrally and executed remotely, these absolute hook paths are invalid.
- Known vs greenfield: greenfield.
- Suggested direction: make hook templates host-relative, or install hooks as part of remote node bootstrap and write node-local paths only.

#### Local-path fetch is known, but current code also uses local-path sync back into the worktree

- Evidence: known wall: `fetchWorkerHeadIntoMainRepo` fetches from `worktreePath` at `src/lib/lane/worktree-side-merge.ts:145-152`.
- Evidence: additional local sync: `syncWorktreeBaseForCleanup` fetches `repoPath` into `worktreePath` at `src/lib/lane/worktree-side-merge.ts:183-190`.
- Why it breaks: even after replacing merge with origin-push, cleanup/base-sync logic still assumes mutual filesystem/git reachability between main repo and worktree.
- Known vs greenfield: the primary fetch wall is known; the cleanup sync path is greenfield.
- Suggested direction: after merge-via-origin, audit every `git(..., [fetch, repoPath/worktreePath])` helper and replace with origin refs or node-local cleanup RPCs.

#### Path equality is case-sensitive, which is good on Linux but can expose legacy data drift

- Evidence: worktree ID lookup compares exact paths at `src/lib/lane/worktree-side-merge.ts:616-620`.
- Evidence: cleanup compares normalized strings without case folding at `src/lib/orchestrator/worktree-cleanup.ts:91-93`.
- Why it breaks: Linux is case-sensitive; stale registry entries captured on macOS with case drift can fail to match metadata or cleanup targets. This is safer than case-folding but needs migration visibility.
- Known vs greenfield: greenfield.
- Suggested direction: on Linux node registration, realpath every repo/worktree path and warn on registry entries whose exact casing differs from disk.

### WebKitGTK Structural APIs

#### Clipboard and drag/drop need native-bridge validation

- Evidence: clipboard writes are browser API calls in desktop components, e.g. `src/components/desktop/O8InboxPane.tsx:264`, `src/components/desktop/InlineDiffViewer.tsx:218`, `src/components/desktop/thoughts/PacketActionStrip.tsx:181-187`.
- Evidence: OS file drop bridge emits Tauri drag/drop events from `src-tauri/src/lib.rs:5209-5239` while `dragDropEnabled` is disabled globally at `src-tauri/tauri.conf.json:31`.
- Why it breaks: WebKitGTK permission/user-gesture behavior for `navigator.clipboard` and Tauri's Linux drag/drop event shape need real validation. The code is structurally reliant on those APIs for copy/export and composer attachments.
- Known vs greenfield: greenfield.
- Suggested direction: add capability tests for clipboard write and external file drop on Linux; if unavailable, route copy through Tauri clipboard plugin and file drop through a Linux-specific event path.

#### Media/video surface is light, but GStreamer dependencies still matter

- Evidence: CSP allows `media-src 'self' blob:` at `src-tauri/tauri.conf.json:35`.
- Evidence: STT/local audio sidecars are macOS-only or Apple-targeted at `src-tauri/src/stt/whisper.rs:127-138` and `scripts/build-speech-local.mjs:1-6`.
- Why it breaks: there is no major in-app video surface in the audited paths, but any retained audio/video playback on Linux will rely on distro GStreamer plugins rather than AVFoundation/WKWebView behavior.
- Known vs greenfield: greenfield.
- Suggested direction: keep Linux floor docs explicit: WebKitGTK 4.1 plus GStreamer base plugins; add extra codec packages only when a real video surface ships.

### Scripts and Userland Differences

#### Ship scripts are macOS command stacks

- Evidence: `scripts/sign-and-notarize.mjs:25-31` requires Apple notarization environment.
- Evidence: it runs `codesign`, `ditto`, `xcrun`, `hdiutil`, and DMG staging at `scripts/sign-and-notarize.mjs:112-224`.
- Evidence: `package.json:53` makes `ship` run this script before release.
- Why it breaks: Linux artifacts cannot be shipped with the current `npm run ship` path. This is separate from Tauri's ability to build a Linux bundle.
- Known vs greenfield: greenfield.
- Suggested direction: split `ship:mac`, `ship:linux`, and `release` artifact collection; Linux signing should cover AppImage/deb/rpm checksums and updater signatures, not Apple notarization.

#### macOS scheduler scripts have no systemd path

- Evidence: compactor cron installers write `~/Library/LaunchAgents` and use `launchctl` at `scripts/install-compactor-cron.sh:27`, `scripts/install-compactor-cron.sh:56`, `scripts/install-compactor-cron.sh:107-156`; the digest variant repeats this at `scripts/install-compactor-digest-cron.sh:26`, `scripts/install-compactor-digest-cron.sh:55`, `scripts/install-compactor-digest-cron.sh:106-155`.
- Why it breaks: headless Linux execution nodes will need timers for compaction/digest-style background jobs, but these installers are launchd-only.
- Known vs greenfield: greenfield.
- Suggested direction: provide systemd user timer units or keep these jobs centralized on the Mac governance plane.

## What the Inception Docs Already Cover

- WebKitGTK needs testing: covered in `docs/remote-and-cross-platform.md`; this report only adds structural API/dependency seams.
- Vibrancy should fall back to solid surfaces: covered; this report adds native transparent-window/compositor risk.
- Voice/Symon stack is Mac-only: covered; this report only credits packaging/no-op fallout.
- Merge-via-local-path-fetch wall: covered; this report only adds cleanup/base-sync local-path fetches.
- tmux persistence works on Linux: covered and confirmed by `src/lib/terminal/tmux.ts:35-44`, `src/lib/terminal/tmux.ts:67-111`, and `src/ws-server.ts:1260-1308`; no credit claimed as a blocker.
