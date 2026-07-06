# 002 — Orchestrator sends die silently after relaunch (#1459)

## What & why
GitHub issue #1459 (open): after an app relaunch (e.g. post-ship update), sending a message in the orchestrator chat does nothing — no bubble, no error, nothing in the transcript. Reported as "switched to Sonnet, nothing happened." This kills a mission run mid-flight and is the first thing the operator (and any user) hits right after an update. Beta-gate relevant: a scoring day that dies silently after a relaunch can't be scored.

This is an investigation-first plan: the root cause is not yet pinned. Likely suspects, in order:
1. The orchestrator chat tab is an interactive `claude` stream-json subprocess (memory: "Orchestrator = Claude REPL"); after relaunch the UI may hold a session handle to a dead/stale subprocess and the send path drops the message without surfacing the write failure.
2. Session rehydration in `src/lib/lane/orchestrator-session.ts` (and its Codex twin `codex-orchestrator-session.ts`) — `rehydrate*Session` / `ensure*Session` paths may return a session object whose PTY/stdin is gone.
3. The ws-server relay: a send that reaches `src/ws-server.ts` but targets a session key that no longer resolves may be silently swallowed (no error frame back to the client).

## Exact change
1. **Reproduce first**: build/run dev (`npm run dev`), open orchestrator, send a message (works), kill and relaunch the app process, send again. Also try the model-switch variant from the issue (`gh issue view 1459 -R hurttlocker/o8`). Capture ws-server logs.
2. Trace the send path end-to-end: UI send handler → ws message → ws-server routing → orchestrator session write. Identify exactly where the message disappears without an error.
3. Fix the root cause (dead-session detection + re-spawn/rehydrate on send, most likely), AND close the silent-failure channel: any send that cannot be delivered must produce a visible error state in the chat UI (error bubble or toast) — never a no-op. That second part is required regardless of root cause.

## What NOT to touch
- Do not switch the orchestrator to `claude -p` (banned — #1066).
- Do not refactor the twin session files while here (that's plan 008); make the minimal fix in whichever path is broken.

## Acceptance criteria (reachability-grade)
- Real path: relaunch the built app (or dev equivalent), send an orchestrator message → either it delivers (bubble + response) or a visible error appears. Zero silent no-ops in 5 relaunch-send cycles.
- The model-switch repro from #1459 no longer reproduces.
- A regression test pins the fixed layer (e.g. unit test: send against a session whose subprocess is dead → returns/raises a surfaced error, triggers rehydrate).

## Verification
```bash
npm run typecheck && npm test
```
Then live: 5× relaunch→send cycles in dev; one cycle in the built app if a ship happens anyway (do not ship just for this — commit and hold per ship skill).

## Failure path
If the root cause isn't reproducible after 3 focused attempts: stop, write up the exact trace evidence gathered (where the message was last seen) as a comment on #1459, and report back. Do not land speculative fixes.

## Executor tier
Opus (debugging with judgment mid-flight). Review by `reviewer` agent before done.
