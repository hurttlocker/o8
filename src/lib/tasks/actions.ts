import 'server-only';

import {
  findLaneByPacket,
  getLane,
  setLaneStatus,
  updateLane,
} from '@/lib/lane/registry';
import {
  isAgentReportReason,
  normalizeAgentReportEvent,
  normalizeAgentReportMessage,
  normalizeAgentReportMetadata,
  reportAgentEvent,
} from '@/lib/lane/agent-report';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import type { AgentReportReason, Lane, LaneEventActor } from '@/lib/lane/types';
import { PRODUCTION_AGENT_RUNTIME, resolveWorkerRouting } from '@/lib/agents/routing';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import type {
  OrchestratorLaneBinding,
  OrchestratorPacket,
  OrchestratorPacketStatus,
  WorkerRouting,
} from '@/lib/orchestrator/types';
import { getProjectContext } from '@/lib/projects/context';
import { getTaskPoolTask, type TaskPoolTask } from './pool';

export type TaskMutationAction = 'claim' | 'dispatch' | 'block' | 'report';

export interface TaskMutationResult {
  schema: 'o8/task.mutation/v1';
  ok: boolean;
  action: TaskMutationAction;
  taskId: string;
  packetId: string | null;
  laneId: string | null;
  note: string;
  eventId?: string;
  statusChanged?: boolean;
  workerRouting?: WorkerRouting;
  task: TaskPoolTask | null;
}

export interface TaskMutationInput {
  actor?: LaneEventActor;
  projectId?: string | null;
  repoPath?: string | null;
}

export interface TaskClaimInput extends TaskMutationInput {
  note?: string | null;
}

export interface TaskDispatchInput extends TaskMutationInput {
  message?: string | null;
  model?: string | null;
  workerIntent?: string | null;
  requestedProvider?: string | null;
  requestedRuntime?: string | null;
}

export interface TaskBlockInput extends TaskMutationInput {
  reason: string;
  code?: AgentReportReason | null;
}

export interface TaskReportInput extends TaskMutationInput {
  event?: string | null;
  status?: string | null;
  reason?: AgentReportReason | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

export class TaskMutationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TaskMutationError';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeActor(actor: LaneEventActor | undefined): LaneEventActor {
  return actor === 'user' || actor === 'system' || actor === 'orchestrator'
    ? actor
    : 'orchestrator';
}

async function resolveTask(
  taskId: string,
  input: TaskMutationInput,
): Promise<TaskPoolTask> {
  const task = await getTaskPoolTask(taskId, {
    projectId: input.projectId ?? null,
    repoPath: input.repoPath ?? null,
  });
  if (!task) {
    throw new TaskMutationError(404, `Task not found: ${taskId}`);
  }
  return task;
}

function buildLaneBinding(
  packet: OrchestratorPacket,
  lane: Lane,
  lastEventLabel: string | null,
  workerRouting?: WorkerRouting,
): OrchestratorLaneBinding {
  return {
    tileId: packet.lane?.tileId ?? '',
    tabId: packet.lane?.tabId ?? '',
    repoPath: packet.workspaceTargetPath ?? lane.repoPath,
    worktreePath: lane.worktreePath,
    runtime: workerRouting?.selectedRuntime ?? packet.runtime,
    sessionKey: lane.sessionKey,
    laneId: lane.id,
    lastHeartbeatAt: null,
    lastEventAt: lane.lastEventAt ?? nowIso(),
    lastEventLabel,
  };
}

async function syncPacketForLane(
  task: TaskPoolTask,
  lane: Lane,
  patch: {
    status?: OrchestratorPacketStatus;
    blockedReason?: string | null;
    lastEventLabel?: string | null;
    workerRouting?: WorkerRouting;
  } = {},
) {
  if (!task.packetId) return;

  await withLockedState((state) => {
    const index = state.packets.findIndex((packet) => packet.id === task.packetId);
    if (index === -1) return null;

    const packet = state.packets[index];
    const lastEventLabel = patch.lastEventLabel ?? lane.lastEventLabel ?? packet.lastEventLabel ?? null;
    const nextPacket: OrchestratorPacket = {
      ...packet,
      runtime: patch.workerRouting?.selectedRuntime ?? packet.runtime,
      workerIntent: patch.workerRouting?.workerIntent ?? packet.workerIntent,
      workerRouting: patch.workerRouting ?? packet.workerRouting,
      lane: buildLaneBinding(packet, lane, lastEventLabel, patch.workerRouting),
      lastEventAt: nowIso(),
      lastEventLabel,
    };

    if (patch.status) nextPacket.status = patch.status;
    if (patch.blockedReason !== undefined) nextPacket.blockedReason = patch.blockedReason;

    state.packets = state.packets.map((candidate, candidateIndex) => (
      candidateIndex === index ? nextPacket : candidate
    ));
    state.updatedAt = nowIso();
    return null;
  });
}

