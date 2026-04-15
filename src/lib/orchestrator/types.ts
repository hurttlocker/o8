import type { OrchestratorReviewFinding } from '@/lib/approvals/types';

export type OrchestratorRuntime = 'codex' | 'claude-code';
export type OrchestratorPacketReviewSeverity = 'info' | 'warning' | 'high';

export type OrchestratorPacketStatus =
  | 'draft'
  | 'queued'
  | 'launching'
  | 'idle'
  | 'running'
  | 'awaiting_review'
  | 'recovering'
  | 'failed'
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
  worktreePath?: string | null;
  runtime: OrchestratorRuntime;
  sessionKey?: string | null;
  laneId?: string | null;
  lastHeartbeatAt?: string | null;
  lastEventAt?: string | null;
  lastEventLabel?: string | null;
}

export interface OrchestratorPacketReviewFinding {
  file: string;
  line?: number | null;
  severity: OrchestratorPacketReviewSeverity;
  description: string;
  resolution: 'fixed' | 'accepted' | 'deferred';
}

export interface OrchestratorPacketReview {
  approved: boolean;
  findings: OrchestratorPacketReviewFinding[];
  recordedAt: string;
  summary: string;
  auditApprovalId?: string | null;
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
  attemptCount?: number;
  maxAttempts?: number;
  recoveryCount?: number;
  lastRecoveryAt?: string | null;
  blockedReason?: string | null;
  lastEventAt?: string | null;
  lastEventLabel?: string | null;
  archivedAt?: string | null;
  review?: OrchestratorPacketReview | null;
  lane?: OrchestratorLaneBinding | null;
  /** When set, dispatch fans out N parallel lanes — one per model. */
  comparisonModels?: string[];
  /** Links sibling packets spawned from the same best-of-n group. */
  comparisonGroupId?: string | null;
  /** Index within a comparison group (0, 1, 2...). */
  comparisonIndex?: number;
  /** The model this specific packet runs on (set during fan-out). */
  assignedModel?: string | null;
  /** Files predicted to be touched, computed from packet scope vs skeleton cache */
  predictedFiles?: string[];
}

export interface OrchestratorMissionState {
  version: 2;
  missionId?: string;
  prompt: string;
  summary: string;
  repoPath?: string | null;
  runtime?: OrchestratorRuntime;
  constraints?: string;
  packets: OrchestratorPacket[];
  /** Active comparison group IDs for rendering the picker UI. */
  activeComparisonGroups?: string[];
  updatedAt: string;
}

export type PacketSelfReviewConfidence = 'high' | 'medium' | 'low';

export interface PacketSelfReview {
  passed: boolean;
  confidence: PacketSelfReviewConfidence;
  summary: string;
  issuesFound?: string[];
}

export interface PacketContext {
  packetId: string;
  sessionKey: string;
  summary: string;
  changedFiles: string[];
  attemptLearnings?: string[];
  selfReview?: PacketSelfReview;
  reviewFindings?: OrchestratorReviewFinding[];
  patterns?: string[];
  conflictZones?: string[];
  completedAt: string;
  model: string;
  review?: {
    reviewer?: string;
    approved: boolean;
    diffSha?: string;
    findings: OrchestratorReviewFinding[];
    reviewedAt: string;
  };
}

export interface DagNode {
  packetId: string;
  title: string;
  status: OrchestratorPacketStatus;
  dependsOn: string[];
  blockedBy: string[];
  wave: number;
}

export interface OrchestratorDagWave {
  wave: number;
  packetIds: string[];
  packets: DagNode[];
}

export interface OrchestratorDagMetadata {
  currentWave: number;
  totalWaves: number;
  waves: OrchestratorDagWave[];
}

export interface OrchestratorStateApiResponse {
  mission: OrchestratorMissionState;
  dag: OrchestratorDagMetadata;
}

export interface OrchestratorStateApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
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
  kind: 'chat' | 'llm-chat' | 'terminal' | 'canvas' | 'orchestrator' | null;
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
