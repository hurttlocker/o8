/**
 * Review-target error codes, in a module with no Node imports so a CLIENT
 * surface can name them. `review-target.ts` itself reaches for `node:fs` and
 * `node:child_process`, which must never enter the browser bundle.
 */

export const BRANCH_UNRESOLVED_CODE = 'branch_unresolved' as const;

/**
 * #2144 — the lane's checkout is GONE, not merely unresolvable. Ordinary
 * cleanup (a forced worktree removal, an orphan sweep, a repo reset between
 * runs) takes the directory out from under a lane that is still open, and every
 * read of that lane then fails. The operator needs to tell that apart from a
 * transient load failure, because the two have opposite remedies: this one is
 * unrecoverable and the lane can only be discarded.
 */
export const WORKTREE_MISSING_CODE = 'worktree_missing' as const;

export type LaneReviewTargetErrorCode =
  | typeof BRANCH_UNRESOLVED_CODE
  | typeof WORKTREE_MISSING_CODE;