async function ensureLaneForTask(
  task: TaskPoolTask,
  actor: LaneEventActor,
): Promise<Lane> {
  if (task.laneId) {
    const lane = getLane(task.laneId);
    if (lane) return lane;
  }
  if (task.packetId) {
    const lane = findLaneByPacket(task.packetId);
    if (lane) return lane;
  }
  if (!task.packetId) {
    throw new TaskMutationError(404, `Lane not found for task ${task.id}`);
  }
  if (!task.repoPath) {
    throw new TaskMutationError(409, `Task ${task.id} has no repo path to claim.`);
  }
  if (!task.branch) {
    throw new TaskMutationError(409, `Task ${task.id} has no branch to claim.`);
  }

  const context = await getProjectContext({
    repoPath: task.repoPath,
    projectId: task.project?.id ?? null,
  });
  const laneResult = await dispatchLaneCommand({
    verb: 'open_lane',
    repoPath: task.repoPath,
    projectId: context.id,
    branch: task.branch,
    baseBranch: context.currentRepo?.defaultBranch ?? context.primaryRepo?.defaultBranch ?? 'main',
    runtime: PRODUCTION_AGENT_RUNTIME,
    label: task.title,
    packetId: task.packetId,
    actor,
  });
  if (!laneResult.ok || !laneResult.lane) {
    throw new TaskMutationError(409, laneResult.note || `Unable to open lane for task ${task.id}.`);
  }
  return laneResult.lane;
}

async function mutationResult(
  action: TaskMutationAction,
  task: TaskPoolTask,
  lane: Lane | null,
  note: string,
  extra: Partial<Pick<TaskMutationResult, 'ok' | 'eventId' | 'statusChanged'>> = {},
): Promise<TaskMutationResult> {
  const freshTask = await getTaskPoolTask(task.id);
  return {
    schema: 'o8/task.mutation/v1',
    ok: extra.ok ?? true,
    action,
    taskId: task.id,
    packetId: task.packetId,
    laneId: lane?.id ?? task.laneId,
    note,
    eventId: extra.eventId,
    statusChanged: extra.statusChanged,
    task: freshTask,
  };
}

function buildDispatchPrompt(task: TaskPoolTask, workerRouting: WorkerRouting, message?: string | null): string {
  return [
    'You are being dispatched from the o8 task pool.',
    `Worker routing:\nIntent: ${workerRouting.workerIntent}\nSelected runtime: ${workerRouting.selectedRuntime}\nRouting note: ${workerRouting.reason}`,
    task.taskBrief ? `Project task brief:\n${task.taskBrief}` : null,
    task.summary ? `Task detail:\n${task.summary}` : null,
    message?.trim() ? `Dispatch note:\n${message.trim()}` : null,
    'Before editing, confirm the repo you are in and call out any cross-repo dependency you need.',
  ].filter((line): line is string => Boolean(line)).join('\n\n');
}

export async function claimTask(taskId: string, input: TaskClaimInput = {}): Promise<TaskMutationResult> {
  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const lane = await ensureLaneForTask(task, actor);
  const report = reportAgentEvent({
    laneId: lane.id,
    actor,
    event: 'claimed',
    message: normalizeAgentReportMessage(input.note),
    metadata: { taskId: task.id, packetId: task.packetId },
  });
  const updatedLane = report?.lane ?? updateLane(lane.id, {
    lastEventAt: nowIso(),
    lastEventLabel: 'claimed',
  }, actor) ?? lane;
  await syncPacketForLane(task, updatedLane, { lastEventLabel: 'claimed' });
  return mutationResult('claim', task, updatedLane, 'Task claimed.', {
    eventId: report?.event.id,
    statusChanged: report?.statusChanged,
  });
}

