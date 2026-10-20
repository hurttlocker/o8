# Harness refinement implementation checkpoint (#4010)

This is an **incomplete, held implementation**, not a successful live experiment.
The requested outcome remains writable o8 coding-task adaptation end to end.
Read-only analysis and fixture editors are not substitutes for that outcome.

## Relationship to existing work

Epic #3985 and draft #3987 (head `90455fe63d559b1a88239c18c913826d364d665c`)
contain the earlier offline behavioral comparison and deterministic-composition
foundation. Their historical acceptance denominator is unchanged. #4010 adds
independent implementation and observed-live gates, each 0–100; no averaging or
carryover. This checkpoint was developed from main
`d630c3c45d696c8a41c914e30c75a0090a5901c8`. It neither replaces nor claims to ship
#3987. Reconcile/stack the foundation dependency before promotion.

## Implemented protocol and persistence

`src/lib/harness/improvement` schedules baseline, invariant/domain proposals,
candidate probes, evidence-conditioned composition, fresh successor execution,
blind existing-output selection and reflection. Parallel mode represents
independent width with a shared reference; scheduling is currently serialized,
not concurrent provider dispatch. Sequential mode carries composed harnesses
within a task. The next task starts the original baseline and retrieves scoped
prior lessons with adopted harness contents and execution citations.

The optional editable surface is instructions, memory, skills and tool guidance,
not permissions, evaluator, acceptance criteria or executable policy. Current
protocol types do not themselves install these into a worker filesystem.

Snapshots are replay-validated and stored in a bounded private append-only
hash chain with compare-and-swap, fsync and atomic no-replace publication.
Unknown outcomes retain their reservation; reconciliation cannot erase known
spend. Invalid terminal model payloads consume a failed stage with observed
usage retained. A journal hash is corruption detection, not authentication
against a malicious actor with the same OS identity. Interrupted publication
scratch fails closed and needs explicit reconciliation. Explicit ready-state lesson revocation uses an append-only, content-bound event
replayed at its original record position. Automatic revocation is not implemented.

All deterministic tests are protocol fixtures, not learned coding improvements.
Native provenance declarations are not authenticated provider proof.

## Reachable production boundary

The authenticated `/api/harness` service exposes operator-only
`refinement_prepare`, `refinement_status`, held request reservation, explicit
revision-bound `refinement_revoke_lesson`, and isolated first-packet preparation. Preparation requires a real
accepted contract, its complete digest, exact canonical repository and current
HEAD matching the manifest. Preparation persists state but creates no mission,
packet, runtime session, provider call or approval grant. `refinement_launch`
fails held before dispatch. Worker credentials cannot invoke these actions.

## Remaining writable execution work

The correct route is scheduling → `launchPacketWithStorageAdmission` → durable
lane `launch_session` → runtime launch. Direct runtime launch is not admission.
The existing `single-attempt` and controlled-task policies are read-only and must
not be broadened to obtain writable access.

A production writable adapter still needs all of:

1. A dedicated disposable app-data/control-plane namespace, separate from the
   user's running app and mission registry; exact experiment-owned packet IDs.
2. Durable explicit launch grant covering source/contract/provider/model/effort,
   permission policy, complete stage count, time/token/cost bounds and expiry.
   Operator authentication or a submitted manifest is not this grant.
3. Frozen base validation after lane preparation/rebase, before any process
   spawn; effective model/effort revalidation after mutable routing defaults.
4. Actual optional harness mounts with content digests, immutable core exclusion,
   output collection and no automatic retry/recovery/carrier fallback.
5. Verified read/write/network confinement, physically unavailable held-out
   grader assets, and separate evaluator storage/execution authority.
6. All-stage budget reservation, pending/unknown accounting, cancellation and
   reconciliation across worker and model-stage adapters.
7. A sealed independent held-out and no-op negative-control evaluation joined
   only after composition, with matched compute baseline and preregistered
   improvement/regression/inconclusive criteria.

No production carrier has been independently validated for this checkpoint.
Native workspace-write alone is not a read sandbox. No sandbox bypass or
unsafe fallback is permitted. Live acceptance therefore remains held; this
does not block source-level tests. No experimental provider calls were made.

## Upstream provenance

