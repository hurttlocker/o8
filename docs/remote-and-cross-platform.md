# Remote Agents + Cross-Platform — Plan & Go/No-Go (the competing platform #8)

*platform teardown item #8: "macOS/Windows/Linux + run agents on a remote box." The dossier calls it our largest gap and largest effort. This is the solid look — what it actually entails, the one architectural reframe that makes it tractable, the phased plan, and a blunt go/no-go.*

## The reframe (the whole unlock)

Two parallel investigations — a deep map of o8's current coupling, and a landscape scan of how Zed / VS Code Remote / the competing platform do remote dev — **converged on one finding:**

> **Cross-platform-Linux and remote-agent are the same deliverable: a headless Linux "execution node."**

The node is o8 minus the Tauri UI: ws-server + worktree manager + agent spawn + tmux terminals + diff computation + the HTTP/token back-channel. Build it once and it is *both* the Linux build target *and* the thing that runs on a remote box. The central Mac stays the **governance plane** — the orchestrator, the SQLite DB (lanes / approvals / `session_outcomes`), and the review/approval UI. The remote node runs **execution only** and reports diff + lane events back up. This keeps the governance moat central while compute goes wherever you want it.

**Transport:** one persistent SSH connection (`ControlMaster`/`ControlPersist`), the bundled Node server pushed to the remote, and the remote backend **SSH-local-forwarded onto the Mac's loopback** — so `src/middleware.ts`'s existing loopback+token gate passes **with zero change** (the remote backend looks like `127.0.0.1`). This is exactly the Zed / VS Code Remote-SSH model. the competing platform does the same with a Node relay over the SSH channel + a grace-period daemon that keeps PTYs alive across drops.

## What we already have (why this is tractable)