export async function dispatchTask(taskId: string, input: TaskDispatchInput = {}): Promise<TaskMutationResult> {
  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const workerRouting = resolveWorkerRouting({
    workerIntent: input.workerIntent ?? task.workerIntent ?? undefined,
    requestedProvider: input.requestedProvider ?? task.workerRouting?.requestedProvider ?? undefined,
    requestedRuntime: input.requestedRuntime ?? task.workerRouting?.requestedRuntime ?? task.runtime,
    requestedModel: input.model ?? task.workerRouting?.requestedModel ?? undefined,
    source: 'task-dispatch',
  });
  const lane = await ensureLaneForTask(task, actor);
  if (lane.runtime !== PRODUCTION_AGENT_RUNTIME) {
    throw new TaskMutationError(
      409,
      `Production agent spawning is restricted to Codex. Existing lane ${lane.id} is ${lane.runtime}; claim a Codex lane before dispatching.`,
    );
  }
  await syncPacketForLane(task, lane, {
    lastEventLabel: 'dispatch_requested',
    workerRouting,
  });

  const result = await dispatchLaneCommand({
    verb: 'launch_session',
    laneId: lane.id,
    prompt: buildDispatchPrompt(task, workerRouting, input.message),
    model: workerRouting.selectedModel ?? undefined,
    actor,
  });

  const latestLane = result.lane ?? getLane(lane.id) ?? lane;
  if (!result.ok) {
    const blockedLane = setLaneStatus(latestLane.id, 'awaiting_orchestrator', actor, 'dispatch_failed') ?? latestLane;
    await syncPacketForLane(task, blockedLane, {
      status: 'blocked',
      blockedReason: result.note,
      lastEventLabel: 'dispatch_failed',
      workerRouting,
    });
    return {
      ...(await mutationResult('dispatch', task, blockedLane, result.note || 'Dispatch failed.', { ok: false })),
      workerRouting,
    };
  }

  await syncPacketForLane(task, latestLane, {
    status: latestLane.status === 'running' ? 'running' : 'launching',
    blockedReason: null,
    lastEventLabel: latestLane.lastEventLabel ?? 'session_launched',
    workerRouting,
  });
  return {
    ...(await mutationResult('dispatch', task, latestLane, result.note || 'Task dispatched.')),
    workerRouting,
  };
}

export async function blockTask(taskId: string, input: TaskBlockInput): Promise<TaskMutationResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new TaskMutationError(400, 'reason is required.');
  }
  if (input.code && !isAgentReportReason(input.code)) {
    throw new TaskMutationError(400, 'code must be a valid agent report reason.');
  }

  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const lane = await ensureLaneForTask(task, actor);
  const report = reportAgentEvent({
    laneId: lane.id,
    actor,
    event: 'blocked',
    reason: input.code ?? undefined,
    message: reason,
    metadata: { taskId: task.id, packetId: task.packetId },
  });
  const blockedLane = setLaneStatus(lane.id, 'awaiting_orchestrator', actor, reason) ?? report?.lane ?? lane;
  await syncPacketForLane(task, blockedLane, {
    status: 'blocked',
    blockedReason: reason,
    lastEventLabel: reason,
  });
  return mutationResult('block', task, blockedLane, `Task blocked: ${reason}`, {
    eventId: report?.event.id,
    statusChanged: true,
  });
}

export async function reportTask(taskId: string, input: TaskReportInput = {}): Promise<TaskMutationResult> {
  const event = normalizeAgentReportEvent(input.event ?? input.status ?? 'progress');
  if (!event) {
    throw new TaskMutationError(400, 'event is required.');
  }
  if (input.reason && !isAgentReportReason(input.reason)) {
    throw new TaskMutationError(400, 'reason must be a valid agent report reason.');
  }

  const actor = normalizeActor(input.actor);
  const task = await resolveTask(taskId, input);
  const lane = await ensureLaneForTask(task, actor);
  const metadata = input.metadata === undefined || input.metadata === null
    ? undefined
    : normalizeAgentReportMetadata(input.metadata);
  if (input.metadata !== undefined && input.metadata !== null && !metadata) {
    throw new TaskMutationError(400, 'metadata must be a JSON object.');
  }

  const report = reportAgentEvent({
    laneId: lane.id,
    actor,
    event,
    reason: input.reason ?? undefined,
    message: normalizeAgentReportMessage(input.message),
    metadata: { taskId: task.id, packetId: task.packetId, ...(metadata ?? {}) },
  });
  if (!report) {
    throw new TaskMutationError(404, `Lane not found for task ${task.id}`);
  }

  await syncPacketForLane(task, report.lane, {
    status: report.statusChanged ? 'blocked' : undefined,
    blockedReason: report.statusChanged ? input.message ?? input.reason ?? event : undefined,
    lastEventLabel: report.lane.lastEventLabel ?? event,
  });
  return mutationResult('report', task, report.lane, `Reported ${event}.`, {
    eventId: report.event.id,
    statusChanged: report.statusChanged,
  });
}
