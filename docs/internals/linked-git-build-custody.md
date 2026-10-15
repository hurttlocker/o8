# Linked Git build custody

`npm run tauri:prebuild` can create fresh generated output in a genuine linked
Git checkout without registering the checkout as an application-managed worktree.
The ordinary checkout and application-managed paths retain their existing rules.

For a linked checkout, admission proves the canonical common and administration
directories, the `.git` pointer, the reciprocal `gitdir` pointer, `commondir`, the
resolved Git paths, and unique membership in `git worktree list --porcelain -z`.
Pointer reads are bounded, reject links and foreign ownership, and retain content
hashes and file identities. The resulting receipt is immutable within prebuild
creation authority. Registration, producer admission and child acknowledgement
recheck it. A later changed registration refuses reuse and producer execution.
Successful-output disposal also rechecks the original custody before its existing
finalization guards. These are repeated observations, not a lock on arbitrary
external Git administration mutations.

This authority applies only to generated output. It creates no worktree manager
row and cannot authorize removing the containing checkout, source or dependencies.
Existing exclusions, store binding, retained failure states and holds still apply.

## Existing unknown output

A pre-existing unregistered `.next` remains a refusal, including `.next/dev` and
its lock. Git membership does not establish who wrote those bytes or whether a
writer is stopped. Do not delete, move aside or relabel the directory to make a
build pass. A stale lock does not prove quiescence.

The current explicit legacy adoption, bank recovery and retirement contract
requires an application-managed containing owner. Extending that contract to an
externally managed checkout requires a separate output-only preservation design,
including live-writer checks, retained evidence, recovery and exact finalization.
This change intentionally does not grant that broader authority. A linked checkout
with unknown existing output therefore remains blocked at that preservation
boundary after its Git custody is proved.
