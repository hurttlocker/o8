// Orchestrator domain types — runtimes, packets, lanes
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';

export type OrchestratorRuntime = 'codex' | 'claude-code' | 'gemini' | 'opencode';
export type OrchestrationMode = 'fleet' | 'single' | 'chat';
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

export interface OrchestratorReleaseStatePayload {
  mergeCommit?: string | null;
  releasedAt?: string | null;
  source?: string | null;
}

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
  fixSuggestion?: string | null;
}

export interface OrchestratorPacketReview {
  approved: boolean;
  findings: OrchestratorPacketReviewFinding[];
  recordedAt: string;
  reviewedHeadSha?: string | null;
  summary: string;
  auditApprovalId?: string | null;
}

/**
 * Tagged packet variants the pipeline can recognize. Default (undefined) is
 * a regular feature/fix packet driven by an issue. `decompose` is reserved
 * for post-merge decomposition packets fanned out by the governance
 * pipeline (#538) — those run at queue tail and carry {@link
 * OrchestratorDecompositionMetadata}.
 */
export type OrchestratorPacketType = 'decompose';

/**
 * Metadata carried by a `decompose` packet. `targetFile` is the repo-relative
 * path that tripped the 800-line ceiling; `postMergeSha` is the merge commit
 * whose diff pushed the file over the threshold (used to diff the parent and
 * confirm the merge actually added lines, so pre-existing debt is skipped).
 */
export interface OrchestratorDecompositionMetadata {
  targetFile: string;
  postMergeSha: string;
  lineCount: number;
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
  releaseStatePayload?: OrchestratorReleaseStatePayload | null;
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
  /**
   * Tag for governance-issued packets. When `decompose`, the packet is a
   * post-merge cleanup fanned out by the decomposition pipeline (#538); the
   * concrete metadata lives in {@link OrchestratorPacket.decomposition}.
   */
  packetType?: OrchestratorPacketType;
  /**
   * Decomposition metadata. Only populated when `packetType === 'decompose'`.
   * Allows downstream consumers (dashboards, rule-check, audit) to identify
   * a governance cleanup packet without parsing titles.
   */
  decomposition?: OrchestratorDecompositionMetadata;
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
  /** Rendered packet prompt body (surfaced in details popover). Optional. */
  prompt?: string;
  /** Files allowed to be touched by this packet. Alias of predictedFiles when present. */
  allowedFiles?: string[];
  /** Learned guardrails injected into the packet's prompt (surfaced in details popover). */
  learnedRules?: string[];
  /** Snapshot of the originating GitHub issue for the details popover. */
  issue?: {
    number?: number;
    body?: string;
    url?: string;
  } | null;
  /**
   * Read-before-write scaffolding (#535). Pre-computed at dispatch time by
   * `computeReadBudget` and rendered into the packet prompt so weaker models
   * behave like Codex xhigh: read the adjacent surface first, write second.
   *
   * Undefined on legacy packets — absence must NOT change behaviour.
   */
  readBudget?: {
    /** Minimum read-only tool calls required before write tools should unlock. */
    minToolCalls: number;
    /** Pre-computed 1–2 hop import-graph fan-out that should be read first. */
    requiredReads: string[];
    /** When true, the first assistant turn must emit a plan before writes. */
    planBeforeWrite: boolean;
  };
  /**
   * Edge-case surfacer output (#536). Populated by the static AST walker at
   * dispatch-prep time — plain-text descriptions of conditional branches,
   * error handlers, and reconciliation paths the model should watch for.
   *
   * Undefined on legacy packets — absence must NOT change behaviour.
   */
  edgeCaseSites?: Array<{
    /** `src/lib/foo.ts:120` — stable human-readable location. */
    location: string;
    /** One-sentence description of what could go wrong at this site. */
    description: string;
    /** Optional category for grouping in the prompt. */
    kind?: 'conditional' | 'error-handler' | 'reconciliation' | 'archive' | 'loop-exit' | 'other';
  }>;
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
  projectId?: string | null;
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
