import type { AgentControlRef } from '@/lib/agent-control/types';
import type { LaneStatus } from '@/lib/lane/types';
import type {
  OrchestratorPacket,
  OrchestratorPacketStatus,
  OrchestratorRuntime,
  WorkerLaunchContext,
} from '@/lib/orchestrator/types';
import { workerLaunchOriginLabel } from '@/lib/orchestrator/worker-launch-context';

export type WorkerParticipantIdentityKind = 'packet' | 'lane' | 'session';

export interface WorkerParticipantRuntimeTruth {
  sessionKey: string;
  runtime: OrchestratorRuntime;
  packetId?: string | null;
  laneId?: string | null;
  repoPath?: string | null;
  model?: string | null;
  status?: string | null;
  currentTask?: string | null;
  lastEventAt?: string | null;
  connected?: boolean | null;
}

/** Minimal lane truth accepted by browser and server projections alike. */
export interface WorkerParticipantLaneTruth {
  id?: string | null;
  packetId?: string | null;
  repoPath?: string | null;
  runtime: OrchestratorRuntime;
  sessionKey?: string | null;
  label?: string | null;
  status?: LaneStatus | null;
  updatedAt?: string | null;
  lastEventAt?: string | null;
  lastEventLabel?: string | null;
}

export interface WorkerParticipantRef {
  participantId: string;
  identityKind: WorkerParticipantIdentityKind;
  packetId: string | null;
  laneId: string | null;
  sessionKey: string | null;
  controlRef: AgentControlRef;
}

