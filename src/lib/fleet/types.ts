export type AgentStatus =
  | 'idle'
  | 'running'
  | 'blocked'
  | 'waiting'
  | 'reviewing'
  | 'failed';

export type SquadStatus = 'healthy' | 'watching' | 'degraded' | 'blocked';

export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'denied';

export type EventSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface ContextPressure {
  usedPercent: number;
  trend: 'falling' | 'stable' | 'rising';
}

export interface CostSnapshot {
  sessionUsd: number;
  dailyUsd: number;
}

export interface TokenUsageSnapshot {
  totalTokens?: number | null;
  remainingTokens?: number | null;
  fresh?: boolean;
}

export interface RuntimeSurfaceCapabilities {
  attach: boolean;
  readTail: boolean;
  sendInput: boolean;
  interrupt: boolean;
  resize: boolean;
  diffContext: boolean;
  reviewContext: boolean;
}

export interface RuntimeSurfaceSummary {
  id: string;
  runtime: string;
  kind: 'chat-session' | 'terminal-session' | 'runtime-session';
  ownership: 'provider' | 'discovered' | 'owned';
  title: string;
  cwd?: string;
  branch?: string;
  sourceLabel: string;
  tailSourceLabel?: string;
  capabilities: RuntimeSurfaceCapabilities;
  reviewContext?: {
    repoSlug?: string;
    branch?: string;
    head?: string;
  };
}

export interface AgentSummary {
  id: string;
  name: string;
  squadId: string;
  runtime: string;
  model: string;
  status: AgentStatus;
  currentTask: string;
  workspace: string;
  branch: string;
  sessionKey: string;
  approvalStatus: ApprovalStatus;
  lastEventAt: string;
  context: ContextPressure;
  cost?: CostSnapshot;
  alerts: number;
  sessionId?: string;
  sessionKind?: string;
  surfaceLabel?: string;
  isCurrentSession?: boolean;
  tokenUsage?: TokenUsageSnapshot;
  runtimeSurface?: RuntimeSurfaceSummary;
}

export interface SquadSummary {
  id: string;
  name: string;
  status: SquadStatus;
  throughputLabel: string;
  blockers: number;
  alerts: number;
  liveSessions: number;
  members: string[];
}

export interface ReviewArtifact {
  kind: 'diff' | 'pull_request' | 'doc' | 'screenshot' | 'run_log';
  title: string;
  href?: string;
  state: 'new' | 'reviewing' | 'approved';
  agentId?: string;
  detail?: string;
}

export interface ReviewChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  additions?: number | null;
  deletions?: number | null;
}

export interface ReviewWorktreeSummary {
  path: string;
  branch?: string;
  head?: string;
  isCurrent: boolean;
  isDetached?: boolean;
  isBare?: boolean;
  lockedReason?: string;
  prunableReason?: string;
}

export interface ReviewPullRequestSummary {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  body?: string;
  linkedIssueNumbers?: number[];
}

export interface ReviewIssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
}

export interface WorkflowReviewSnapshot {
  generatedAt: string;
  repoSlug: string;
  repoPath: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: ReviewChangedFile[];
  diffStat: string;
  recentCommits: string[];
  worktrees: ReviewWorktreeSummary[];
  pullRequests: ReviewPullRequestSummary[];
  activeIssue?: ReviewIssueSummary;
  activeIssues: ReviewIssueSummary[];
  warnings?: string[];
}

export interface EventItem {
  id: string;
  agentId?: string;
  squadId?: string;
  severity: EventSeverity;
  title: string;
  detail: string;
  timestamp: string;
}

export interface FleetMeta {
  mode: 'live' | 'demo';
  sourceLabel: string;
  gatewayLabel?: string;
  primarySessionKey?: string;
  mirrorMode: 'current-session-first' | 'demo-only';
  note?: string;
}

export interface FleetSnapshot {
  generatedAt: string;
  meta: FleetMeta;
  squads: SquadSummary[];
  agents: AgentSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
}
