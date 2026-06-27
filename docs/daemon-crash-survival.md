# Daemon Crash-Survival — Plan

*platform teardown item #4. Refit through o8's lens: the competing platform runs PTYs in a detached daemon checkpointed every 5s and cold-restores on restart. o8 already has most of the pieces — this wires them up, it does not build a daemon.*

## The goal

An o8 agent session (a Codex/Gemini worker in a git worktree) should **survive a full app crash, a ws-server restart, or a hot-reload** and be **re-attached live** on relaunch — not silently killed and salvaged. Today a worker dies with the ws-server it was spawned under.

## What we found (honest map)

The worker spawn flows: owned-session store (in **Next**) → `pty-bridge` HTTP POST → **ws-server** `spawnManagedCommandPty` → `pty.spawn(...)`. So:

- **Workers are NOT detached.** They're node-pty children of the **ws-server** process (`ws-server.ts:1100-1127`). When ws-server dies, the PTY master fd closes → SIGHUP → the worker dies. The `tmuxSession` field + `bridgeSessionName` are a **decoy** — only a *name* is produced; there is no real tmux behind a worker.
- **The detach primitive already exists, unused.** `createTmuxSession()` (`src/lib/terminal/tmux.ts:51-96`) runs a real `tmux new-session -d` with `remain-on-exit on` — and has **zero callers**. The liveness probe (`isOwnedRunAlive` → `isBridgeSessionAlive`) **already checks `tmuxSessionExists`**.
- **The transcript already persists continuously.** The worker `| tee`s its own stdout to `~/.o8/owned-codex/<id>/runs/<runId>.jsonl` (`store.ts:566`) — independent of the app, surviving any crash up to the moment of death. This is *better* than the competitor's periodic checkpoint.
- **Durable state already exists.** `session.json` (atomic write, event-driven) + the `lanes`/`lane_events` SQLite ledger survive everything.
- **The boot pipeline already re-reads + salvages.** `bootstrapWsServer()` rehydrates orchestrator session *pointers*, reconciles stuck lanes, sweeps orphans (#1292), and the silent-exit detector salvages dead-session lanes in ~30s. But for owned workers there is **no live re-attach** — re-discovery *finalizes* a dead run, it doesn't *re-bind a still-alive one*.

**Survival by scenario today:**

| Scenario | Worker process | UI on relaunch |
|---|---|---|
| Next hot-reload (ws-server up) | **survives** | shown live again ✅ (orchestrator's in-flight turn lost, rebinds next turn) |
| ws-server restart | **dies** (SIGHUP) | flips to finished/salvaged |
| Full app crash (both die) — **#4 target** | **dies** | finalized/salvaged, never resumed |

**ws-server is already the closest thing to a daemon** — a separate, longer-lived, not-hot-reloaded process that owns the workers. It's just not crash-survivable: its children are SIGHUP-bound to it, and its scrollback is in-memory.

## The fork (the one decision) — how to detach the worker

A worker survives a crash only if its process is detached from BOTH node processes. Three ways, with very different cost:

- **A — tmux** (`createTmuxSession`, already built): the PTY lives in tmux's server, not ws-server. Worker survives; on boot we **re-attach to the live PTY** + replay the `.jsonl` → the operator sees a crashed-then-recovered terminal resume *live*. Highest fidelity, the competing platform-equivalent. Cost: a **tmux runtime dependency** (graceful fallback to today's node-pty when tmux is absent → non-survivable on those machines).
- **B — detached process + transcript replay** *(recommended)*: spawn the worker `detached:true` + `setsid` + `.unref()`, output to the same `.jsonl` (the existing rare *fallback* path already does exactly this — `store.ts:595-604`). Worker survives orphaned to init; on boot we **re-bind** by pid-probe + `.jsonl` replay. **No new dependency**, reuses an existing path. Loses the live *raw PTY* re-attach — but o8 workers are `codex exec --json` streaming to the lane, where **the `.jsonl` IS the stream**, so the lane transcript restores fully; only the "watch the raw terminal" nicety degrades to a `.jsonl` tail.
- **C — a real custom daemon** (the competitor's literal design): a separate supervisor process owning all workers, checkpointed every 5s. Most robust, but the largest build — and redundant given the `.jsonl` + ws-server-as-daemon already exist.

> **DECISION (locked 2026-06-27): Option B — detached process + `.jsonl` replay.** No new dependency, reuses the existing detached-spawn path (`store.ts:595-604`), and the `.jsonl` is already the source of truth for `codex exec --json` workers. The live raw-terminal watch degrades to a `.jsonl` tail (acceptable — the lane transcript is the real signal). tmux (A) stays available as a future enhancement for live-PTY re-attach if wanted; C is not pursued.

## Status (2026-06-27): worker tier feature-complete behind the flag

A deep trace of the boot path found the re-bind is **largely emergent** from Stage 1 + existing infra, not a build:
- The lane transcript is read from the `.jsonl` (runtime-agnostic poll), **not** the PTY — so a PTY-less detached survivor's transcript already reaches the UI (the existing detached fallback already proves this).
- `reconcileStuckLanes` already **re-binds** a survivor by `sessionKey` and leaves its lane `running` (`reconcile.ts:232`).
- Orphan sweep + the silent-exit detector are **already alive-gated** on `isOwnedRunAlive` (`isPidAlive(pid)` → true for a detached survivor) — neither finalizes a live survivor.
- Interrupt (`process.kill(-pid)` on the setsid group) and resume (`threadId` from the `.jsonl`) already survive.

So: **Stage 1 ✅** (committed `c8f0a3bf` — gated detached spawn + `detachMode`). **Stage 2 ✅** (re-bind observability log in `reconcile.ts` + `tests/crash-survival.test.ts` locking the liveness contract). **Stage 3 ✅ already-satisfied** (sweep + silent-exit alive-gating, now guarded by the contract test). **Remaining:** a live dogfood (ship → kill ws-server mid-run → confirm the worker survives + the lane resumes `running`), then flip `O8_CRASH_SURVIVABLE_WORKERS` ON by default. **Stage 4 (orchestrator-turn survival)** is the separable larger gap — file as fast-follow. **Stage 5 (warm scrollback)** stays optional.

## Target model + stages (each tsc-clean + committable + a kill-test)

Assumes the chosen detach mechanism from the fork; the stages are mechanism-agnostic except Stage 1.

**Stage 1 — Detach the worker spawn.** Route `spawnManagedCommandPty` (or the bridge) through the chosen detach (B: `detached:true`+`setsid`+`.unref()`, stdout already `tee`→`.jsonl`; A: `createTmuxSession`). Stamp the REAL handle (pid for B, tmux session for A) into `session.json`. Keep today's node-pty as the fallback when the detach mechanism is unavailable, and **record which mode a run used** so boot knows how to re-bind. Test: spawn a worker, kill ws-server, assert the worker pid is still alive.

**Stage 2 — Re-attach / re-bind on boot (cold-restore).** In `bootstrapWsServer()`, BEFORE the salvage/sweep runs, for each active lane whose run is detach-mode + still alive: re-bind it (B: re-open the `.jsonl` stream + mark the run `running`; A: re-attach the PTY via the existing tmux-attach path) and **replay the `.jsonl`** to restore lane transcript/scrollback. The liveness probe already reads alive, so the lane stays `running` and the UI shows it live. Test: kill the whole app mid-run, relaunch, assert the lane returns to `running` with the transcript intact (not salvaged).

**Stage 3 — Guard salvage + sweep from reaping a re-attachable session.** The silent-exit detector + `sweepOrphanedOwnedSessions` must never finalize/archive a run whose detached process is still alive. The probe already checks this, but enforce ordering: Stage-2 re-bind runs first, and salvage explicitly skips `alive===true`. Test: relaunch with a live detached worker, assert silent-exit does NOT salvage it within two ticks.

**Stage 4 — Orchestrator-turn survival (larger; may defer).** The orchestrator's own subprocess (Claude REPL / Codex, `orchestrator-session.ts`) is a plain non-detached child of Next — its in-flight turn dies on any Next reload. Detaching it (same mechanism) + rehydrating the in-flight turn is the largest true gap and is **separable** from worker survival. Decide whether #4 includes it or files it as a fast-follow.

**Stage 5 — Warm scrollback checkpoint (optional, minor).** ws-server's in-memory scrollback isn't checkpointed; `.jsonl` replay already covers correctness, so this is only for *instant* warm reconnect. Defer unless reconnect latency is felt.

## Acceptance

- Kill ws-server (or quit the whole app) mid-run; on relaunch the worker process is still alive and its lane returns to `running` with the full transcript — **not** salvaged or restarted.
- A machine without the detach mechanism (e.g. no tmux for Option A) degrades gracefully to today's behavior, never errors.
- The silent-exit / orphan-sweep paths never reap a still-alive re-attached session.
- A `kill-test` in the suite encodes the survival contract so a future change can't silently regress it.

---

*Source map: `src/lib/runtimes/shared/owned-session/store.ts`, `src/lib/runtime/pty-bridge.ts`, `src/ws-server.ts`, `src/lib/terminal/tmux.ts` (the unused detach primitive), `src/lib/lane/sweep-orphan-sessions.ts`, `src/lib/lane/orchestrator-session.ts`, `src/lib/supervisor/silent-exit-detector.ts`. The hard parts — continuous transcript, durable session+lane ledger, a boot pipeline that scans/reconciles/salvages, and a built-but-unused tmux detach primitive — already exist. #4 is wire-up + re-attach.*
