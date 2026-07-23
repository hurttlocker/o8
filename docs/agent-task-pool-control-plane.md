# Agent Task Pool Control Plane

This is the implementation contract for turning the Reddit-style
manager/worker pattern into o8 primitives without creating a parallel system.
Claude remains the planner/reviewer, while lower-cost or specialized workers
run scoped tasks through the same packet, lane, lock, and review pipeline.

## Goals

1. Project-backed task briefs
   - Every worker can retrieve the current project context before writing.
   - The brief distinguishes main repo, current repo, related repos,
     instructions, locks, and output policy.
   - The brief is available through UI, API, CLI, and MCP.

2. Simple task pool
   - Existing packets and lanes become the canonical task pool.
   - UI labels are human-simple: Ready, Running, Review, Blocked, Done.
   - Agents use structured API/CLI/MCP actions instead of clicking UI controls.

3. Visible ownership
   - Locks show who owns a repo/path/task and whether the lock is stale.
   - Workers can check sibling activity before touching files.
   - Operators can archive stale locks from the project control surface.

4. Worker routing
   - Tasks carry a worker intent: light worker, heavy worker, reviewer,
     diagnostic, or orchestrator.
   - Runtime routing maps those intents to any available dispatchable adapter
     without changing task semantics.
   - Codex remains the default when no runtime is selected; production no
     longer pins every worker to Codex.

## Existing Surfaces To Reuse

- `OrchestratorPacket` is the task object.
- `Lane` is the execution instance.
- `ProjectContext` is the project brain.
- `/api/orchestrator/delegate` is the launch path.
- `/api/lanes/:id/scope` is the worker context path.
- `o8 packet scope` is the worker CLI entry point.
- `get_packet_scope` is the MCP entry point.
- `/api/projects/locks` is the visible lock source.

## Phase 1: Project Brief Everywhere

Status: implemented for API, CLI, and MCP read paths.

- Extend `PacketScope` with a `project` section:
  - project id, name, slug
  - main repo
  - current repo
  - related repos
  - project instructions
  - task brief
  - project locks
  - definition of done
  - do-not-touch rules
- Keep JSON schema backward compatible by adding fields only.
- Update `o8 packet scope --human` to print the project summary.
- Because MCP `get_packet_scope` returns the same payload, MCP workers get the
  project brain automatically.
- `o8 task brief <id>` and `o8_task_brief` return the same project-backed brief
  through the task-pool surface.

Acceptance:

- From a packet worktree, `o8 packet scope --json` returns `project.taskBrief`.
- From MCP, `get_packet_scope` returns the same project section.
- For the o8 project, `cortex-ide` remains main and `o8-mobile` can be current.
- Locks are visible in the scope payload.

## Phase 2: Task Pool Mutations

Status: read surface plus claim/dispatch/block/report mutations implemented.

Create a thin projection over packets and lanes, not a new task store.

Canonical groups:

- Ready: packet is `draft`, `queued`, or `idle` with no active lane.
- Running: lane is `launching` or `running`.
- Review: packet/lane is `awaiting_review` or `reviewing`.
- Blocked: packet/lane is `blocked`, `awaiting_input`, or `failed`.
- Done: packet/lane is `released`, `completed`, `merged`, or archived after
  release.

API:

- `GET /api/tasks` is implemented.
- `GET /api/tasks/:id` is implemented.
- `POST /api/tasks` is implemented.
- `POST /api/tasks/:id/claim` is implemented.
- `POST /api/tasks/:id/dispatch` is implemented.
- `POST /api/tasks/:id/block` is implemented.
- `POST /api/tasks/:id/report` is implemented.
- `POST /api/tasks/:id/archive` is implemented for stale cleanup/prune.
- `POST /api/tasks/:id/prune` is implemented for terminal Done / archived cleanup.

CLI:

- `o8 task list` is implemented.
- `o8 task create --title "..." [--summary "..."] [--repo <path>] [--worker heavy_worker]` is implemented.
- `o8 task brief <id>` is implemented.
- `o8 task claim <id>` is implemented.
- `o8 task dispatch <id> [--message "..."] [--model "..."] [--worker heavy_worker] [--provider kimi] [--runtime gemini]` is implemented.
- `o8 task block <id> --reason "..." [--code needs_clarification]` is implemented.
- `o8 task report <id> [--event progress] [--message "..."]` is implemented.
- `o8 task archive <id> [--reason "..."]` is implemented for stale cleanup/prune.
- `o8 task prune <id> [--reason "..."]` is implemented for terminal Done / archived cleanup.

MCP:

- `o8_task_list` is implemented.
- `o8_task_brief` is implemented.
- `o8_task_create` is implemented.
- `o8_task_claim` is implemented.
- `o8_task_dispatch` is implemented.
- `o8_task_block` is implemented.
- `o8_task_report` is implemented.
- `o8_task_archive` is implemented.
- `o8_task_prune` is implemented.

Acceptance:

- Dashboard, mobile, CLI, and MCP all read the same task pool.
- Creating or dispatching a task creates/updates a packet, not a second model.
- Claiming a packet binds it to a lane, which prevents scheduler double-dispatch.
- Archiving a stale task removes it from active ready/running/review/blocked
  pools while preserving history in Done / archived.
- Pruning a done task removes genuinely terminal rows from the visible pool by
  deleting both the terminal packet row and any terminal lane row behind it.
- Reporting blocked work appends lane/packet events.
- Non-blocking reports update the lane last-event label so the pool does not
  look stale after a progress update.

## Phase 3: Worker Routing

Status: implemented with capability-gated, multi-runtime production dispatch.

Add worker intent to packet metadata:

- `light_worker`: small edits, docs, cleanup, scripts.
- `heavy_worker`: context-heavy implementation and debugging.
- `reviewer`: code review, risk analysis, test recommendations.
- `diagnostic`: logs, reproduction, environment checks.
- `orchestrator`: decomposition and coordination only.

Routing policy maps intent to a selected runtime/model:

- MiniMax-style models: light worker.
- Kimi-style models: heavy worker.
- Claude: orchestrator/reviewer.
- Codex: default coding worker when no dispatchable runtime is selected.

Current production rule:

- `src/lib/agents/routing.ts` is the single routing resolver.
- A requested runtime is honored when `runtime-capabilities.ts` marks it
  dispatchable; missing binaries or credentials fail readiness with a
  runtime-specific remediation.
- Codex remains the fallback when no runtime is selected.
- Requested and selected provider/runtime/model values remain in routing
  metadata for audit and UI explanation.
- `open_lane`, scheduler dispatch, delegate dispatch, mission creation,
  task dispatch, CLI, MCP, and the chat-side `dispatch_codex_task` helper all
  flow through this rule before any session can launch.

Acceptance:

- Dispatch can choose worker intent independently from the selected runtime.
- The task brief tells the worker why it was routed that way.
- Task pool API/CLI/MCP results expose worker intent and selected runtime.
- Any launch-capable runtime can spawn in production after its readiness check.

## Phase 4: Control Room

Status: planned.

The UI should show the same model as the CLI/MCP:

- project brief
- task pool groups
- active locks
- worker confidence/status
- recent reports
- stale cleanup actions

The control room is a human view over structured state, not the source of truth.
