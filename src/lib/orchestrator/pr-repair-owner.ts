import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listLanes } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
export const samePrRepairRepo = (left: string, right: string) => canonical(left) === canonical(right);
export function repairPacketStillOwned(packet: OrchestratorPacket, lanes: Lane[]): boolean {
  if (packet.archivedAt) return false;
  const linked = lanes.filter(lane => lane.packetId === packet.id || lane.id === packet.lane?.laneId);
  // An unbound launch is uncertain, not retired. Only explicit terminal lane
  // evidence releases ownership while preserving the packet's audit receipt.
  return linked.length === 0 || linked.some(lane => lane.status !== 'archived' && lane.status !== 'completed');
}
export function findPrRepairOwner(repoPath: string, number: number, exceptPacketId?: string) {
  const lanes = listLanes();
  const lane = lanes.find(lane => lane.prNumber === number && samePrRepairRepo(lane.repoPath, repoPath)
    && lane.status !== 'archived' && lane.status !== 'completed'
    && (!exceptPacketId || lane.packetId !== exceptPacketId));
  if (lane) return lane;
  const packet = readOrchestratorControlPlaneState().packets.find(packet => packet.id !== exceptPacketId && repairPacketStillOwned(packet, lanes)
    && packet.workspaceTargetPath && samePrRepairRepo(packet.workspaceTargetPath, repoPath) && packet.repairSource?.pullRequest === number);
  if (!packet) return undefined;
  return { id: lanes.find(candidate => candidate.packetId === packet.id)?.id ?? packet.lane?.laneId ?? undefined, packetId: packet.id };
}
export class PrRepairOwnerError extends Error {
  readonly code = 'pr_has_owner';
  constructor(readonly ownerLaneId?: string) { super('This PR already has an owning worker. Send the failing checks to that worker instead.'); }
}