- **The control plane is already HTTP/token, not in-process.** The `o8` CLI + dispatched workers already call o8 over `http://127.0.0.1:<apiPort>` + bearer token (the competing platform #2 work). Point that base at a tunneled port and a remote worker reaches central o8 today.
- **The auth model already accommodates remote.** `src/middleware.ts` already accepts cross-origin callers with a bearer token (that's how mobile works) and loopback automatically — SSH-forward-onto-loopback needs no new security model.
- **tmux persistence (#6, just shipped) is the right remote primitive.** A remote tmux session is exactly what you attach to over SSH with scrollback replay. Linux/macOS hosts have tmux, so crash-survival works on a remote node day one.
- **Vibrancy is already `cfg`-split** (`lib.rs:42-45`, macOS vibrancy vs Windows blur), and the **`surface=solid` theme axis** (built for accessibility) is the clean Win/Linux fallback when vibrancy is absent.
- **The native browser-view** + SSH port-forward of the remote dev server = remote browsing with no video pipeline (Model A). CDP screencast (Model B) is deferred.

## The real walls (not where you'd guess)

1. **The merge model — the genuine architectural lift.** `lane/worktree-side-merge.ts:150` integrates a packet by having the main repo **`git fetch` FROM the worktree's local path**. That's filesystem-adjacency baked into how packets land — meaningless if the worktree is on another box. **Fix:** the remote node pushes its branch to the shared git remote (origin); central o8 merges from origin. Sidestep the local-path fetch, don't wrap it. This is design work, deeper than the spawn primitive everyone expects to be the hard part.
2. **Windows is a separate, ~2–3× larger campaign.** No tmux (the #6 persistence feature is *dead* on Windows — needs a ConPTY-daemon rewrite à la the competitor's `daemon-entry.ts`), no `setsid`/Unix sockets (the `o8_view_*` plugin socket, the pty-bridge), no `lsof`/`pgrep`/`ps` (orphan reaping), no login-shell-PATH model, DPAPI instead of Keychain, Authenticode + a per-OS CI runner (which fights the local-ship/no-CI model). The PTY layer needs `portable-pty`/ConPTY.
3. **The ~5,000-line Mac-only voice/Symon stack doesn't exist off-Mac.** paste/dictation (98 AX gates), Fn-hotkey (CGEventTap), the Swift speech recognizer, the `mac_*` agent tools. This must be an explicit scope cut, not a surprise — fine, because the remote node and a Linux client run no voice.

## The seams to build (the architect's 4)

1. **A `RunHost` abstraction** (`{ local | ssh }`) behind the worker spawn (`runtimes/shared/owned-session/store.ts` + `runtime/pty-bridge.ts`) — today a bare local `spawn`; this is the single insertion point for "run it over SSH."
2. **A host-parameterized `git()` helper** — `worktree/manager.ts` + `worktree-side-merge.ts` already funnel every op through one `execFileAsync('git', …, {cwd})`; wrap it to run on a host.
3. **Merge-via-origin** (wall #1) — push the worktree branch to origin, merge from origin.
4. **Diff over the tunnel** — the remote node computes the diff where the worktree lives; the local UI reads it over the SSH-forwarded backend, so the review/approval surfaces work unchanged.

**Hopelessly local — they stay on the operator's Mac, never go remote:** vibrancy/glass, the native browser-view, the ghost cursor, paste/dictation/Symon. The remote box runs no UI.

## Phased plan

**Phase 1 — Remote agent over SSH (the MVP, the value, the safest).**
A headless **Linux** execution node, driven from the Mac. SSH target from `~/.ssh/config` + `ControlMaster`; push the bundled Node server; `git worktree add` + dispatch the agent CLI **remote** inside tmux; SSH-forward the remote backend onto loopback so transcripts/approvals/diff/review work unchanged; merge via origin (wall #1); browser via port-forward + native browser-view. Reconnect = re-establish `ControlMaster` + re-attach tmux with scrollback. **Delivers "run my fleet on a beefy/remote box" with near-zero new security model and no Windows/screencast/WebKitGTK risk.**

**Phase 2 — Cross-platform CLIENT (separate epic, defer).** Running the o8 *app* on Windows/Linux is distinct from running *agents* on a remote host. Linux client = WebKitGTK testing + force `surface=solid` + drop voice (closest to macOS). Windows client = the big one (ConPTY persistence rewrite, per-OS signing/CI, the no-tmux story). The remote-agent value (Phase 1) lands fully with a **Mac-only client**, so this is a market-reach decision, not a prerequisite.

**Phase 3 — CDP remote-browser screencast (hardest, only if needed).** `Page.startScreencast` frame pipeline + input mapping, for when a page must run in the remote's network/identity context and can't be port-forwarded. Defer until a real need appears.

## Go / no-go

- **Remote-agent (Phase 1)** is moat-aligned (governance stays central, compute goes remote), reuses a lot (control plane + tunnel + tmux + native browser), and the architecture is proven (Zed-class platforms). But it is a **real multi-week epic**, not a "while we wait" item — the merge-via-origin redesign + the `RunHost`/host-git seams + the SSH relay/deploy/reconnect are each substantial. Recommendation: **green-light only as a deliberate, dedicated push** when "run my fleet remotely" is a felt need — and do Phase 1 only; treat Windows as its own later decision.
- **Cross-platform client (Phase 2)** is table-stakes reach, not differentiation, and Windows is the biggest single lift in the whole dossier. **Defer** unless a concrete user demand forces it.

---

*Investigations: o8 coupling map (architect) + remote-dev / cross-platform-Tauri landscape (researcher, sourced from Zed/VS Code Remote/the competing platform docs + the o8 codebase). Key local files: `src/lib/worktree/manager.ts`, `src/lib/lane/worktree-side-merge.ts:150` (the merge wall), `src/lib/runtimes/shared/owned-session/store.ts` (the spawn seam), `src/lib/terminal/tmux.ts` (#6 persistence, the remote primitive), `src/middleware.ts` (the gate SSH-forward keeps satisfying), `src-tauri/src/lib.rs:42-45` (vibrancy cfg-split).*
