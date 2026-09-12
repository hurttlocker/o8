# Remote project operation

Status: planned implementation and operational proof. Tracking issue: [#2282](https://github.com/hurttlocker/o8/issues/2282).

The first milestone is one persistent coordinator host, one external worker, and one project. An operator dispatches a task, disconnects the laptop, and returns to the same task, healthy preview, diff, evidence, steering controls, and approval path. A later packet uses a second supported agent system while retaining project rules and reviewed result lineage.

Worker integration can proceed alongside the first-use and Linux proofs. First-use, lifecycle, and settings acceptance remain product gates. This milestone is a scoped implementation target, not a published hosted service or a promise of arbitrary runtime portability.

## Current implementation boundary

| Existing component | Evidence | Remaining proof |
| --- | --- | --- |
| Project task board | `src/lib/tasks/actions.ts` and `src/components/desktop/repo-focus/tabs/ControlRoomTab.tsx` use existing packet and lane state. | Reconnect must expose the actual remote task and workspace through that board. |
| Headless coordinator | `cli/src/commands/serve.ts` owns the headless process lifecycle. | The operational run needs a persistent host, storage, and an authenticated worker-reachable endpoint. A process launcher does not supply those operations. |
| Standalone worker | `scripts/worker/` clones a repository, runs a supported agent, pushes a branch, and reports legacy worker events. | Its `/api/worker/*` protocol must be integrated with the durable cloud job protocol. Its current poll loop waits during execution and does not cancel an in-flight run. |
| Durable cloud jobs | `src/lib/runtimes/cloud-adapter.ts`, `/api/cloud/*`, and `tests/cloud-job-spine-real-path.test.ts` cover persisted jobs, leases, event replay, diffs, and controls. | A built external worker must use those paths. Queuing an abort is insufficient evidence that the process stops. |
| Per-packet runtime selection | `src/lib/mcp/operator-handlers/mission.ts` accepts a registered runtime when dispatching work. | A later packet must demonstrate supplier continuity with project rules and reviewed result references. One successful remote runtime does not establish this. |
| Durable schedules and event watches | `src/lib/automations/watch-store.ts`, `fire-runner.ts`, and `runner.ts` persist fires and dispatch project-associated lanes; `tests/automation-watch-real-path.test.ts` covers recovery and deduplication. | Prove one bounded event-driven follow-up while the laptop is disconnected. Dispatch creates a lane, not a task-pool card; the operator must be able to find its project association and review state. |

These are source and test boundaries. The milestone stays incomplete until an operator-visible run proves the full outcome.

## Build order

1. **Connect the existing worker** ([#2278](https://github.com/hurttlocker/o8/issues/2278)). Resolve a cloneable repository source and pinned base revision before claim. Preserve project, task, packet, lane, job, branch, and commit associations. Use the existing scoped cloud-worker keys, leases, event stream, and control acknowledgements. Control polling and lease renewal continue while the child runs; unsupported capabilities refuse explicitly. Preserve or version legacy compatibility.
2. **Keep the workspace attached to its task** ([#2279](https://github.com/hurttlocker/o8/issues/2279)). Compose the governed service, port, health, preview, and cleanup work in [#1725](https://github.com/hurttlocker/o8/issues/1725) with cross-device continuity in [#1727](https://github.com/hurttlocker/o8/issues/1727). Workspace links target the executing workspace or explain their limitation. Previews and evidence resolve the authorized task and execution attempt, including after reconnect.
3. **Prove operation and supplier continuity** ([#2280](https://github.com/hurttlocker/o8/issues/2280)). Run the first remote task with one supported runtime, then use a second existing runtime for a later packet in the same project. The second runtime may run through another existing placement. This does not require a second executor in the standalone worker, live process migration, or provider-session translation.

## Acceptance run

Use a disposable fixture repository and an existing authorized environment. Record coordinator, worker, and client roles separately. Before an operational run, select the persistent host, private service access, runtime credentials, storage, and cleanup bounds through their existing authorization paths. Local fixtures can prepare the proof without paid provisioning; they cannot establish live remote usability.

| Scenario | Required observation |
| --- | --- |
| Dispatch and laptop disconnect | Work continues on the external worker. Reconnect reaches the same project task, brief, state, preview, diff, logs, evidence, and controls. |
| Coordinator restart | Persisted task, job, evidence, and pending review remain consistent after recovery. |
| Worker disconnect and lease loss | Recovery is bounded. An old execution owner cannot publish accepted completion or merge evidence after reassignment. |
| Steer and abort during execution | A supporting runtime receives the control, or returns an explicit limitation. Abort stops the owned process tree and settles visibly. |
| Review and moved HEAD | Approval stays with the operator and the reviewed commit. Changed work cannot reuse stale approval. |
| Second runtime | A later packet keeps the project rules and result references through existing per-packet runtime selection. The effective runtime and unavailable capabilities remain visible. |
| Project event while disconnected | The persistent host's existing scheduler consumes one authorized state/check event and creates one governed follow-up lane with project rules and association. Reconnect exposes the source fingerprint, fire, lane, and review outcome. Replayed events do not duplicate the accepted action, and pause or expiry prevents further work. |
| Service access and cleanup | Preview access is authenticated and packet-scoped. Service failure, cancel, and cleanup invalidate stale routes and leave no owned process running. |

Attach commands and source/build versions, identity and commit receipts, and operator-visible evidence. Measure time to useful content after reconnect, click count, manual intervention, attempts, review and rework, elapsed time, and accepted quality. Use [#2163](https://github.com/hurttlocker/o8/issues/2163)'s interaction criteria under active output. Record attributable API spend or subscription capacity only where measured; unknown values remain unknown. A subscription allowance does not imply a per-token dollar saving.

An acceptance failure remains open with a receipt and an owner. Link lifecycle failures to [#2197](https://github.com/hurttlocker/o8/issues/2197), settings propagation to [#2217](https://github.com/hurttlocker/o8/issues/2217), and cost/capacity measurement to [#1791](https://github.com/hurttlocker/o8/issues/1791). A child checkbox becomes complete only after closure and release; the tracker also requires the operational proof.

## Broader direction

The project workflow should survive changes of agent system and execution environment. Each runtime retains its own capabilities; the shared contract carries task identity, project rules, evidence, recovery state, and approval authority. Execution locality and inference locality must be described separately. Privacy, portability, quality, and cost claims require evidence from the actual route.

[#1690](https://github.com/hurttlocker/o8/issues/1690) remains the broader portable-environment work for placement policy, caches, suspension, and migration. Fleet pools, autoscaling, managed hosting, and multi-operator workspaces remain later. The first proof reuses the project board, task pool, runner, durable queue, runtime registry, and governance system already in the repository.
