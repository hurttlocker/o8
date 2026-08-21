# Implementation notes

## Plan

- Add an optional `runtime` only to the `dispatch_mission` MCP/type/HTTP surface.
- Persist an explicit override onto every not-yet-launched queued packet before asynchronous admission or synchronous scheduling, recomputing the packet's full worker-routing receipt.
- Prove the fix through the MCP handler, real dispatch route with an idempotent replay, persisted mission state, scheduler/lane launch, and the real backend readiness probe.

## Edge-case review

- `src/lib/lane/reconcile.ts`: set aside; reconciliation reads the launched lane's already-selected runtime and does not participate in dispatch selection.
- `src/lib/lane/commands.ts`: set aside; `open_lane` and `launch_session` receive the scheduler-selected runtime. Existing error/rethrow and archive behavior remains unchanged.
- `src/lib/lane/archive-summary.ts`: set aside; archive summaries do not read dispatch inputs or packet routing.
- `src/lib/auth/principal.ts`: set aside; the real route test preserves the existing operator-auth boundary and null-sentinel behavior.
- `src/lib/agents/codename.ts`: set aside; codename hashing and loop exit are independent of runtime selection.
- `src/lib/lanes/collapse-archived-by-task.ts`: set aside; archived-lane grouping does not mutate packet routing.
- `src/lib/analytics/server.ts`: set aside; telemetry failure isolation is unrelated to dispatch admission.

## Deviations

- Replaced stale implementation notes inherited from an earlier packet with notes for issue #1794; the file is packet-scoped review evidence.
