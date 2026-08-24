import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { LaneStatus } from '@/lib/lane/types';

type PacketTerminalFields = Pick<OrchestratorPacket, 'releaseState' | 'status' | 'archivedAt'>;
export type CanonicalPacketStatus = OrchestratorPacket['status'];

export function isPacketReleased(packet: Pick<OrchestratorPacket, 'releaseState' | 'status'>): boolean {
  return packet.releaseState === 'released';
}

export function isPacketFailed(packet: Pick<OrchestratorPacket, 'status'>): boolean {
  return packet.status === 'failed' || packet.status === 'blocked';
}

export function packetTerminalState(packet: PacketTerminalFields): 'released' | 'archived' | 'failed' | null {
  if (isPacketReleased(packet)) return 'released';
  if (packet.status === 'archived' || Boolean(packet.archivedAt)) return 'archived';
  if (isPacketFailed(packet)) return 'failed';
  return null;
}

export function packetStatusFromLaneStatus(status: LaneStatus | null | undefined): CanonicalPacketStatus | null {
  switch (status) {
    case 'launching': return 'launching';
    case 'running': return 'running';
    case 'reviewing':
    case 'merging':
      return 'awaiting_review';
    case 'recovering': return 'recovering';
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'awaiting_human':
      return 'blocked';
    case 'failed': return 'failed';
    case 'completed': return 'released';
    case 'archived': return 'archived';
    case 'paused':
    case 'idle':
      return 'idle';
    default:
      return null;
  }
}
