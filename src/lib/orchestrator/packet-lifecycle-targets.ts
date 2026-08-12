import type { Lane, LaneStatus } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function packetLaneStatus(packet: OrchestratorPacket): LaneStatus {
  if (packet.status === 'running') return 'running';
  if (packet.status === 'launching') return 'launching';
  if (packet.status === 'awaiting_review') return 'reviewing';
  if (packet.status === 'recovering') return 'recovering';
  if (packet.status === 'failed') return 'failed';
  if (packet.status === 'archived') return 'archived';
  return 'paused';
}

function syntheticPacketLane(
  packet: OrchestratorPacket,
  repoPath: string,
): Lane | null {
  const binding = packet.lane;
  if (!binding?.sessionKey?.trim() && !binding?.worktreePath?.trim()) return null;
  const timestamp = packet.lastEventAt ?? new Date().toISOString();
  return {
    id: binding.laneId?.trim() || `packet-binding:${packet.id}`,
    projectId: null,
    label: packet.title,
    repoPath: binding.repoPath?.trim() || repoPath,
    worktreePath: binding.worktreePath?.trim() || null,
    branch: packet.branchTarget?.trim() || '',
    baseBranch: 'main',
    runtime: binding.runtime ?? packet.runtime,
    sessionKey: binding.sessionKey?.trim() || null,
    packetId: packet.id,
    prNumber: null,
    status: packetLaneStatus(packet),
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastEventAt: packet.lastEventAt ?? null,
    lastEventLabel: packet.lastEventLabel ?? null,
  };
}

function sameLifecycleBinding(left: Lane, right: Lane): boolean {
  return left.id === right.id
    && left.sessionKey === right.sessionKey
    && left.worktreePath === right.worktreePath;
}

/**
 * SQLite is the durable lane ledger, but packet state is authoritative for the
 * worker currently bound to a mission. Keep both targets when they disagree so
 * lifecycle actions cannot skip a live packet binding or an older leaked lane.
 */
export function collectPacketLifecycleLanes(
  packet: OrchestratorPacket,
  repoPath: string,
  persistedLanes: Lane[],
): Lane[] {
  const targets = [...persistedLanes];
  const synthetic = syntheticPacketLane(packet, repoPath);
  if (synthetic && !targets.some((lane) => sameLifecycleBinding(lane, synthetic))) {
    targets.push(synthetic);
  }
  return targets;
}
