export interface MinimalMissionPacket {
  id?: string;
  status?: string;
  releaseState?: string;
  blockedReason?: string | null;
  blockedBy?: unknown;
  lane?: {
    status?: string;
  } | null;
}

export interface MinimalMissionStatusShape {
  packets?: MinimalMissionPacket[];
  currentWave?: number;
  totalWaves?: number;
}

// Packets in these states need caller attention unless authoritative lane
// evidence says a rerun is still active.
const PACKET_ATTENTION_STATUSES = new Set(['awaiting_review', 'released', 'failed', 'archived', 'blocked']);

export function missionPacketSignature(packets: MinimalMissionPacket[] | undefined): string {
  if (!Array.isArray(packets)) return '';
  return packets
    .map((packet) => `${packet.id ?? ''}:${packet.status ?? ''}:${packet.releaseState ?? ''}:${packet.blockedReason ?? ''}:${packet.lane?.status ?? ''}`)
    .sort()
    .join(',');
}

function packetIsActive(packet: MinimalMissionPacket): boolean {
  return packet.blockedReason === 'rerun_in_progress'
    || packet.lane?.status === 'running';
}

export function findMissionAttentionPacket(
  status: MinimalMissionStatusShape,
  packetIdFilter: string | null,
): MinimalMissionPacket | null {
  for (const packet of status.packets ?? []) {
    if (packetIdFilter && packet.id !== packetIdFilter) continue;
    if (packetIsActive(packet)) continue;
    if (typeof packet.status === 'string' && PACKET_ATTENTION_STATUSES.has(packet.status)) {
      return packet;
    }
  }
  return null;
}
