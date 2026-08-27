import type { LaneMergeMode } from '@/lib/lane/merge-mode';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketContextObservation } from '@/lib/orchestrator/packet-context-telemetry';

export interface DomainLaneSummary {
  laneId: string;
  packetId: string;
  status: string;
  sessionKey: string | null;
  lastEventLabel: string | null;
  recovery?: OrchestratorPacket['recovery'];
  contextObservation?: PacketContextObservation;
  branch?: string;
  repoPath?: string;
  label?: string;
  mergeMode?: LaneMergeMode;
  mergeModeNote?: string | null;
}
