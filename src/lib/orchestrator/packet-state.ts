import type { OrchestratorPacket } from '@/lib/orchestrator/types';

type PacketTerminalFields = Pick<OrchestratorPacket, 'releaseState' | 'status' | 'archivedAt'>;

export function isPacketReleased(packet: Pick<OrchestratorPacket, 'releaseState' | 'status'>): boolean {
  return packet.releaseState === 'released' || packet.status === 'released';
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
