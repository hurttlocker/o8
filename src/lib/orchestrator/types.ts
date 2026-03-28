export type OrchestratorRuntime = 'codex' | 'claude-code';

export type OrchestratorPacketStatus =
  | 'draft'
  | 'queued'
  | 'launching'
  | 'idle'
  | 'running'
  | 'awaiting_review'
  | 'recovering'
  | 'blocked'
  | 'released'
  | 'archived';

export type OrchestratorQueueState = 'draft' | 'queued' | 'held';
export type OrchestratorReleaseState = 'pending' | 'released';

export interface OrchestratorWorkspaceTarget {
  id: string;
  label: string;
  repoName: string;
  localPath: string;
  branch?: string | null;
  isWorktree?: boolean;
  worktreeStatus?: string | null;
}

export interface OrchestratorLaneBinding {
  tileId: string;
  tabId: string;
  repoPath: string | null;
  runtime: OrchestratorRuntime;
  sessionKey?: string | null;
  lastHeartbeatAt?: string | null;
  lastEventAt?: string | null;
  lastEventLabel?: string | null;
}

export interface OrchestratorPacket {
  id: string;
  referenceLabel: string;
  title: string;
  summary: string;
  workspaceTargetPath: string | null;
  branchTarget: string;
  runtime: OrchestratorRuntime;
  dependencyLabels: string[];
  dependencyPacketIds: string[];
  queueState: OrchestratorQueueState;
  releaseState: OrchestratorReleaseState;
  status: OrchestratorPacketStatus;
  blockedReason?: string | null;
  lastEventAt?: string | null;
  lastEventLabel?: string | null;
  archivedAt?: string | null;
  lane?: OrchestratorLaneBinding | null;
}

export interface OrchestratorMissionState {
  version: 2;
  prompt: string;
  summary: string;
  packets: OrchestratorPacket[];
  updatedAt: string;
}

export interface WorkspaceOrchestrationPacketBadge {
  packetId: string;
  referenceLabel: string;
  title: string;
  status: OrchestratorPacketStatus;
  runtime: OrchestratorRuntime;
  branchTarget?: string | null;
}

export interface OrchestratorLaneSnapshot {
  tileId: string;
  tabId: string;
  label: string;
  runtime: OrchestratorRuntime;
  sessionKey: string | null;
  repoPath: string | null;
  branch: string | null;
  status: 'idle' | 'running';
  lastActivityAt: string | null;
  packetId?: string | null;
}

export interface OrchestratorRuntimeTruth {
  sessionKey: string;
  runtime: OrchestratorRuntime;
  status: string;
  currentTask?: string | null;
  lastEventAt?: string | null;
  workflowStageLabel?: string | null;
}

export type WorkspaceLaneTranscriptState =
  | 'no_lane'
  | 'waiting_activity'
  | 'recovering'
  | 'missing'
  | 'ready';

export interface WorkspaceLaneState {
  tileId: string;
  tabId: string | null;
  kind: 'chat' | 'llm-chat' | 'terminal' | 'canvas' | null;
  title: string;
  subtitle: string | null;
  repoPath: string | null;
  branch: string | null;
  runtime: OrchestratorRuntime | null;
  sessionKey: string | null;
  packet: WorkspaceOrchestrationPacketBadge | null;
  status: OrchestratorPacketStatus | null;
  transcriptState: WorkspaceLaneTranscriptState;
  isAdHoc: boolean;
}
