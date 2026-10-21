import { isDeepStrictEqual } from 'node:util';
import { getSqlite } from '@/lib/db';
import { persistMissionRegistryStateIfVersion, readMissionRegistryEntry } from '@/lib/orchestrator/mission-registry';
import type { MissionRegistryEntry } from '@/lib/orchestrator/mission-registry';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export class DispatchRegistryConflictError extends Error {
  constructor(missionId: string, reason: string, packetId?: string) {
    super(`Mission ${missionId} registry conflicts with current dispatch (${reason}${packetId ? `: ${packetId}` : ''}). Reconcile its durable owner before dispatching.`);
    this.name = 'DispatchRegistryConflictError';
  }
}

interface DispatchRegistryBaseline {
  entry: MissionRegistryEntry | null;
  retainedPackets: OrchestratorPacket[];
}

export interface DispatchRegistryPublication {
  status: 'published' | 'conflict' | 'unregistered' | 'unavailable';
  missionId: string;
  expectedVersion?: number;
  reason?: 'registry_advanced' | 'registry_store_unavailable';
}

function terminalPacket(packet: OrchestratorPacket): boolean {
  return Boolean(packet.archivedAt) || packet.releaseState === 'released'
    || packet.status === 'archived' || packet.status === 'failed';
}

function terminalAuthority(packet: OrchestratorPacket) {
  return {
    status: packet.status, queueState: packet.queueState, archivedAt: packet.archivedAt ?? null,
    releaseState: packet.releaseState, releaseStatePayload: packet.releaseStatePayload ?? null,
  };
}

function laneConflicts(stored: OrchestratorPacket, current: OrchestratorPacket): boolean {
  const lane = stored.lane;
  if (!lane) return false;
  if (lane.laneId) return lane.laneId !== current.lane?.laneId
    || Boolean(lane.sessionKey && lane.sessionKey !== current.lane?.sessionKey);
  if (lane.sessionKey) return lane.sessionKey !== current.lane?.sessionKey;
  return Boolean(lane.tileId && lane.tabId)
    && (lane.tileId !== current.lane?.tileId || lane.tabId !== current.lane?.tabId);
}

/** Capture authority before launch; an unchanged version alone is insufficient. */
export function captureCurrentDispatchRegistry(state: OrchestratorMissionState): DispatchRegistryBaseline {
  const missionId = state.missionId ?? '';
  const entry = readMissionRegistryEntry(missionId, { includeArchived: true });
  // Legacy current-only missions have no registry owner. Report that explicitly.
  if (!entry) {
    if (getSqlite().prepare('SELECT id FROM missions WHERE id = ?').get(missionId)) {
      throw new DispatchRegistryConflictError(missionId, 'registry_owner_unreadable');
    }
    return { entry: null, retainedPackets: [] };
  }
  const refuse = (reason: string, packetId?: string): never => {
    throw new DispatchRegistryConflictError(missionId, reason, packetId);
  };
  if (entry.mission.missionId !== state.missionId || entry.mission.repoPath !== state.repoPath) refuse('mission_owner_changed');
  if (entry.mission.lifecycleHold && !isDeepStrictEqual(entry.mission.lifecycleHold, state.lifecycleHold)) refuse('lifecycle_owner_changed');
  const currentById = new Map(state.packets.map(packet => [packet.id, packet]));
  const retainedPackets: OrchestratorPacket[] = [];
  // The durable owner's authority must survive in the current packet. Returns the generation order.
  const checkOwner = (stored: OrchestratorPacket, current: OrchestratorPacket, branchTarget: string | undefined): number => {
    const generationOrder = (current.storageAdmissionEpoch ?? 0) - (stored.storageAdmissionEpoch ?? 0)
      || (current.attemptCount ?? 0) - (stored.attemptCount ?? 0);
    if (generationOrder < 0) refuse('newer_generation', stored.id);
    if (stored.projectId !== current.projectId || stored.workspaceTargetPath !== current.workspaceTargetPath
      || branchTarget !== current.branchTarget) refuse('workspace_owner_changed', stored.id);
    if (laneConflicts(stored, current)) refuse('lane_binding_changed', stored.id);
    if (stored.operatorStopped && !current.operatorStopped) refuse('operator_stop_changed', stored.id);
    if (stored.holdIntent === 'operator' && current.holdIntent !== 'operator') refuse('operator_hold_changed', stored.id);
    if (stored.manualLaunchClaim && !isDeepStrictEqual(stored.manualLaunchClaim, current.manualLaunchClaim)) refuse('launch_owner_changed', stored.id);
    if (stored.releaseStatePayload && !isDeepStrictEqual(stored.releaseStatePayload, current.releaseStatePayload)) refuse('release_owner_changed', stored.id);
    if (stored.recovery && !isDeepStrictEqual(stored.recovery, current.recovery)) refuse('recovery_owner_changed', stored.id);
    return generationOrder;
  };
  for (const stored of entry.mission.packets) {
    const current = currentById.get(stored.id);
    if (!current) {
      // A comparison seed the current mission already fanned out is consumed by its
      // candidates, not missing (#3766). Only an unlaunched, non-terminal seed fans
      // out, and every candidate must keep the seed's durable authority.
      const candidates = stored.comparisonGroupId
        ? []
        : state.packets.filter(packet => packet.comparisonGroupId && packet.id.startsWith(`${stored.id}-cmp-`));
      if (candidates.length === 0) refuse('packet_owner_missing', stored.id);
      if (terminalPacket(stored) || stored.lane) refuse('terminal_owner_changed', stored.id);
      if (new Set(candidates.map(candidate => candidate.comparisonGroupId)).size !== 1) refuse('packet_owner_missing', stored.id);
      for (const candidate of candidates) {
        checkOwner(stored, candidate, `${stored.branchTarget}-cmp-${candidate.comparisonIndex}`);
      }
      continue;
    }
    const generationOrder = checkOwner(stored, current, stored.branchTarget);
    if (terminalPacket(stored)) {
      if (generationOrder !== 0 || !isDeepStrictEqual(terminalAuthority(stored), terminalAuthority(current))) refuse('terminal_owner_changed', stored.id);
      // Preserve the entire durable terminal sibling, including its evidence.
      retainedPackets.push(stored);
    }
  }
  if (entry.archivedAt && !state.packets.every(terminalPacket)) refuse('mission_archived');
  return { entry, retainedPackets };
}

/** A publication failure must never turn a completed launch into a retryable launch error. */
export async function publishCurrentDispatchRegistry(
  state: OrchestratorMissionState,
  baseline: DispatchRegistryBaseline,
): Promise<DispatchRegistryPublication> {
  const missionId = state.missionId ?? '';
  if (!baseline.entry) return { status: 'unregistered', missionId };
  const expectedVersion = baseline.entry.updatedAt;
  const retained = new Map(baseline.retainedPackets.map(packet => [packet.id, packet]));
  const publication = { ...state, packets: state.packets.map(packet => retained.get(packet.id) ?? packet) };
  try {
    const published = await persistMissionRegistryStateIfVersion(publication, expectedVersion);
    if (published) return { status: 'published', missionId, expectedVersion };
    console.warn(`[mission-registry] Dispatch ${missionId} retained its current lane; registry advanced during launch.`);
    return { status: 'conflict', missionId, expectedVersion, reason: 'registry_advanced' };
  } catch (error) {
    console.warn(`[mission-registry] Dispatch ${missionId} retained its current lane; publication unavailable:`, error);
    return { status: 'unavailable', missionId, expectedVersion, reason: 'registry_store_unavailable' };
  }
}
