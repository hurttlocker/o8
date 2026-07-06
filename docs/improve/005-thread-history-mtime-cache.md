# 005 — Stop re-parsing every orchestrator thread file from disk every second

## What & why
`src/ws-server.ts:3482` runs `pushOrchestratorThreadChanges()` on a **1000ms interval**. It calls `listMobileOrchestratorThreads()` (`src/lib/mobile/orchestrator-thread-history.ts:283–318`), which does `readdirSync` + `statSync` + `readFileSync` + `JSON.parse` of the **entire** `thoughts-*.json` file for every thread — every second, whenever ≥1 client is connected, even when nothing changed. Files hold full message history, so cost scales with thread count × transcript length: a long session degrades the whole ws-server event loop (which also serves dispatch, review, and presence traffic). Strongest single perf win found in the sweep.

## Exact change
- In `src/lib/mobile/orchestrator-thread-history.ts`: add an in-module cache keyed by file path → `{ mtimeMs, size, parsed }`. On each list call: `readdirSync` + `statSync` as now, but only `readFileSync`/`JSON.parse` files whose `mtimeMs`/`size` moved; serve the cached parse otherwise. Evict entries for files that disappeared.
- In `src/ws-server.ts` around :3482: keep the interval as the fallback, but short-circuit `pushOrchestratorThreadChanges()` when the cheap stat pass shows no mtime moved since the last push (no serialize, no broadcast).
- If the thread writer lives in the same process (check who writes `thoughts-*.json`), prefer bumping a dirty flag from the writer over pure polling — but only if it's the same process; don't build cross-process notification here.

## What NOT to touch
- The broadcast/serialization pipeline (`broadcast()` at ws-server.ts:1845 stringifies once — already healthy).
- The wire format or the 1s cadence of *delivery when something did change* — mobile clients rely on freshness.

## Acceptance criteria (reachability-grade)
- With a session holding several long threads and one connected client: steady-state (no new messages) shows zero `readFileSync` of thread files per tick (add a temporary counter/log to prove it, remove before commit) and no full-file re-parse.
- New message in a thread still reaches a connected mobile/desktop client within ~1–2s (drive the real path: send an orchestrator message, watch it arrive).
- Existing tests green; add a unit test for the cache (same mtime → cached object identity; touched file → re-parsed).

## Verification
```bash
npm run typecheck && npm test
```
Then live: run `npm run dev`, connect a client, watch CPU/logs at idle vs. before (a 30s sample of the ws process should show the read/parse hot path gone).

## Failure path
If mtime granularity causes missed updates (same-ms writes) after 3 attempts at tuning (include `size` and a content hash fallback): stop, revert, report — do not ship staleness.

## Executor tier
Codex via o8 dispatch (well-specced, mechanical, testable). Review by `reviewer` agent before done.
