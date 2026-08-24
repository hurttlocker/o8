# Review recovery: the shared invariant behind #1844 and #1856

An incident-proof note for two review-gate defects that presented as opposites and turned
out to be the same invariant violated at two different transitions. This note records the
symptom, the invariant, the shape of the shipped fix, the regression files that hold it,
and the releases that carry it — so the next person to meet one of these states does not
have to re-derive the class from a stalled lane.

- Issue [#1844](https://github.com/hurttlocker/o8/issues/1844) — *A steered packet can become permanently unmergeable: the second pass never re-runs at the new HEAD*
- Issue [#1856](https://github.com/hurttlocker/o8/issues/1856) — *Second pass agrees, merge never dispatches: a fully-authorized packet parks in reviewing with no attempt and no failure recorded*

The issue links are the upstream record; the code paths described below are merged and
released. Their open or closed state does not change this durable account of the defect
class and what shipped against it.

## Background: what the gate demands

A packet merges only when a durable approval authorizes the **current** HEAD. The check
lives in `assessDurableApprovedReview()`
([`src/lib/lane/durable-review-approval.ts`](../src/lib/lane/durable-review-approval.ts)):
among approvals whose `reviewedHeadSha` equals the worktree HEAD, it accepts one only if
it does not require a blind second pass, or requires one and has `secondPassAgreed` set.
Otherwise it refuses with *"The approved AI review does not authorize the current HEAD."*

That gate is correct, and neither defect is a hole in it. Both defects are about the
transitions that are supposed to *feed* it.

## Symptom A — #1844: authorization that can never be reached

A steer lands a new commit after the last review turn finished. A reviewer records an
approval at the new HEAD; the approval requires a blind second pass. No review turn ever
starts at that HEAD, because the blind second pass was scheduled only from inside a review
turn and the worker process that would have carried one has already exited.

The observable state: one approval at the current HEAD, `secondPassAgreed` unset, no
pending approvals, every merge-preview check passing, and `approve_and_merge` refusing
with the message above. The lane sits in `reviewing` indefinitely. The gate tells you it
refuses, but nothing explains that the condition it wants can no longer be produced.

The operator's only escape was an out-of-band merge, which leaves stale lanes and phantom
approvals behind — so the cheap recovery path (steer a warm session instead of
redispatching) was effectively unusable.

## Symptom B — #1856: authorization that is reached and then dropped

The inverse state. The second pass *did* re-run, *did* agree, and the flag is persisted.
`reviewedHeadSha` equals HEAD exactly, merge preview reports `wouldMerge: true` with no
blockers, and the lane still parks in `reviewing` — with no `merge` event, no failure
event, and no status change. Observed live for roughly five hours across fifteen review
turns and twelve recorded verdicts.

In [`src/lib/lane/auto-review.ts`](../src/lib/lane/auto-review.ts), marking agreement and
dispatching the merge were two adjacent statements with nothing between them written to
the ledger. Agreement was durable; the dispatch was not. The ledger therefore could not
distinguish "the process ended before the dispatch was reached" from "the dispatch ran,
failed, and the result was only logged to the console." Either way the lane looked alive
and was not.

## The shared invariant

> **An actionable review state must never exist only in memory. Every transition that a
> later merge depends on — scheduling the successor review, and dispatching the merge —
> must leave a durable receipt, and any lane loaded in a non-terminal review state must be
> reconciled against those receipts on the way in.**

Read that way, the two issues are one class seen from either side:

| | #1844 | #1856 |
|---|---|---|
| Transition that vanished | scheduling the blind second pass at the new HEAD | dispatching the merge after agreement |
| Durable evidence left behind | none — nothing recorded that a pass was owed | none — agreement persisted, dispatch did not |
| What the operator sees | an explicit refusal with an unreachable condition | silence: a live-looking lane and no attempt |
| Recovery before the fix | out-of-band merge | out-of-band merge |

The distinction that matters is not "refused" versus "silent." It is that in both cases the
work item existed in a running process, the process ended, and nothing on disk knew the
item was owed. A restart, a poll, or a later drain had no way to notice.

## Shipped fix shape

Three moves, applied to both transitions.

**1. Scheduling the successor review became a first-class, recorded operation.**
`rearmPendingSecondPassApproval()` was extracted into
[`src/lib/lane/second-pass-review-rearm.ts`](../src/lib/lane/second-pass-review-rearm.ts)
and is now invoked from the review-recording path in
[`src/lib/orchestrator/operator-mission-service/review.ts`](../src/lib/orchestrator/operator-mission-service/review.ts)
whenever an approval requires a second pass and the verdict did not come from an
auto-review surface — that is, from the same act that creates the obligation, not from
inside a review turn that may never start. Success writes a `second_pass_rearmed` lane
event. Every failure to schedule — no schedulable approval, a lane no longer in
`reviewing`, an enqueue that throws — surfaces a durable review-queue blocker carrying the
reason, and the reason is returned to the caller as a warning. A pass that cannot be
scheduled is now visible instead of merely absent.

**2. Agreement and merge dispatch became one recorded transition.**
[`src/lib/lane/second-pass-merge-dispatch.ts`](../src/lib/lane/second-pass-merge-dispatch.ts)
replaced the bare `dispatch()` call. It claims the dispatch durably inside a SQLite
transaction over the lane's own event rows, writes `merge_dispatch_attempted` **before**
invoking the merge, and settles with `merge_dispatch_succeeded`, `merge_dispatch_deferred`,
or `merge_dispatch_failed` plus an operator blocker. The claim is bounded — a stale
attempt is reclaimable after a lease expires, attempts are capped, and a recoverable
outcome (an inconclusive branch probe, an unreachable fetch, a typecheck auto-retry) defers
rather than burning the budget. A crash between any two of those statements leaves a
receipt the next pass can act on.

**3. Lanes are reconciled on the way in.**
[`src/lib/lane/review-stall-reconcile.ts`](../src/lib/lane/review-stall-reconcile.ts) runs
from the review-queue drain before any review is claimed — at most once every 30 seconds
— and scans lanes in `reviewing`
for the two shapes: **(A)** an approval that required a second pass, got agreement, matches
HEAD, and has no recorded merge dispatch — re-fired through the recorded dispatch, so the
retry itself leaves a receipt; **(B)** a current-HEAD approval still awaiting its blind
second pass with no live queue row to run it — requeued with a `review_requeue_reconciled`
event, and after a bounded number of requeues escalated to a durable blocker instead of
looping. Path A is deliberately narrow: only approvals that required a second pass and got
agreement are auto-dispatched, because that is the only merge that is supposed to fire
without an operator. A plain approved review still merges through explicit
`approve_and_merge`.

Supporting the same guarantee: claimed review rows that never run a turn now persist an
explicit `review_skipped` receipt
([`src/lib/lane/review-queue-settlement.ts`](../src/lib/lane/review-queue-settlement.ts)),
and the lane event vocabulary in [`src/lib/lane/types.ts`](../src/lib/lane/types.ts) gained
`second_pass_rearmed`, `review_skipped`, `review_requeue_reconciled`, and the four
`merge_dispatch_*` verbs. Alongside these, the merge execution path itself was hardened to
retry inconclusive branch probes and to prove detached checkout state rather than assume it
([`src/lib/lane/worktree-merge-git.ts`](../src/lib/lane/worktree-merge-git.ts),
[`src/lib/lane/worktree-merge-branch.ts`](../src/lib/lane/worktree-merge-branch.ts)) — a
recorded dispatch is only as useful as the merge it reports on.

A code-form walk-through of the state transitions is deliberately not included here; this
note is the prose account only.

## Existing real-path regression files

Per the repository's reachability rule, each of these drives the production entry point
against persisted state rather than exercising a guard with direct arguments.

| File | What it drives | What it holds |
|---|---|---|
| [`tests/steered-second-pass-rearm-real-path.test.ts`](../tests/steered-second-pass-rearm-real-path.test.ts) | the real steer route and the real review-recording path, against a real git fixture and a temporary data dir | a steered HEAD approved through `submit_review` re-arms the blind pass; an approval superseded by a later rejection at the same HEAD does not |
| [`tests/review-stall-reconcile-real-path.test.ts`](../tests/review-stall-reconcile-real-path.test.ts) | the production queue drain and `reconcileReviewStalls()` against persisted rows | recovery of an authorized HEAD whose merge was never dispatched; reclaim of a stale attempted-only dispatch; deferred-recovery retry and settlement; rejection of an `ok:true` dispatch with no durable merge settlement; repair of a crash between a failure receipt and its blocker; escalation to a blocker instead of deferring forever; a durable failure receipt when recovery does not merge; a successor review running after an earlier cancellation; an explicit skip receipt for a claimed review that never ran |
| [`src/lib/lane/second-pass-merge-dispatch.test.ts`](../src/lib/lane/second-pass-merge-dispatch.test.ts) | the recoverable-outcome classifier used by the dispatch claim | which merge outcomes defer rather than fail |

Verified at `eaa21427d` (v0.1.706): all three files pass, 14 tests.

## Live control-plane proof protocol

A live proof must follow one packet through the operator control plane, preserving its lane
ID and reviewed HEAD. The code-form equivalent of the required pre-steer review state is:

```ts
setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
```

After an explicit steer changes HEAD, the durable event ledger must show this ordered
sequence for that same lane and authorized HEAD:
`second_pass_rearmed` -> `review_turn_started` -> `merge_dispatch_attempted` ->
`merge_dispatch_succeeded` -> `merge`. The final `merge` is the canonical receipt written
after merge ancestry is proven and the base branch is fast-forwarded. A missing,
out-of-order, or different-HEAD receipt does not prove recovery.

This section specifies the proof to collect; it does not claim that the live sequence has
occurred. Only a later explicit steer may authorize recording that observation and
advancing the proof marker.

## Releases

| Release | Date | Carries |
|---|---|---|
| [v0.1.704](https://github.com/hurttlocker/o8/releases/tag/v0.1.704) | 2026-08-23 | the #1844 side: blind review re-armed from the review-recording path, latest-verdict recency honored before a blind pass, and the scheduling helper extracted |
| [v0.1.705](https://github.com/hurttlocker/o8/releases/tag/v0.1.705) | 2026-08-24 | the #1856 side: recorded merge dispatch, review-skip receipts, stall reconciliation, interrupted-transition recovery, deferred recoverable outcomes, and the merge branch-probe hardening |
| [v0.1.706](https://github.com/hurttlocker/o8/releases/tag/v0.1.706) | 2026-08-24 | the current release; carries the full set above |

The versions to cite for the shipped review-recovery behavior are **v0.1.705 and v0.1.706**
— v0.1.705 is where the invariant became enforceable on both transitions, and v0.1.706 is
the release a current build actually runs. v0.1.704 is listed because the #1844 half landed
there first and the story is incomplete without it.

## What would count as a recurrence

Either of these, on a lane in `reviewing`:

- an approval at the current HEAD that requires a blind second pass, with no
  `second_pass_rearmed`, no `review_requeue_reconciled`, and no live queue row; or
- an approval at the current HEAD with `secondPassAgreed` set and no `merge_dispatch_*`
  event of any kind.

Both are shapes the reconciler now looks for whenever it runs, so a recurrence means the
reconciler did not run or did not see the lane — not that the receipt was never written.

This commit is the steered successor HEAD.

Proof state: phase-two-steered
