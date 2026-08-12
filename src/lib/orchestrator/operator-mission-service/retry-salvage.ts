import { randomUUID } from 'node:crypto';
import { currentMissionState } from './shared';
import type { ResetPacketInput } from './types';
import { archiveLaneSessions, assertLaneSessionsArchived, killLaneSessionsConfirmed } from '@/lib/lane/reap-sessions';
import { unregisterWatchedAgent } from '@/lib/supervisor/agent-supervisor';
import { findMissionRegistryEntryByPacketId, withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import { MCP_DISPATCH_TILE_SENTINEL, type OrchestratorPacket } from '@/lib/orchestrator/types';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { probeNoChangesProduced } from '@/lib/lane/no-changes-produced';
import { probeLaneSessionAlive } from '@/lib/lane/owned-session-liveness';
import type { Lane } from '@/lib/lane/types';

export interface RetrySalvage {
  laneId: string;
  repoPath: string;
  worktreePath: string;
  runtime: OrchestratorPacket['runtime'];
  lastEventAt: string;
  referenceLabel: string;
}

interface RetrySalvageGuardFields {
  candidateLane: Lane | null;
  laneIds: string[];
  generation: string;
  holdReason: string;
  referenceLabel: string;
  laneId: string | null;
  sessionKey: string | null;
  worktreePath: string | null;
}

type RetrySalvageLocation = (
  | { store: 'current'; missionId: string }
  | { store: 'registry'; missionId: string }
);
export type RetrySalvageGuard = RetrySalvageGuardFields & RetrySalvageLocation;

export class RetrySalvageStateChangedError extends Error {}
export class RetrySalvageKillUnconfirmedError extends Error {}

export function retrySalvageGenerationSource(generation: string): string {
  return `retry_salvage:${generation}`;
}

function buildRetrySalvageGuard(
  packet: OrchestratorPacket,
  location: RetrySalvageLocation,
  candidateLane: Lane | null,
  laneIds: string[],
): RetrySalvageGuard {
  const generation = randomUUID();
  return {
    ...location,
    candidateLane,
    laneIds,
    generation,
    holdReason: `Retry salvage in progress (${generation}).`,
    referenceLabel: packet.referenceLabel,
    laneId: packet.lane?.laneId ?? null,
    sessionKey: packet.lane?.sessionKey ?? null,
    worktreePath: packet.lane?.worktreePath ?? null,
  };
}

function markPacketRetrySalvageHeld(packet: OrchestratorPacket, guard: RetrySalvageGuard): void {
  packet.status = 'failed';
  packet.queueState = 'held';
  packet.releaseState = 'pending';
  packet.releaseStatePayload = { source: retrySalvageGenerationSource(guard.generation) };
  packet.archivedAt = null;
  packet.operatorStopped = true;
  packet.blockedReason = guard.holdReason;
}

function packetMatchesRetrySalvageGuard(packet: OrchestratorPacket, guard: RetrySalvageGuard): boolean {
  return packet.queueState === 'held'
    && packet.operatorStopped === true
    && packet.releaseStatePayload?.source === retrySalvageGenerationSource(guard.generation)
    && (packet.lane?.laneId ?? null) === guard.laneId
    && (packet.lane?.sessionKey ?? null) === guard.sessionKey
    && (packet.lane?.worktreePath ?? null) === guard.worktreePath;
}

async function holdPacketForRetrySalvageUnlocked(input: ResetPacketInput): Promise<RetrySalvageGuard | null> {
  if (input.clearWorktree || input.scope) return null;

  const { getLane, listLanes } = await import('@/lib/lane/registry');
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { result: currentGuard } = await withLockedState((fresh) => {
    const missionId = fresh.missionId?.trim();
    if (!missionId) return null;
    const target = fresh.packets.find((candidate) => candidate.id === input.packetId);
    if (!target) return null;
    const guardedLane = target.lane?.laneId ? getLane(target.lane.laneId) : null;
    const laneIds = listLanes().filter((lane) => lane.packetId === target.id).map((lane) => lane.id);
    const guard = buildRetrySalvageGuard(target, { store: 'current', missionId }, guardedLane, laneIds);
    markPacketRetrySalvageHeld(target, guard);
    return guard;
  });
  if (currentGuard) return currentGuard;

  const registryEntry = findMissionRegistryEntryByPacketId(input.packetId, {
    includeArchived: true,
    excludeMissionId: currentMissionState().missionId,
  });
  if (!registryEntry) return null;

  const { result } = await withMissionRegistryState(registryEntry.id, (fresh) => {
    const target = fresh.packets.find((candidate) => candidate.id === input.packetId);
    if (!target) throw new Error(`Packet ${input.packetId} not found.`);
    const guardedLane = target.lane?.laneId ? getLane(target.lane.laneId) : null;
    const laneIds = listLanes().filter((lane) => lane.packetId === target.id).map((lane) => lane.id);
    const guard = buildRetrySalvageGuard(target, { store: 'registry', missionId: registryEntry.id }, guardedLane, laneIds);
    markPacketRetrySalvageHeld(target, guard);
    return { state: fresh, result: guard };
  });
  return result;
}

export function holdPacketForRetrySalvage(input: ResetPacketInput): Promise<RetrySalvageGuard | null> {
  return withMissionHandoffBarrier(() => holdPacketForRetrySalvageUnlocked(input));
}

async function retrySalvageGuardIsCurrentUnlocked(
  packetId: string,
  guard: RetrySalvageGuard,
): Promise<boolean> {
  if (guard.store === 'current') {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    const { result } = await withLockedState((fresh) => {
      if (fresh.missionId !== guard.missionId) return null;
      const packet = fresh.packets.find((candidate) => candidate.id === packetId);
      return packet ? packetMatchesRetrySalvageGuard(packet, guard) : false;
    });
    if (result !== null) return result;
  }
  const { result } = await withMissionRegistryState(guard.missionId, (fresh) => {
    const packet = fresh.packets.find((candidate) => candidate.id === packetId);
    return { state: fresh, result: packet ? packetMatchesRetrySalvageGuard(packet, guard) : false };
  });
  return result;
}

export function retrySalvageGuardIsCurrent(
  packetId: string,
  guard: RetrySalvageGuard,
): Promise<boolean> {
  return withMissionHandoffBarrier(() => retrySalvageGuardIsCurrentUnlocked(packetId, guard));
}

export async function markRetrySalvageKillUnconfirmed(
  packetId: string,
  guard: RetrySalvageGuard,
): Promise<boolean> {
  return markRetrySalvageBlocked(packetId, guard, 'kill_unconfirmed');
}

export async function markRetrySalvageSessionArchiveUnconfirmed(
  packetId: string,
  guard: RetrySalvageGuard,
): Promise<boolean> {
  return markRetrySalvageBlocked(packetId, guard, 'session_archive_unconfirmed');
}

async function markRetrySalvageBlocked(
  packetId: string,
  guard: RetrySalvageGuard,
  reason: 'kill_unconfirmed' | 'session_archive_unconfirmed',
): Promise<boolean> {
  return withMissionHandoffBarrier(() => markRetrySalvageBlockedUnlocked(packetId, guard, reason));
}

async function markRetrySalvageBlockedUnlocked(
  packetId: string,
  guard: RetrySalvageGuard,
  reason: 'kill_unconfirmed' | 'session_archive_unconfirmed',
): Promise<boolean> {
  const mark = (packet: OrchestratorPacket) => {
    if (!packetMatchesRetrySalvageGuard(packet, guard)) return false;
    packet.status = 'blocked';
    packet.queueState = 'held';
    packet.operatorStopped = true;
    packet.blockedReason = reason;
    packet.lastEventAt = new Date().toISOString();
    packet.lastEventLabel = reason;
    return true;
  };

  if (guard.store === 'current') {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    const { result } = await withLockedState((fresh) => {
      if (fresh.missionId !== guard.missionId) return null;
      const packet = fresh.packets.find((candidate) => candidate.id === packetId);
      return packet ? mark(packet) : false;
    });
    if (result !== null) return result;
  }

  const { result } = await withMissionRegistryState(guard.missionId, (fresh) => {
    const packet = fresh.packets.find((candidate) => candidate.id === packetId);
    return { state: fresh, result: packet ? mark(packet) : false };
  });
  return result;
}

export function scopedPacketGenerationMatches(packet: OrchestratorPacket, input: ResetPacketInput): boolean {
  const expected = input.scope?.expectedReleaseSource;
  if (expected) return packet.releaseStatePayload?.source === expected;
  return packet.operatorStopped === true && !packet.lane;
}

function laneMatchesRetrySalvageCandidate(current: Lane, candidate: Lane, packetId: string): boolean {
  return current.packetId === packetId
    && current.repoPath === candidate.repoPath
    && current.worktreePath === candidate.worktreePath
    && current.branch === candidate.branch
    && current.baseBranch === candidate.baseBranch
    && current.sessionKey === candidate.sessionKey;
}

export async function findCommittedRetryWork(
  input: ResetPacketInput,
  guard: RetrySalvageGuard,
): Promise<Lane | null> {
  const candidate = guard.candidateLane;
  if (!candidate?.worktreePath) return null;

  const { getLane } = await import('@/lib/lane/registry');
  const lane = getLane(candidate.id);
  if (!lane || !laneMatchesRetrySalvageCandidate(lane, candidate, input.packetId)) return null;

  try {
    const beforeStop = await probeNoChangesProduced(candidate.worktreePath, lane.baseBranch);
    if (beforeStop.commitsAhead <= 0 || beforeStop.statusPorcelain.length > 0) return null;
  } catch {
    return null;
  }

  const outcomes = await killLaneSessionsConfirmed([lane]);
  const confirmedKills = new Set(outcomes
    .filter((outcome) => outcome.confirmed || outcome.alreadyDead)
    .map((outcome) => outcome.laneId));
  if (lane.sessionKey?.trim() && !confirmedKills.has(lane.id)) {
    throw new RetrySalvageKillUnconfirmedError(
      `Packet ${input.packetId} worker stop could not be confirmed; lane, session, and worktree bindings were preserved.`,
    );
  }
  if (lane.sessionKey?.trim() && await probeLaneSessionAlive(lane) === true) {
    throw new RetrySalvageKillUnconfirmedError(
      `Packet ${input.packetId} still has a live worker process; lane, session, and worktree bindings were preserved.`,
    );
  }

  try {
    const afterStop = await probeNoChangesProduced(candidate.worktreePath, lane.baseBranch);
    if (afterStop.commitsAhead <= 0 || afterStop.statusPorcelain.length > 0) return null;
  } catch {
    return null;
  }

  return lane;
}

async function bindCommittedRetryWorkUnlocked(
  input: ResetPacketInput,
  guard: RetrySalvageGuard,
  candidate: Lane,
): Promise<RetrySalvage> {
  const bind = async (packet: OrchestratorPacket): Promise<RetrySalvage> => {
    if (!packetMatchesRetrySalvageGuard(packet, guard)) {
      throw new RetrySalvageStateChangedError(`Packet ${input.packetId} changed while retry salvage was probing; committed work was left untouched.`);
    }

    const { archiveLane, createLane, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
    const lane = getLane(candidate.id);
    if (!lane || !lane.worktreePath || !laneMatchesRetrySalvageCandidate(lane, candidate, input.packetId)) {
      throw new RetrySalvageStateChangedError(`Packet ${input.packetId} lane changed while retry salvage was probing; committed work was left untouched.`);
    }
    const worktreePath = lane.worktreePath;

    assertLaneSessionsArchived(await archiveLaneSessions([lane]));
    if (lane.sessionKey?.trim()) unregisterWatchedAgent(lane.sessionKey.trim());

    const reviewLane = createLane({
      repoPath: lane.repoPath,
      projectId: lane.projectId,
      branch: lane.branch,
      baseBranch: lane.baseBranch,
      runtime: lane.runtime,
      label: lane.label,
      packetId: input.packetId,
      ownership: lane.ownership,
      worktreePath,
      actor: 'system',
    });
    const reviewing = setLaneStatus(reviewLane.id, 'reviewing', 'system', 'retry_salvaged_work');
    if (!reviewing || reviewing.status !== 'reviewing') {
      archiveLane(reviewLane.id, 'system');
      throw new Error(`Packet ${input.packetId} retry salvage could not create a review lane.`);
    }

    updateLane(lane.id, {
      packetId: '',
      worktreePath: null,
      outcome: 'discarded',
      outcomeNote: 'Superseded by retry salvage',
    });
    archiveLane(lane.id, 'user');

    const salvage = {
      laneId: reviewing.id,
      repoPath: reviewing.repoPath,
      worktreePath,
      runtime: reviewing.runtime,
      lastEventAt: reviewing.lastEventAt ?? new Date().toISOString(),
      referenceLabel: packet.referenceLabel,
    };
    markPacketRetrySalvaged(packet, salvage);
    return salvage;
  };

  if (guard.store === 'current') {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    const { result } = await withLockedState(async (fresh) => {
      if (fresh.missionId !== guard.missionId) return null;
      const target = fresh.packets.find((packet) => packet.id === input.packetId);
      if (!target) {
        throw new RetrySalvageStateChangedError(`Packet ${input.packetId} changed while retry salvage was probing; committed work was left untouched.`);
      }
      return bind(target);
    });
    if (result) return result;
  }

  const { result } = await withMissionRegistryState(guard.missionId, async (fresh) => {
    const target = fresh.packets.find((packet) => packet.id === input.packetId);
    if (!target) {
      throw new RetrySalvageStateChangedError(`Packet ${input.packetId} changed while retry salvage was probing; committed work was left untouched.`);
    }
    return { state: fresh, result: await bind(target) };
  });
  return result;
}

export function bindCommittedRetryWork(
  input: ResetPacketInput,
  guard: RetrySalvageGuard,
  candidate: Lane,
): Promise<RetrySalvage> {
  return withMissionHandoffBarrier(() => bindCommittedRetryWorkUnlocked(input, guard, candidate));
}

function markPacketRetrySalvaged(packet: OrchestratorPacket, salvage: RetrySalvage): void {
  packet.status = 'awaiting_review';
  packet.queueState = 'queued';
  packet.releaseState = 'pending';
  packet.releaseStatePayload = null;
  packet.archivedAt = null;
  packet.blockedReason = null;
  packet.recovery = null;
  packet.review = null;
  packet.operatorStopped = false;
  packet.lastEventAt = salvage.lastEventAt;
  packet.lastEventLabel = 'retry_salvaged_work';
  packet.lane = {
    tileId: packet.lane?.tileId || MCP_DISPATCH_TILE_SENTINEL,
    tabId: packet.lane?.tabId || MCP_DISPATCH_TILE_SENTINEL,
    repoPath: salvage.repoPath,
    worktreePath: salvage.worktreePath,
    runtime: salvage.runtime,
    laneId: salvage.laneId,
    sessionKey: null,
    lastHeartbeatAt: null,
    lastEventAt: salvage.lastEventAt,
    lastEventLabel: 'retry_salvaged_work',
  };
}
