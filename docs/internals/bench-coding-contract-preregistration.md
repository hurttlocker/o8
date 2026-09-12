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

### 2026-09-12: paired acceptance enforcement

The paired collector now records terminal classification separately from protocol
acceptance. A completed process is accepted only when it produced a nonempty diff,
the contract-first arm wrote an observable treatment contract, and independent
TypeScript and touched-file ESLint checks passed. Any failed worker turn is invalid
under this paired protocol. The receipt keeps the terminal status, mechanical
evidence, acceptance decision, and every rejection reason.

Paired judging rechecks the persisted mechanical evidence and the diff bytes for
exactly one receipt in each of the four conditions. It does not trust a stored
`outcome: valid` value by itself, and it excludes the whole task when any arm is
missing, duplicated, or rejected. The rejected receipts remain in the collection,
and the judging receipt records each exclusion. No arm is replaced and the original
task denominator remains visible.

This clarification applies to new collections and new judging receipts. Published
receipts are not rewritten. The separate governed shipped-output experiment keeps
its declared rule that a terminal product failure is measurable and scorable.

### 2026-09-12: fixed participant count before recollection

Every paired arm uses one worker context, and each independent judge uses one
reviewer context. The common briefs explicitly prohibit helper agents, delegation,
and additional model calls. This limit overrides general delegation guidance in
the working environment and applies equally to raw and contract-first arms.
Ordinary local inspection and verification tools remain available.

This clarification was recorded before collecting a new measurement. It does not
change the treatment, task inputs, time bounds, rubric, or historical receipts.
Prompt delivery is checked through the collection and judging entry points;
that check proves the instructions were supplied, not that a model obeyed them.

### 2026-09-12: isolated paired-only execution

The runner now has an explicit `--paired` modifier for preflight, collection,
judging, and the combined phase. Paired-only execution does not read or change
the live approval setting, probe the app, or launch end-to-end missions. Its
receipt marks end-to-end data as `not-collected`. Full and standalone end-to-end
commands retain their existing phase selection and control-plane behavior.

Each paired arm and judge receives an owned APFS copy-on-write clone of the
preflight-checked `node_modules` directory instead of a symlink. Worker identities
also include the immutable run ID, so a new run cannot resume a stopped or archived
session from an earlier run. This dependency and identity hardening applies to
paired arms and judges whether the runner invokes them from a paired-only or full
phase. Existing worktree paths are preserved and cause a refusal; the operator
must use a new run ID rather than replace them.

Historical v2 collection receipts remain readable and are interpreted as full
runs. Those receipts predate the new dependency and worker identity fields, so
they cannot prove that their already-collected arms used owned clones or
run-specific workers. They also lack pinned runtime settings, so a new judge
phase can inspect them but refuses to launch judges from them.

These isolation and identity changes do not alter the intervention or scoring.
The three historical tasks and bases, four arms per task, one 2,400-second turn,
two blinded judges, rubric, invalid-arm retention, and greater-than-one-point
decision rule remain fixed. No new quality score was collected for this amendment.
