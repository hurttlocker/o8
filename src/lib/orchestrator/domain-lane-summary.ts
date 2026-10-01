import type { LaneMergeMode } from '@/lib/lane/merge-mode';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketContextObservation } from '@/lib/orchestrator/packet-context-telemetry';

export function preferRuntimeRecoveryMessage(reason: string | null | undefined, recovery: string | null | undefined) {
  return (!reason || reason === 'runtime_process_exit' || reason === 'Awaiting operator input')
    ? recovery ?? reason : reason;
}

export interface DomainLaneSummary {
  laneId: string;
  packetId: string;
  status: string;
  sessionKey: string | null;
  lastEventLabel: string | null;
  failureMessage?: string | null;
  authRecoveryRequired?: boolean;
  recovery?: OrchestratorPacket['recovery'];
  contextObservation?: PacketContextObservation;
  branch?: string;
  repoPath?: string;
  label?: string;
  mergeMode?: LaneMergeMode;
  mergeModeNote?: string | null;
}
