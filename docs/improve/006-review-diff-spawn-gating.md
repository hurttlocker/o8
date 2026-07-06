# 006 — Gate the review-diff broadcaster's git subprocess storm

## What & why
`broadcastReviewFileChanges()` (`src/ws-server.ts:5107`) is driven by BOTH a 10s poll (`reviewPollTimer`, ws-server.ts:5205) AND `.git` refs/index fs-watchers (ws-server.ts:5187, 5196, 500ms debounce). Each invocation loops **all** watch targets calling `getLiveReviewChangeSet()` (`src/lib/review/live-changes.ts:89–97`), which spawns **3 git subprocesses per target** (diff/ls-files). N worktrees → 3N process spawns per tick; a rebase or `git gc` makes the watchers fire in bursts on top of the poll. With several concurrent missions (the beta-gate scenario is exactly 3+ worktrees) this is a constant background process storm on the same event loop serving dispatch.

## Exact change
- In `src/lib/review/live-changes.ts` (or a thin wrapper at the call site): before spawning, `statSync` the target's `.git` index file + HEAD ref mtimes; if neither moved since the last successful scan for that target, return the cached change-set. Cache per target path.
- In `src/ws-server.ts` around :5107–5205:
  - Coalesce watcher bursts: the existing 500ms debounce fires per-watcher; add a single shared trailing-edge coalescer so a rebase burst produces one scan, not one per event.
  - Cap concurrency: scan targets sequentially or with a small pool (2–3), not all N in parallel.
  - Skip entirely when zero clients are subscribed to review changes (check whether a subscriber-count guard already exists like the inbox polls have; mirror that pattern).

## What NOT to touch
- The 10s poll as a fallback (keep it; it becomes cheap once mtime-gated).
- The shape of the broadcast payload / review UI contract.

## Acceptance criteria (reachability-grade)
- With 3 idle worktree targets and a connected client: `ps`-sampling the ws process for 60s shows no recurring `git diff`/`git ls-files` children (before: ~18/min minimum). Prove with a temporary spawn counter log, removed before commit.
- Editing a file in a watched worktree still updates the review panel within ~1s (drive the real path in the app).
- A rebase in one worktree triggers a bounded number of scans (1–2), not a burst.

## Verification
```bash
npm run typecheck && npm test
```
Then live: `npm run dev` with 2–3 real worktrees, watch spawn counts idle vs. active; confirm review panel freshness by touching files.

## Failure path
If mtime gating misses legitimate changes (e.g. diffs against working tree where index doesn't move) after 3 attempts: stop, revert to current behavior, report which change class the index/HEAD mtimes fail to capture.

## Executor tier
Codex via o8 dispatch. Review by `reviewer` agent before done.
