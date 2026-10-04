# Sustained work and workspace retirement

Execution tracking: [#3226](https://github.com/hurttlocker/o8/issues/3226).
Storage tracking: [#2203](https://github.com/hurttlocker/o8/issues/2203).
The acceptance program started on 2026-10-04.

## Outcome

Run useful work repeatedly through o8 on macOS and Linux. Preserve the source,
task context and evidence needed to continue or recover. Retire disposable
workspaces, dependencies, build output and temporary artifacts through their
existing owners under an authorized retention policy.

Use o8 for worker execution, completion and recovery wherever supported. A
failed capability needs a recorded failure, a focused repair and a retry through
the o8 entry point. Keep the existing independent helper available until native
execution and recovery parity are proven. Removing that helper is a separate
operator decision.

## Acceptance contract

There are twenty checks. Each accepted check contributes five percentage points.
The initial program completion is 0/20 (0%). This measures acceptance of the
complete lifecycle, including current proof for existing implementations.

A check requires its exact source revision, issue and pull request, raw
verification receipts, and applicable review and merge evidence. A dispatch,
plan, test result, closed issue or merged pull request alone earns no credit.
Report source implementation, installed acceptance and release inclusion
separately. Reach 100% only after all checks pass, including installed acceptance
and repeated cycles on both platforms. If scope changes, version and explain
the denominator.

The private execution ledger records accepted checks and raw evidence locations.
Public tracking links reviewable changes and sanitized receipts. Keep private
handoffs, session identifiers, machine details and raw sensitive logs out of
repository artifacts.

## Ordered checks

| ID | Accepted outcome |
|---|---|
| A1 | Inventory resource categories and owners on macOS and Linux. Distinguish apparent and allocated bytes, observed free space, and guest storage from host backing storage. |
| A2 | Register worktrees, clones, temporary output, dependency and cache donors, and owned processes at creation. Persist each resource's identity and retention state. |
| A3 | Reconcile canonical completion and release state after restart and stale client writes. Preserve newer generations and verify [#2723](https://github.com/hurttlocker/o8/issues/2723) plus the existing Stop and Close fixes. |
| B1 | Completion writes a compact private handoff with outcome, source revision, remaining work, evidence and recovery instructions. |
| B2 | Preserve and verify dirty, unpushed, untracked and unique ignored content. Recovery Git bundles contain the required parents and objects. |
| B3 | Retain required release, failure and acceptance evidence under explicit holds and bounded policies. Use supported provider interfaces for transcript retention. |
| B4 | A fresh worker resumes successfully after the original workspace is retired, including unfinished preserved work. |
| C1 | Resolve [#2948](https://github.com/hurttlocker/o8/issues/2948): remove generated internal links without following their targets; protect external or uncertain links and release assets. |
| C2 | One owner-aware, journaled and idempotent retirement path serves app and agent callers. Recheck liveness and identity before removal, then persist measured receipts. |
| C3 | Completion, supersession and bounded restart or maintenance reconciliation retire eligible work under policy without repeated prompts or model calls. Holds remain visible and affect only their dependent resources. |
| C4 | Ship attempts reuse bounded compiler caches. Successful and superseded attempts release disposable output while preserving required donors and designated release evidence. |
| D1 | A small real fix runs through o8 implementation, verification, independent review, integration and recoverable cleanup without the independent helper. |
| D2 | Prove composer Fast mode's requested and effective shared checkout, branch and scoped ownership through a real worker turn, including persistence, supported and unsupported handling, and honest usage semantics. |
| D3 | Compare ordinary isolated mode and composer Fast mode on matched useful work: time to verified completion, correctness, retries, available usage evidence and storage growth. Preserve model and effort defaults. |
| E1 | Verify [#2125](https://github.com/hurttlocker/o8/issues/2125) through real dispatch. Incremental growth and concurrent reservations admit fitting small jobs and hold jobs that cannot fit with actionable receipts. |
| E2 | Appropriate remote builds and tests have one heavy job owner per host. Disconnect and reconnect preserve ownership; an unavailable host does not block independent eligible cleanup elsewhere. |
| E3 | External worker adoption has explicit ownership and capability boundaries. Unsupported transcript purge and unknown resources remain held without blocking known eligible workspace cleanup. |
| F1 | Twenty consecutive task, finish and restore cycles independently on macOS and Linux show bounded retained growth. Cover interruption, owner return, PID reuse and missing paths. |
| F2 | Installed user and agent entry points show the same completion state, retained evidence and reclaimed space for the delivered revision. Record release inclusion and any publication authorization separately. |
| F3 | Reconcile issue, pull request and release receipts. Demonstrate a small fix and larger multi-worker workflow through o8. Declare helper retirement readiness only after every other check passes. |

Composer Fast mode uses workers in the current orchestrator checkout with
non-overlapping path ownership and one orchestrator-owned review and commit. It
does not select a faster inference service tier. Its active branch may be an
issue branch; Fast mode does not require main. Naming follow-up:
[#3240](https://github.com/hurttlocker/o8/issues/3240).

## Execution order

1. Reconcile existing work, owners, completion state and release inclusion.
2. Fix generated-link cleanup and canonical lifecycle correctness dependencies.
3. Prove one complete handoff, preservation, retirement and fresh-worker restore
   slice through the existing lifecycle managers.
4. Extend completion triggers, retention budgets, ship reuse and cross-host
   coverage.
5. Prove composer Fast mode behavior, matched workflow parity and repeated
   acceptance cycles.
6. Verify the installed entry points and reconcile the final receipts.

Reuse existing issues and managers. Add a focused child only for uncovered,
actionable work. Do not create a competing cleanup system or broad new epic.

## Ownership and retention

Task outcome and resource retention are separate persisted states. A finished
task can still have active consumers, unfinished preservation or required
acceptance evidence. Age can select a candidate, but it cannot authorize
deletion. An archived conversation does not prove transcript or workspace bytes
were reclaimed.

Before retirement, acquire ownership, validate the exact resource and process
generation, verify preserved content, and recheck immediately before removal.
A PID alone is insufficient identity. Journal partial results and reconcile the
owning registry with the filesystem. If an owner returns or identity changes,
hold that resource and keep completed receipts.

For already-absent paths, reconcile registry and recovery references without
claiming deletion or reclaimed bytes. Preserve dirty and unpushed work, unique
ignored assets, nested worktrees, shared donors and unresolved failure evidence.
Unknown resources remain held. Same-volume recovery copies protect against
cleanup mistakes; they do not protect against loss of that volume.

Use supported provider lifecycle interfaces for conversations and transcripts.
Report unsupported retention or purge explicitly. Such a limitation does not
block independent eligible workspace cleanup.

## Verification and delivery

Each code change follows the repository's focused commit, pull request and
required check process. Use independent review for destructive and lifecycle
changes. Verify through real user and agent entry points with persisted state.
Keep heavy builds and test suites on appropriate authorized execution hosts,
with fresh host-specific storage checks and one heavy job owner per host.

Existing release, acceptance and recovery holds remain until their dependencies
are verified. New release publication, version changes and helper removal remain
separate operator decisions. A prepared delivery can proceed through review
while those final gates remain open.

After each accepted check or meaningful blocker, record check IDs, exact
revision, issue and pull request, raw evidence, percentage, next action and
per-host storage. Report allocated workspace bytes, retained archive bytes,
observed free-space change and current free space separately. Disclose shared
allocation and concurrent activity instead of claiming an exact reclamation
ratio.
