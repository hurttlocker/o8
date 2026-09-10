# Worker Stop recovery

Use this runbook after an operator stops a packet or when Stop returns an uncertain result. Both Stop entry points hold the packet against relaunch and target only its owned worker and managed runs. Their success receipts and cleanup behavior differ.

## Read the evidence first

Do not use reset as a diagnostic. Capture the durable state without changing it:

```bash
o8 packet info <packet-id>
o8 packet log <packet-id>
o8 packet diff <packet-id>
```

Keep the original Stop receipt when it is available. Admission of the request or an HTTP success by itself is not process-exit proof.

`packet info` reports the lane status, `lastEventLabel`, and recent events. `packet log` reads the durable event history without following it. Use the log when the decisive event is older than the recent events in `packet info`. `packet diff` establishes whether the worktree contains work that a later reset could discard.

## Identify the entry point

`o8 packet stop <packet-id>` resolves the packet to a lane and sends `verb: stop` through the lane command route. That route persists the packet hold first, confirms the worker and packet-managed runs have stopped, and then pauses the lane with `lastEventLabel: operator_stopped`. Its success result contains `ok` and a note. It does not schedule lane archive or worktree pruning.

The CLI exposes `confirmedDead` when the lane result includes `confirmedDead` or `processDead`. The lane command success branch does not currently return either field, so `confirmedDead` is normally `null`. Do not convert that null to true. Use the `kill_escalated` and `runtime_process_exit` events, plus the result note, to establish what happened.

`POST /api/orchestrator/stop-packet` calls the higher-level `stopPacket` path. After confirmed worker and managed-run death, that path holds the packet as `operator_stopped`, returns success at kill confirmation, and schedules lane archive and worktree pruning in the background. If death is unconfirmed, it returns a `kill_unconfirmed` conflict and preserves the bindings and worktree.

## What Stop proves

For an owned run, Stop acquires the session lock and compares the saved run with the expected run. The run ID, PID, process-group ID, process marker, and terminal-session identity must still match. If the run changed before the lock was acquired, Stop sends no signal. Before signaling a PID, it also verifies that the process marker and process group still belong to that run. This prevents a reused PID or successor run from being killed.

A delivered interruption and an ordinary signal failure have different records:

- If at least one signal was delivered to the exact run, the owned-run record receives `outcome: interrupted` and `interruptRequestedAt`. A later `runtime_process_exit` event keeps `runtimeOutcome: interrupted` even if the child exit itself was not clean.
- If the target was already absent, ownership changed, identity proof failed, or every signal attempt was denied, Stop does not label the run interrupted. The process can exit independently, but that is not evidence that Stop interrupted it.

The escalation ladder requests an interrupt, then termination, then forced termination. Each `kill_escalated` event records the mechanism that was actually used and whether the complete worker tree was confirmed dead. A signal being sent is not enough. Confirmation requires the process group and all tracked descendants to be decisively gone. An unknown probe or an unverified descendant remains alive for safety purposes.

## Classify the result

### Confirmed lane-command Stop

An `o8 packet stop` receipt with `result.ok: true` means the lane command confirmed its worker and packet-managed runs were stopped before it paused the lane. If `confirmedDead` is null, a `kill_escalated` event with `confirmed: true` is the process-tree evidence. A `runtime_process_exit` event with `runtimeOutcome: interrupted` shows that Stop delivered a signal to that exact run. The packet remains held, and the lane is paused. This entry point does not promise archive or pruning.

An already-dead worker can also produce a successful result without a delivered signal. In that case there are no escalation steps and no new interrupted outcome. Read the result note and existing exit event instead of inferring that Stop delivered the interruption.

### Confirmed higher-level Stop

The higher-level packet Stop reports `ok: true` and `killConfirmed: true`. The packet is held with `operatorStopped: true`, `queueState: held`, and `blockedReason: operator_stopped` before the response returns. Archive and worktree pruning can still be finishing in the background, so an attached lane immediately after the response does not overturn the confirmed-kill receipt.

### Unconfirmed stop

The higher-level Stop route returns a conflict with `kill_unconfirmed` when any worker session or packet-managed run cannot be confirmed dead. The lane command returns `ok: false`; its note identifies either the live worker or an unconfirmed managed run. In both cases the packet hold remains. The absence of a `kill_escalated` event can mean ownership evidence failed before signaling. Events with `confirmed: false` mean the attempted mechanism did not establish process-tree death.

Treat `kill_unconfirmed` as a live-worker hazard. Preserve the packet and worktree, record the receipt, and escalate for owner-verified process inspection. Do not archive, prune, rerun, or reset while any owned process remains unconfirmed.

## Choose recovery deliberately

After a confirmed stop, inspect `packet diff` and decide whether the existing work must be preserved. Use the packet's explicit rerun or reset workflow only after that decision. Reset is a lifecycle mutation, not a safer second Stop: it can retire lane and worktree state and clear the operator hold as part of a new generation. A blind reset can destroy useful work or remove the bindings needed to investigate an unconfirmed worker.

If the evidence disagrees, preserve the stricter state. A held `kill_unconfirmed` packet outranks an apparently quiet terminal, and a saved `runtimeOutcome: interrupted` proves delivery only for its exact run ID. Keep the packet held until the process owner and durable events agree.
