import type { LaneMergeMode } from '@/lib/lane/merge-mode';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketContextObservation } from '@/lib/orchestrator/packet-context-telemetry';

export function preferRuntimeRecoveryMessage(reason: string | null | undefined, recovery: string | null | undefined) {
  return (!reason || reason === 'runtime_process_exit' || reason === 'Awaiting operator input')
    ? recovery ?? reason : reason;
}

export function applyLanePendingStatus(packet: OrchestratorPacket, lane: DomainLaneSummary): boolean {
  if (lane.status === 'merging') {
    packet.status = 'awaiting_review';
    packet.blockedReason = 'Merge in progress';
    return true;
  }
  if (lane.status === 'launching' && lane.provisioningQueuePosition) {
    packet.status = 'launching';
    packet.lastEventLabel = 'worktree_provision_queued';
    packet.blockedReason = `Queued for provisioning (position ${lane.provisioningQueuePosition}).`;
    return true;
  }
  return false;
}

export interface DomainLaneSummary {
  laneId: string;
  packetId: string;
  status: string;
  sessionKey: string | null;
  lastEventLabel: string | null;
  failureMessage?: string | null;
  provisioningQueuePosition?: number | null;
  authRecoveryRequired?: boolean;
  recovery?: OrchestratorPacket['recovery'];
  contextObservation?: PacketContextObservation;
  branch?: string;
  repoPath?: string;
  label?: string;
  mergeMode?: LaneMergeMode;
  mergeModeNote?: string | null;
}