export interface WorkerParticipantLifecycle {
  packetStatus: OrchestratorPacketStatus | null;
  laneStatus: LaneStatus | null;
  runtimeStatus: string | null;
  connected: boolean;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

/** A read-only mesh participant projected from existing packet/lane/runtime truth. */
export interface WorkerParticipant {
  id: string;
  identityKind: WorkerParticipantIdentityKind;
  packetId: string | null;
  laneId: string | null;
  sessionKey: string | null;
  repoPath: string | null;
  runtime: OrchestratorRuntime;
  model: string | null;
  origin: string | null;
  taskSummary: string;
  lifecycle: WorkerParticipantLifecycle;
  controlRef: AgentControlRef;
  launchContext: WorkerLaunchContext | null;
}

export interface ProjectWorkerParticipantsInput {
  packets: ReadonlyArray<OrchestratorPacket>;
  lanes?: ReadonlyArray<WorkerParticipantLaneTruth>;
  runtimeTruth?: ReadonlyArray<WorkerParticipantRuntimeTruth>;
}

const TERMINAL_LANE_STATUSES = new Set<LaneStatus>(['failed', 'completed', 'archived']);
const DISCONNECTED_RUNTIME_STATUSES = new Set(['failed', 'completed', 'archived', 'exited', 'stopped']);

function trimmed(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function firstTrimmed(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = trimmed(value);
    if (normalized) return normalized;
  }
  return null;
}

function laneRank(lane: WorkerParticipantLaneTruth): number {
  return lane.status && TERMINAL_LANE_STATUSES.has(lane.status) ? 0 : 1;
}

function newerLane(
  left: WorkerParticipantLaneTruth,
  right: WorkerParticipantLaneTruth,
): WorkerParticipantLaneTruth {
  const rankDifference = laneRank(left) - laneRank(right);
  if (rankDifference !== 0) return rankDifference > 0 ? left : right;
  return (left.updatedAt ?? '') >= (right.updatedAt ?? '') ? left : right;
}

function selectLane(
  packet: OrchestratorPacket | null,
  lanes: ReadonlyArray<WorkerParticipantLaneTruth>,
): WorkerParticipantLaneTruth | null {
  if (lanes.length === 0) return null;
  const boundLaneId = trimmed(packet?.lane?.laneId);
  const bound = boundLaneId ? lanes.find((lane) => trimmed(lane.id) === boundLaneId) : null;
  return bound ?? lanes.reduce(newerLane);
}

function selectRuntimeTruth(
  packetId: string | null,
  lane: WorkerParticipantLaneTruth | null,
  truths: ReadonlyArray<WorkerParticipantRuntimeTruth>,
): WorkerParticipantRuntimeTruth | null {
  const exactSession = trimmed(lane?.sessionKey);
  const matching = truths.filter((truth) => (
    (packetId && trimmed(truth.packetId) === packetId)
    || (lane?.id && trimmed(truth.laneId) === trimmed(lane.id))
    || (exactSession && truth.sessionKey === exactSession)
  ));
  if (matching.length === 0) return null;
  if (exactSession) {
    const exact = matching.find((truth) => truth.sessionKey === exactSession);
    if (exact) return exact;
  }
  return matching.reduce((left, right) => (
    (left.lastEventAt ?? '') >= (right.lastEventAt ?? '') ? left : right
  ));
}

function projectParticipant(input: {
  packet: OrchestratorPacket | null;
  lane: WorkerParticipantLaneTruth | null;
  runtimeTruth: WorkerParticipantRuntimeTruth | null;
}): WorkerParticipant | null {
  const packetId = trimmed(input.packet?.id ?? input.lane?.packetId ?? input.runtimeTruth?.packetId);
  const laneId = firstTrimmed(input.lane?.id, input.runtimeTruth?.laneId);
  const sessionKey = trimmed(input.lane?.sessionKey ?? input.runtimeTruth?.sessionKey);
  const ref = resolveWorkerParticipantRef({ packetId, laneId, sessionKey });
  if (!ref) return null;
  const launchContext = input.packet?.launchContext ?? null;
  const runtimeStatus = trimmed(input.runtimeTruth?.status);
  const connected = input.runtimeTruth?.connected ?? Boolean(
    sessionKey
    && (runtimeStatus
      ? !DISCONNECTED_RUNTIME_STATUSES.has(runtimeStatus)
      : input.lane && (!input.lane.status || !TERMINAL_LANE_STATUSES.has(input.lane.status))),
  );

  return {
    id: ref.participantId,
    identityKind: ref.identityKind,
    packetId,
    laneId,
    sessionKey,
    repoPath: firstTrimmed(input.lane?.repoPath, input.packet?.workspaceTargetPath, input.runtimeTruth?.repoPath),
    runtime: input.lane?.runtime ?? input.packet?.runtime ?? input.runtimeTruth?.runtime ?? 'codex',
    model: firstTrimmed(
      input.packet?.workerRouting?.selectedModel,
      input.packet?.assignedModel,
      input.runtimeTruth?.model,
    ),
    origin: workerLaunchOriginLabel(launchContext),
    taskSummary: firstTrimmed(
      input.packet?.summary,
      input.packet?.title,
      input.lane?.label,
      input.runtimeTruth?.currentTask,
    ) ?? 'Worker',
    lifecycle: {
      packetStatus: input.packet?.status ?? null,
      laneStatus: input.lane?.status ?? null,
      runtimeStatus,
      connected,
      lastEventAt: trimmed(input.runtimeTruth?.lastEventAt ?? input.lane?.lastEventAt ?? input.packet?.lastEventAt),
      lastEventLabel: trimmed(input.lane?.lastEventLabel ?? input.packet?.lastEventLabel),
    },
    controlRef: ref.controlRef,
    launchContext,
  };
}

/**
 * Build one participant per durable worker identity. Packets win over lanes,
 * and lanes win over rotating session keys, so reconnects update transport
 * truth without creating a second participant or another state store.
 */
export function projectWorkerParticipants(input: ProjectWorkerParticipantsInput): WorkerParticipant[] {
  const packetsById = new Map(input.packets.map((packet) => [packet.id, packet]));
  const lanes = input.lanes ?? projectPacketLaneBindings(input.packets);
  const lanesByPacket = new Map<string, WorkerParticipantLaneTruth[]>();
  for (const lane of lanes) {
    const packetId = trimmed(lane.packetId);
    if (!packetId) continue;
    lanesByPacket.set(packetId, [...(lanesByPacket.get(packetId) ?? []), lane]);
  }
  const runtimeTruth = input.runtimeTruth ?? [];
  const participants: WorkerParticipant[] = [];
  const consumedLaneIds = new Set<string>();
  const consumedSessions = new Set<string>();

  const packetIds = new Set([...packetsById.keys(), ...lanesByPacket.keys()]);
  for (const packetId of packetIds) {
    const packet = packetsById.get(packetId) ?? null;
    const lane = selectLane(packet, lanesByPacket.get(packetId) ?? []);
    const truth = selectRuntimeTruth(packetId, lane, runtimeTruth);
    const participant = projectParticipant({ packet, lane, runtimeTruth: truth });
    if (!participant) continue;
    participants.push(participant);
    if (lane?.id) consumedLaneIds.add(lane.id);
    for (const candidate of runtimeTruth) {
      if (trimmed(candidate.packetId) === packetId
        || (lane?.id && trimmed(candidate.laneId) === lane.id)) {
        consumedSessions.add(candidate.sessionKey);
      }
    }
    if (truth) consumedSessions.add(truth.sessionKey);
  }

  for (const lane of lanes) {
    const laneId = trimmed(lane.id);
    if (lane.packetId || (laneId && consumedLaneIds.has(laneId))) continue;
    const truth = selectRuntimeTruth(null, lane, runtimeTruth);
    const participant = projectParticipant({ packet: null, lane, runtimeTruth: truth });
    if (!participant) continue;
    participants.push(participant);
    if (laneId) consumedLaneIds.add(laneId);
    for (const candidate of runtimeTruth) {
      if (laneId && trimmed(candidate.laneId) === laneId) consumedSessions.add(candidate.sessionKey);
    }
    if (truth) consumedSessions.add(truth.sessionKey);
  }

  for (const truth of runtimeTruth) {
    if (consumedSessions.has(truth.sessionKey)) continue;
    const participant = projectParticipant({ packet: null, lane: null, runtimeTruth: truth });
    if (participant) participants.push(participant);
  }

  return participants;
}

/** Resolve the stable identity and strongest available control reference. */
export function resolveWorkerParticipantRef(input: {
  packetId?: string | null;
  laneId?: string | null;
  sessionKey?: string | null;
}): WorkerParticipantRef | null {
  const packetId = trimmed(input.packetId);
  const laneId = trimmed(input.laneId);
  const sessionKey = trimmed(input.sessionKey);
  if (packetId) {
    return {
      participantId: packetId,
      identityKind: 'packet',
      packetId,
      laneId,
      sessionKey,
      controlRef: { kind: 'packet', id: packetId },
    };
  }
  if (laneId) {
    return {
      participantId: laneId,
      identityKind: 'lane',
      packetId: null,
      laneId,
      sessionKey,
      controlRef: { kind: 'lane', id: laneId },
    };
  }
  if (!sessionKey) return null;
  return {
    participantId: sessionKey,
    identityKind: 'session',
    packetId: null,
    laneId: null,
    sessionKey,
    controlRef: { kind: 'session', id: sessionKey },
  };
}

/** Browser-safe adapter over the packet's already-persisted lane binding. */
export function projectPacketLaneBindings(
  packets: ReadonlyArray<OrchestratorPacket>,
): WorkerParticipantLaneTruth[] {
  return packets.flatMap((packet) => {
    const lane = packet.lane;
    if (!lane?.laneId && !lane?.sessionKey) return [];
    return [{
      id: lane.laneId ?? null,
      packetId: packet.id,
      repoPath: lane.repoPath ?? packet.workspaceTargetPath,
      runtime: lane.runtime,
      sessionKey: lane.sessionKey ?? null,
      label: packet.title,
      updatedAt: lane.lastEventAt ?? packet.lastEventAt ?? null,
      lastEventAt: lane.lastEventAt ?? packet.lastEventAt ?? null,
      lastEventLabel: lane.lastEventLabel ?? packet.lastEventLabel ?? null,
    }];
  });
}
