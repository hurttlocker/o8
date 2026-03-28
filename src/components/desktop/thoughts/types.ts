import type { ApprovalRecord } from '@/lib/approvals/types';
import type {
  OrchestratorLaneBinding,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';

export type PendingApproval = ApprovalRecord;
export type ThoughtMode = 'orchestrate' | 'chat' | 'history';

export interface FleetAgent {
  name?: string;
  status?: string;
  currentTask?: string;
  context?: { usedPercent?: number };
  alerts?: number;
  sessionKey?: string;
  model?: string;
  lastEventAt?: string;
  activity?: { headline?: string };
  runtime?: string;
  isCurrentSession?: boolean;
  workspace?: string;
}

export interface AgentTarget {
  key: string;
  name: string;
  runtime: OrchestratorRuntime;
  color: string;
  workspace?: string | null;
  isCurrentSession?: boolean;
}

export interface ContextSuggestion {
  text: string;
  action: string;
  agent: AgentTarget;
  priority: 'info' | 'warn' | 'critical';
}

export interface ThoughtsCardProps {
  open: boolean;
  onClose: () => void;
  agents?: FleetAgent[];
  draftInjection?: { id: string; text: string } | null;
  docked?: boolean;
  missionState: OrchestratorMissionState;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  onMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  onLaunchPacket?: (packet: OrchestratorPacket) => Promise<OrchestratorLaneBinding | null> | OrchestratorLaneBinding | null;
  onFocusPacket?: (packet: OrchestratorPacket) => void;
}
