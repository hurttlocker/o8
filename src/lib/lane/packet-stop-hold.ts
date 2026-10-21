import {
  readOrchestratorControlPlaneState,
  withControlPlaneLock,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import {
  findMissionRegistryEntryByPacketId,
  readMissionRegistryEntry,
  persistMissionRegistryStateIfVersion,
} from '@/lib/orchestrator/mission-registry';
import { isDeepStrictEqual } from 'node:util';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { missionLifecycleHoldIsActive } from '@/lib/orchestrator/mission-lifecycle-hold';
import type { Lane } from './types';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { hasCanonicalReleaseEvidence } from '@/lib/orchestrator/packet-release-truth';
import { getSqlite } from '@/lib/db';
import { findLaneByPacket } from './registry';

export interface PacketManagedRunAdmission {
  allowed: boolean;
  reason: 'active' | 'packet_not_found' | 'packet_held' | 'packet_terminal';
  status: OrchestratorPacket['status'] | null;
}

const MANAGED_RUN_TERMINAL_PACKET_STATUSES = new Set<OrchestratorPacket['status']>([
  'awaiting_review',
  'failed',
  'blocked',
  'released',
  'archived',
]);

function applyOperatorHold(packet: OrchestratorPacket) {
  packet.operatorStopped = true;
  packet.queueState = 'held';
  packet.status = 'blocked';
  packet.blockedReason = 'operator_stopped';
  packet.lastEventAt = new Date().toISOString();
  packet.lastEventLabel = 'operator_stopped';
}

function managedRunAdmissionForPacket(packet: OrchestratorPacket | null): PacketManagedRunAdmission {
  if (!packet) return { allowed: false, reason: 'packet_not_found', status: null };
  if (packet.operatorStopped) {
    return { allowed: false, reason: 'packet_held', status: packet.status };
  }
  const steeredRun = acceptedSteerRunState(packet.id);
  if (!packetSteerHoldReason(packet.id) && steeredRun === 'active') {
    return { allowed: true, reason: 'active', status: 'running' };
  }
  if (steeredRun === 'closed') {
    return { allowed: false, reason: 'packet_terminal', status: packet.status };
  }
  if (packet.queueState === 'held') {
    return { allowed: false, reason: 'packet_held', status: packet.status };
  }
  if (packet.releaseState === 'released' || MANAGED_RUN_TERMINAL_PACKET_STATUSES.has(packet.status)) {
    return { allowed: false, reason: 'packet_terminal', status: packet.status };
  }
  return { allowed: true, reason: 'active', status: packet.status };
}

/** Read the durable packet state before admitting a packet-bound managed run. */
function readManagedRunPacket(packetId: string): OrchestratorPacket | null {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) return null;
  const currentPacket = readOrchestratorControlPlaneState().packets
    .find((candidate) => candidate.id === normalizedPacketId) ?? null;
  if (currentPacket) return currentPacket;

  const registryPacket = findMissionRegistryEntryByPacketId(normalizedPacketId, { includeArchived: true })
    ?.mission.packets.find((candidate) => candidate.id === normalizedPacketId) ?? null;
  return registryPacket;
}

/** A steer is not authority to undo an operator stop, archive, or proven release. */
export function packetSteerHoldReason(packetId: string): string | null {
  const packet = readManagedRunPacket(packetId);
  if (packet?.operatorStopped) return 'operator_stopped';
  if (packet?.archivedAt || packet?.status === 'archived') return 'archived';
  if (packet?.releaseState === 'released' && hasCanonicalReleaseEvidence(packet)) return 'released';
  return null;
}

function acceptedSteerRunState(packetId: string): 'absent' | 'active' | 'closed' {
  const lane = findLaneByPacket(packetId);
  if (!lane?.sessionKey) return 'absent';
  const grant = getSqlite().prepare(`
    SELECT id, payload_json FROM lane_events
    WHERE lane_id = ? AND verb = 'steer_run_admitted'
    ORDER BY timestamp DESC, rowid DESC LIMIT 1
  `).get(lane.id) as { id: string; payload_json: string } | undefined;
  if (!grant) return 'absent';
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(grant.payload_json) as Record<string, unknown>; }
  catch { return 'closed'; }
  if (!payload || typeof payload !== 'object') return 'closed';
  if (payload.packetId !== packetId || payload.sessionKey !== lane.sessionKey) return 'absent';
  if (lane.status !== 'running') return 'closed';
  // Query only lifecycle evidence, not the last N transcript/tool events. A
  // long turn must not lose admission merely because it produced more output.
  // A DIFFERENT steer attempt's own intent/failure ('steered_packet',
  // 'steer_failed') is excluded here: a later steer that the runtime refuses
  // as still-busy appends both, but never supersedes this grant — only a
  // newer admission ('steer_run_admitted', picked up as `grant` above) or a
  // terminal lane event actually closes it (#2342).
  const event = getSqlite().prepare(`
    SELECT id FROM lane_events
    WHERE lane_id = ? AND verb IN (
      'steer_run_admitted', 'runtime_process_exit', 'status_change'
    ) ORDER BY timestamp DESC, rowid DESC LIMIT 1
  `).get(lane.id) as { id: string } | undefined;
  if (event?.id !== grant.id || typeof payload.steerEventId !== 'string') return 'closed';
  const intent = getSqlite().prepare(`
    SELECT rowid FROM lane_events WHERE id = ? AND lane_id = ? AND verb = 'steered_packet'
  `).get(payload.steerEventId, lane.id) as { rowid: number } | undefined;
  if (!intent) return 'closed';
  // An immediate exit can precede the accepted-steer response. Insertion order
  // keeps equal-millisecond events distinct, including across a database reopen.
  const exited = getSqlite().prepare(`
    SELECT 1 FROM lane_events WHERE lane_id = ? AND verb = 'runtime_process_exit'
    AND rowid > ? LIMIT 1
  `).get(lane.id, intent.rowid);
  return exited ? 'closed' : 'active';
}

