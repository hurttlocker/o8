# 001 — Merge truth by ancestry, everywhere (kills #1457 phantom releases)

## What & why
Three sibling defects share one root: o8 decides "this lane's work landed" from weak signals instead of git ancestry, so merge state can lie in both directions.

1. **#1457 (GitHub, open)** — `approve_and_merge` reports "Already released" while the merge never ran, and the inverse: reports `merged:false` while the work actually landed. This is the single biggest beta-gate risk: a 3-concurrent-mission scoring day cannot be scored if merges lie.
2. **Worktree-gone false completion** — `reconcileOrphanedWorktrees()` in `src/lib/lane/reconcile.ts` treats "worktree directory missing" as proof of merge and transitions the lane to `completed` (reason `worktree_missing_reconciled`, around lines 130–185). The branch-gone path (#558) verifies merge before completing; the older worktree-gone path never got that guard. Scenario: someone `git worktree remove --force`s an abandoned lane → the lane reads as shipped, unmerged work silently vanishes.
3. **Fragile merge verification** — `laneBranchWasMerged()` (same file, ~line 111) verifies merges by regex-matching commit **subjects** (`Merge (branch|lane)…<branch>`) over the last 50 commits. A squash or rebase merge produces no such subject → merged work reads as unmerged; conversely a subject that happens to match could false-positive.

The correct primitive already exists in the codebase: `branchIsMergedIntoBase` in `src/lib/lane/worktree-reaper.ts:47` runs `git merge-base --is-ancestor <branch> <base>` (line ~58). Note the known trap: **swapped arguments report clean-merge either way** (memory: #1457 "both-direction lies"). No test currently asserts the direction.

## Exact change
- `src/lib/lane/reconcile.ts`:
  - Replace `laneBranchWasMerged()`'s commit-subject regex with an ancestry check (`git merge-base --is-ancestor <laneHeadSha> <baseBranch>`). For the branch-gone case the branch ref is deleted, so the lane's recorded head SHA (check `Lane` fields in `src/lib/lane/types.ts` for a stored head/commit sha; if none exists, fall back to the existing subject scan AND add the sha field to the lane record at merge time) must be used instead of the branch name.
  - Gate the **worktree-gone** path on the same verification: if merge cannot be confirmed, do NOT set `completed` — transition to a review/attention state (pick the existing status the supervisor inbox surfaces, e.g. the one used for unverifiable reconciliation; do not invent a new status without checking `src/lib/lane/types.ts`).
- `src/lib/orchestrator/operator-mission-service/merge.ts` and `merge-truth.ts` (this module exists — read it first; #1457 may be partially addressed): make `approve_and_merge`'s reported result derive from an ancestry check performed **after** the merge attempt, not from cached/derived state. "Already released" must only be reported when `merge-base --is-ancestor` confirms the lane head is an ancestor of the base branch HEAD.
- Tests (this is half the value):
  - New unit/integration test asserting **argument direction** of every `--is-ancestor` call site: with a real temp git repo (harness pattern exists in `tests/worktree-side-merge-real-git.test.ts`), create base + branch, merge one way, assert merged=true; create diverged branch, assert merged=false; **swap-proof**: an unmerged branch whose base is ahead must report false, not true.
  - Squash-merge case: squash-merge a branch, assert the new verification reports merged (by sha ancestry of the squash content — note: squash creates a NEW commit, so sha-ancestry of the branch head will be false; the test must pin whatever semantics you implement and the status chosen for "content landed but ancestry unprovable". Document the decision in the test.)
- Read GitHub issue #1457 (`gh issue view 1457 -R hurttlocker/o8`) before starting; reproduce its exact report path first.

## What NOT to touch
- Do not change the branch-gone (#558) control flow beyond swapping its verification primitive.
- Do not touch the decomposition-scan (#544/#538) logic below the transition in `reconcileOrphanedWorktrees`.
- Do not modify `worktree-reaper.ts`'s existing reaping behavior — reuse its primitive.

## Acceptance criteria (reachability-grade)
- `gh issue view 1457` repro path: an `approve_and_merge` on a lane whose merge fails must NOT report released; a lane whose work landed must report merged=true. Verified by driving a real dispatch→merge in the dev app, not only tests.
- Force-removing an unmerged lane's worktree (`git worktree remove --force`) no longer yields `completed`; the lane surfaces for review.
- New tests fail if any `--is-ancestor` call's arguments are swapped (mutate to check once, locally).

## Verification
```bash
npm run typecheck && npm test          # all green, incl. new reconcile/merge-truth tests
npx vitest run tests/worktree-side-merge-real-git.test.ts
```
Then live: dispatch a trivial mission in dev, approve_and_merge it, confirm reported state matches `git log` ancestry; repeat with a deliberately failing merge.

## Failure path
If stuck after 3 attempts (especially on the squash-merge semantics or missing lane head sha): stop, revert, report the blocking decision — do not ship a partial verification that can still lie.

## Executor tier
Opus (judgment mid-flight: status semantics + squash decision). Review by `reviewer` agent, refute posture, before done.
