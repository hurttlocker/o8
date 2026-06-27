# Persistent / Crash-Survivable Terminals — Plan

> **✅ SHIPPED — 0.1.514, default ON.** All 5 stages landed; the live kill-test passed (a canvas terminal survived `kill -9` of both ws-server and the app, re-attached with full scrollback, took new live commands). The tmux status bar is hidden so persistence is invisible. Stage map below is kept as the build record.

*Orca teardown item #6, + the natural follow-on to daemon crash-survival (#4). Goal: interactive terminal tiles, canvas terminals, and the global terminal survive a ws-server restart / full app crash and **re-attach with scrollback** on relaunch — so the answer to "is everything still there?" becomes a flat yes.*

## The principle

We already shipped crash-survival for dispatched **agent workers** (detached-process spawn). Terminals are different: an interactive shell needs its **PTY kept alive**, and that's exactly what tmux is for. And o8 already does this — **`o8 run` spawns into a `cortex-run-*` tmux session backed by a disk registry reconciled against `tmux ls`** (`cli/src/commands/run.ts:177`, `managed-runs/registry.ts:176`). The whole feature is: **make interactive terminals do what `o8 run` already does.** No new model — reuse a built-but-uncomposed one.

## What we found (the gap is narrow)

Interactive terminals (the tile you type in, canvas terminals, the global terminal) are all the **`dash-shell`** kind: a plain `$SHELL -l` PTY (`spawnDashShellPty`, `ws-server.ts:1074`) held only in the in-memory `terminalAttachments` map (`ws-server.ts:787`). They survive a *webview reload* (the map persists) but die on a *ws-server restart / crash* (the map is wiped, and shutdown kills every PTY). On restart the tab restores with `tmuxSession: null` and the controller **spawns a fresh shell** — process + scrollback lost.

The pieces to fix it are ~80% built, just never composed for the dash path:
- `createTmuxSession` (`tmux.ts:51`, `new-session -d` + `remain-on-exit`) — **built, zero callers (dead code).**
- `spawnTmuxAttachPty` (`ws-server.ts:1228`) — **already used** for agent + `o8 run` PTY views.
- Tile→session identity **already persists**: `PersistedTab.tmuxSession` → `~/.o8/terminal-states/<scope>.json`.
- The restore path **already splits** alive→`sessionsToAttach` vs dead→`deadTerminalTabs` (`terminal-restore.ts:337`); `XtermPanel` already sends `terminal-attach` on mount + re-attaches on every WS reconnect.
- `/terminal-alive` **already falls back to `tmuxSessionExists`** (`ws-server.ts:3601`).

Missing: dash terminals aren't actually IN tmux (the `cortex-dash-*` name is just a Map key), the liveness probe reads the in-memory map (empty after restart), shutdown/detach kill the session, there's no `capture-pane` scrollback helper, and the canvas snapshot re-spawns fresh.

## Mechanism — settled (no fork)

**tmux**, matching `o8 run`. For an interactive shell it's the right tool and it's already o8's model, so the dependency is justified (unlike the headless workers, where detached-process won). Hard-gate on `isTmuxAvailable()` (`tmux.ts:19`) with a **fallback to today's plain-shell spawn** when tmux is absent — no regression on no-tmux machines. Whole feature gated behind `O8_PERSISTENT_TERMINALS` (default OFF) until dogfooded, then flipped ON (same playbook as #4).

## Stages (each tsc-clean + committable + gated)

**Stage 1 — Spawn dash terminals inside tmux + probe tmux for liveness.** Rewrite `materializePendingDashSession` (`ws-server.ts:3022`) to `createTmuxSession(name, $SHELL, ['-l'], cwd)` → `spawnTmuxAttachPty(name)` (keep the `cortex-dash-*` prefix so all prefix logic survives), gated on `O8_PERSISTENT_TERMINALS` + `isTmuxAvailable()` with the plain-shell fallback. Set a high tmux `history-limit` at create. Flip the liveness source (`checkAliveSessions` / `/api/panel/terminal-sessions`) to union `listCortexTmuxSessions()` for `cortex-dash-*` (or reuse `/terminal-alive`). This is the highest-leverage step — it flips terminals from "dead → respawn" to "alive in tmux → reattach." Test: with the flag on, a created dash session exists in `tmux ls`.

**Stage 2 — Don't kill the tmux session on shutdown / detach + add bounded GC.** Shutdown (`ws-server.ts:5162`) and the 30-min orphan reaper (`ws-server.ts:3303`) currently kill detached/clientless dash PTYs — correct today, a survivor-killer under persistence. Kill only the **PTY view**, keep the tmux session; the canvas card's explicit-close `exit\n` (`terminal-card.tsx:12`) stays the real "kill it" signal. Add a periodic sweep (mirror `managed-runs` reconcile) that kills `cortex-dash-*` sessions referenced by no persisted tab, with a max-age/max-count cap. **Steps must land together** — reaper-off without GC leaks, GC without reaper-off kills survivors. Test: a detached dash tmux session survives the reaper window; an unreferenced one is GC'd past the cap.

**Stage 3 — Restore scrollback history on re-attach.** `tmux attach` redraws the visible screen for free; history above the viewport needs a new `captureTmuxPane` helper (`tmux capture-pane -p -S - -t <name>`, no such helper exists yet) replayed on attach by extending `sendTerminalScrollback` (`ws-server.ts:1143`). Reconcile the three scrollback caps (ws-server 512KB ring, xterm 10000 lines, tmux `history-limit`). Optional one-line "session restored" banner for reattached tabs (the restore path already flags them). Test: write output, kill ws-server, reattach → the history is present.

**Stage 4 — Canvas snapshot persists the session name.** Canvas terminals spawn via the same dash path (Stages 1-3 cover spawn), but the canvas restores from a snapshot that re-spawns fresh on a 1200ms delay (`page.tsx:2198`). Persist `sessionName` in the canvas snapshot store and reattach-if-`tmuxSessionExists`-else-spawn. Test: a canvas terminal survives a restart.

**Stage 5 — Dogfood + flip default ON.** Live kill-test (mirror #4): open a terminal, run something, `kill -9` ws-server / the app, relaunch → the terminal re-attaches with its shell + scrollback intact and a "restored" banner. Then flip `O8_PERSISTENT_TERMINALS` default ON.

**Out of scope:** `o8 run` already survives (it's the reference — leave it). Owned-agent CLIs (`spawnManagedCommandPty`) are not in tmux either but are a separate path (the #4 detached-worker tier already covers dispatched agents; the interactive-CLI case can follow).

## Risks

- **tmux is now a hard dep for the terminal tile** (today it needs none). The `isTmuxAvailable` gate + plain-shell fallback is mandatory.
- **Scrollback caps disagree** (ring 512KB / xterm 10000 / tmux default 2000) — raise tmux `history-limit` or `capture-pane` under-recovers.
- **tmux multi-client sizing** — use `attach-session -d` + drive size through the existing resize path (`ws-server.ts:3209`).
- **Reaping inversion** — Stage 2's reaper-off and GC must ship together.

---

*Source map: `src/ws-server.ts` (dash spawn `:1074`, materialize `:3022`, attach `:1228`, shutdown `:5162`, reaper `:3303`), `src/lib/terminal/tmux.ts` (the built-but-unused `createTmuxSession`), `src/lib/terminal/tab-state.ts` (persisted `tmuxSession` identity), `src/components/desktop/workspace-terminal/terminal-restore.ts` (alive/dead split), `cli/src/commands/run.ts` + `src/lib/runtimes/managed-runs/registry.ts` (the `o8 run` reference model). The plumbing is built; this composes it for the dash path.*