export function inspectPacketManagedRunAdmission(packetId: string): PacketManagedRunAdmission {
  return managedRunAdmissionForPacket(readManagedRunPacket(packetId));
}

type StopLaneOwner = Pick<Lane, 'id' | 'sessionKey' | 'worktreePath' | 'repoPath' | 'runtime'>;

function laneOwnsStop(packet: OrchestratorPacket, lane?: StopLaneOwner): boolean {
  return !lane || Boolean(packet.lane && packet.lane.laneId === lane.id
    && (packet.lane.sessionKey ?? null) === (lane.sessionKey ?? null)
    && (packet.lane.worktreePath ?? packet.lane.repoPath) === (lane.worktreePath ?? lane.repoPath)
    && packet.lane.repoPath === lane.repoPath && packet.runtime === lane.runtime);
}

function stopAuthority(packet: OrchestratorPacket) {
  return {
    id: packet.id, storageAdmissionEpoch: packet.storageAdmissionEpoch ?? 0, attemptCount: packet.attemptCount ?? 0,
    runtime: packet.runtime, projectId: packet.projectId ?? null, workspaceTargetPath: packet.workspaceTargetPath ?? null,
    branchTarget: packet.branchTarget ?? null, laneId: packet.lane?.laneId ?? null,
    sessionKey: packet.lane?.sessionKey ?? null, worktreePath: packet.lane?.worktreePath ?? null,
    repoPath: packet.lane?.repoPath ?? null, manualLaunchClaim: packet.manualLaunchClaim ?? null,
    holdIntent: packet.holdIntent ?? null, releaseState: packet.releaseState,
    releaseStatePayload: packet.releaseStatePayload ?? null, archivedAt: packet.archivedAt ?? null,
    recovery: packet.recovery ?? null, review: packet.review ?? null,
  };
}

function terminalStopOwner(packet: OrchestratorPacket): boolean {
  return Boolean(packet.archivedAt) || packet.status === 'archived' || packet.status === 'released'
    || packet.releaseState === 'released';
}

function ownedMissionStop(hold: OrchestratorMissionState['lifecycleHold']): boolean {
  return Boolean(hold?.source.startsWith('mission_stop:') && hold.reason === 'operator_stop'
    && hold.ownerPid === process.pid && missionLifecycleHoldIsActive(hold));
}

function lifecycleAllowsStop(current: OrchestratorMissionState, registered: OrchestratorMissionState): boolean {
  if (!current.lifecycleHold && !registered.lifecycleHold) return true;
  // Mission Stop intentionally installs its own current-only admission before
  // stopping each lane. Accept that exact live owner, never a foreign hold.
  return ownedMissionStop(current.lifecycleHold) && (!registered.lifecycleHold
    || isDeepStrictEqual(current.lifecycleHold, registered.lifecycleHold));
}

function copyStopFields(target: OrchestratorPacket, stopped: OrchestratorPacket) {
  Object.assign(target, { operatorStopped: stopped.operatorStopped, queueState: stopped.queueState,
    status: stopped.status, blockedReason: stopped.blockedReason,
    lastEventAt: stopped.lastEventAt, lastEventLabel: stopped.lastEventLabel });
}

/** Persist the exact lane's stop in both stores before interrupting its worker. */
export function persistLanePacketHold(packetId: string, lane?: StopLaneOwner): Promise<boolean> {
  return withMissionHandoffBarrier(() => withControlPlaneLock(async () => {
    const current = readOrchestratorControlPlaneState();
    const packet = current.packets.find(candidate => candidate.id === packetId);
    if (packet) {
      if (terminalStopOwner(packet) || !laneOwnsStop(packet, lane)) return false;
      const entry = current.missionId ? readMissionRegistryEntry(current.missionId, { includeArchived: true }) : null;
      if (!entry && current.missionId && getSqlite().prepare('SELECT id FROM missions WHERE id = ?').get(current.missionId)) return false;
      const stored = entry?.mission.packets.find(candidate => candidate.id === packetId);
      if (entry && (entry.archivedAt || !stored || terminalStopOwner(stored)
        || entry.mission.missionId !== current.missionId || entry.mission.repoPath !== current.repoPath
        || !lifecycleAllowsStop(current, entry.mission)
        || !isDeepStrictEqual(stopAuthority(packet), stopAuthority(stored)))) return false;
      applyOperatorHold(packet);
      // Keep this checkpoint if publication throws or loses its version race.
      // Another Stop can recapture this same owner; stop fields are not identity.
      writeOrchestratorControlPlaneState(current);
      if (entry && stored) {
        copyStopFields(stored, packet);
        if (!await persistMissionRegistryStateIfVersion(entry.mission, entry.updatedAt)) {
          throw new Error('Registry ownership advanced; the local packet remains held and its worker was not interrupted.');
        }
      }
      return true;
    }
    const entry = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true });
    const stored = entry?.mission.packets.find(candidate => candidate.id === packetId);
    if (!entry || entry.archivedAt || !stored || terminalStopOwner(stored) || !laneOwnsStop(stored, lane)
      || (entry.mission.lifecycleHold && !ownedMissionStop(entry.mission.lifecycleHold))) return false;
    applyOperatorHold(stored);
    if (!await persistMissionRegistryStateIfVersion(entry.mission, entry.updatedAt)) {
      throw new Error('Registry ownership advanced; the stop was not published and its worker was not interrupted.');
    }
    return true;
  }));
}
