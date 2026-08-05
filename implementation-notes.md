# Implementation notes

## Plan

- Add `src/lib/worktree/remove-locked-dir.ts`: lock-retry (EBUSY/EPERM/EACCES/ENOTEMPTY) with backoff, then quarantine-by-rename into `.o8-trash`, else `'failed'`. ENOENT short-circuits to `'removed'`; non-lock errors rethrow immediately.
- Wire it into `src/lib/worktree/manager.ts` `cleanup()`: the apfs-cow branch, the F39 `rm()` fallback, and the git-worktree-remove catch (now falls through on lock-class git errors instead of throwing, then runs a best-effort `git worktree prune` after a successful fallback removal).
- Wire it into the orphan sweep inside `prune()`: skip `.o8-trash` explicitly, quarantine instead of raw `rm`, and add a best-effort retry pass over existing `.o8-trash` entries each sweep.

## Deviations

None — implementation matches the packet spec as given.