Design inspected against Google Harness² source commit
`1cfe254e8d25b15f37048c3730134686abe60335`, particularly recursion, proposer,
library, selection and ledger, and paper https://arxiv.org/abs/2610.14224.
This is an original o8 implementation of the algorithmic structure, not a port
of upstream unsafe sandbox/network defaults. Source:
https://github.com/google-research/harness2 .

## Source safety integration status

The durable stage driver persists a reservation before invoking an adapter,
records transport observations before derived model state, and refuses automatic
redispatch after a restart with an outstanding reservation. A separate Codex
bounded-model mode excludes auxiliary prewarms, ambient prompt additions,
unsupported-model retries and shared app bridges before effects; it is not itself
a confinement proof. The native adapter requires a separate trusted host carrier
verifier and exact launch admission. Neither exists by default.

Experiment packet IDs have immutable manifest/request bindings outside worker
checkouts. Dispatch checks effective routing before storage/provider work, and
lane checks guard recovery and post-rebase/pre-spawn source pins. The launch guard
still refuses all experiment launch pending a real grant verifier and carrier.

The supported edit surface is four textual context fields only. This checkpoint
does not dynamically modify executable scripts, plugins, tool implementations,
subagent implementations or the permission/evaluator core. Expanding those
surfaces would need their own validated mount and review contracts. Text stored
in a receipt is not proof it affected a real worker; live mount evidence remains
required for acceptance.

Native turn receipts currently identify o8's effective pre-spawn model/effort
configuration, not an authenticated provider-reported served-model revision.
Transport attempts label that evidence explicitly and leave provider-reported
model unknown. Subscription availability, quota and actual dollars are not
inferred from a login or those launch pins.

## Dedicated first-packet preparation

A filesystem-only namespace initializer creates private disposable app state and
returns environment pins for a fresh child process. It never switches the current
application's environment. The child verifies the immutable namespace marker,
captured database path and absence of existing missions/lanes. A deep-frozen,
content-bound WeakMap capability supplies a deterministic reserved packet ID to
ordinary mission construction; JSON or model payloads cannot supply it. The
capability is checked before preparation and consumed under the existing state
lock. All packets remain held with merge hold and no Brain enrichment. Partial
preparation needs reconciliation rather than retries or destructive reset.

This namespace is intentionally single-use for one held packet. It does not yet
append successive stages to a mission, collect authenticated writable execution
receipts, or run the end-to-end experiment. Four text fields are rendered into
the exact held packet prompt and hashed; that is not a filesystem mount nor proof
of actual worker consumption. Those gaps keep full execution acceptance open.

## Missing authoritative writable execution evidence

Existing records cannot yet produce a trusted successful refinement receipt:

- `owned-session/store.ts` captures HEAD before asynchronous launch preparation.
  Packet prompt construction and `runtime/actions.ts` add context after the held
  prompt is hashed. The eventual `run.prompt` is not linked to an immutable
  post-preparation source tree and complete effective mount manifest.
- `single-attempt` remains read-only. Ordinary writable run ledgers are useful
  observations, not a permanent refinement-specific one-session/one-run grant.
- Completion handoffs use active-session liveness. Whole retained-process-tree
  clearance requires `probeOwnedSessionProcessQuiescence`, including every
  required primitive and identity check; a root exit alone is insufficient.
- Completion handoff identities/head/tree do not bind immutable candidate bytes,
  prepared source, effective prompt/mount or independently enforced permissions.

A future reviewed producer must durably bind the exact experiment/request,
mission/packet/lane/session/run, storage epoch/owner generation, authorization
consumption, carrier policy, post-preparation HEAD/tree, final prompt bytes and
complete mount manifest immediately before spawn. After launch, append exact
process identity. The authority store must be inaccessible to the worker, not
merely another same-user file. After terminal observation, hold lifecycle
ownership, prove complete process-tree clearance, freeze artifact bytes, then
re-read ownership/source/clearance before write-once publication and journal CAS.
Unknown, ambiguous or contradictory observations must remain held.

Only that collector-produced receipt can authorize additive same-owned-mission
held packet admission. Generic engine `native` labels and current completion
handoffs are insufficient. The next source phase must add that producer/collector
and an additive locked admission primitive, not clone stale packets or reuse
`createMission` to supersede a mission. Carrier enforcement and real process
quiescence require validation on a legitimately supported isolated host.
