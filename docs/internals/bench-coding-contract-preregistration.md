# Coding benchmark contract-first pre-registration

This protocol was written before collecting a contract-first measurement. The
three historical tasks, their bases, and the four-part quality rubric remain
fixed. Any post-collection change belongs in a dated deviations section rather
than an edit to the protocol.

Every collection has an immutable run ID. The runner refuses to overwrite a run
that already has a collection receipt; repetitions require a new run ID.

## Question

Does a structured pre-edit task contract improve first-diff quality for each of
the two initial runtime families while preserving requirement coverage?

## Arms

Each task has four arms: raw and contract-first for runtime A, then raw and
contract-first for runtime B. Runtime identifiers are the fixed engine IDs
encoded by the runner. Every pair receives the same issue text, base commit,
repository instructions, one worker turn, and 2,400-second wall-clock bound.
There are no follow-up repair turns and no operator intervention. The treatment
adds only the versioned task-contract instructions and deviation recording used
by production packet prompts.

An arm is invalid when it produces no diff, its worker turn fails, the treatment
contract is not observable, or independent TypeScript or touched-file ESLint
checks fail. Invalid arms remain in the receipts and cannot be silently replaced.

## Blinding and judging

All four valid diffs for a task are scrubbed and shuffled into neutral labels.
Two independent judges score the same blinded set. A task enters the result only
when both judges return one complete verdict per label. Condition mapping is
unsealed only after all verdicts have been written.

The fixed 0-10 rubric weights correctness, scope discipline, robustness, and fit
equally. A shorter diff receives no credit unless requirement coverage and
correctness are equal.

## Decision rule

A paired win is decisive only when the contract-first score exceeds the raw score
by more than one point. The intervention clears the product bar only if it wins
decisively on at least two of three tasks for each initial runtime. Scores at or
above 9.0 are also reported as excellent-output counts, with their denominators.

The historical tasks were visible when this intervention was designed, so this
run can show whether the known failure recurs but cannot establish generalization.
A fresh sealed holdout is required before any broader product claim.

## Deviations

### 2026-08-02: governed shipped-output success criterion

Run `final-v3` exposed a contradiction in the separate governed shipped-output
experiment. The experiment required `requireApproval=always`, prohibited the
runner from acting as the operator, and still required a merge-ready result.
Those constraints made the governed arm unable to satisfy its success criterion.

The governed artifact is now the diff at the current HEAD when
`assessDurableApprovedReview` returns approved, including its contract-coverage
assessment. A merge, passing merge preview, and operator approval are outside
the measurement. Rejected reviews enter the normal refix-and-review loop, with
three total review attempts. If no durable approved review exists after the
third attempt, the arm remains invalid with its findings and the explicit bound
in the receipt.

The twelve paired 2x2 arms from `final-v3` remain unchanged. Any repeat of only
the shipped-output experiment uses the standalone end-to-end flags and a fresh
immutable run ID, so the paired collection is neither recollected nor overwritten.
