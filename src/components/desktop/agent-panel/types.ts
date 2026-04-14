import type { RuntimeSurfaceSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { WorkflowStageBadge } from '@/lib/workflows/status';

export interface AgentDetail {
  id: string;
  name: string;
  squadId: string;
  model: string;
  primaryModel?: string;
  heartbeatModel?: string;
  status: string;
  currentTask: string;
  workspace: string;
  repo?: string;
  sessionKey: string;
  lastEventAt: string;
  surfaceLabel: string;
  isCurrentSession: boolean;
  alerts: number;
  context?: { usedPercent: number; trend: string };
  tokenUsage?: { totalTokens: number; remainingTokens: number };
  branch?: string;
  pr?: {
    number: number;
    title: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    state: 'open' | 'merged' | 'closed';
    url: string;
  };
  localDiff?: { additions: number; deletions: number; changedFiles: number };
  activity?: { coding: number; thinking: number; testing: number; idle: number };
  workspaceStatus?: 'in_progress' | 'in_review' | 'done' | 'idle' | 'cancelled';
  workflowStage?: WorkflowStageBadge | null;
  tmuxSession?: string;
  runtimeSurface?: RuntimeSurfaceSummary;
  worktree?: WorktreeInfo;
  lifecycleState?: 'active' | 'completed' | 'failed' | 'killed' | 'stalled';
  exitCode?: number;
  lifecycleTs?: number;
  repoReadiness?: RepoReadiness;
}

export interface EventEntry {
  id: string;
  agentId: string;
  squadId: string;
  severity: string;
  title: string;
  detail: string;
  timestamp: string;
}

export interface GHIssue {
  number: number;
  title: string;
  labels: { name: string; color: string }[];
  state?: string;
  author?: { login?: string | null } | null;
  assignees?: Array<{ login?: string | null }>;
  comments?: number;
  body?: string;
  createdAt?: string;
}

export interface GHPullRequest {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  labels: { name: string; color: string }[];
  reviewDecision?: string;
  statusCheckRollup?: Array<{ name?: string | null; conclusion?: string | null; status?: string | null }>;
}

export interface PRHoverDetail {
  mergeable: boolean;
  checksStatus: 'success' | 'failure' | 'pending' | 'unknown';
  reviewDecision: string | null;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
}

export interface CIHoverDetail {
  failingJobs: Array<{ name: string; failingStep?: string | null }>;
  summaryLine: string | null;
}

export interface WorkspaceGroup {
  workspace: string;
  displayName: string;
  repo: string;
  agents: AgentDetail[];
  hasRunning: boolean;
  bestContextPct: number;
  primaryModel: string;
  totalAlerts: number;
}

export interface CommitSummary {
  hash: string;
  message: string;
  age: string;
}

export type ActivityItem =
  | { kind: 'commit'; hash: string; message: string; age: string; ts: number; repo?: string }
  | { kind: 'event'; data: EventEntry; ts: number }
  | {
      kind: 'issue';
      number: number;
      title: string;
      state: string;
      labels: { name: string; color: string }[];
      age: string;
      ts: number;
      repo: string;
      author: string;
      assignees: string[];
      comments: number;
      body: string;
    }
  | {
      kind: 'pr';
      number: number;
      title: string;
      state: string;
      author: string;
      branch: string;
      additions: number;
      deletions: number;
      changedFiles: number;
      age: string;
      ts: number;
      repo: string;
      reviewDecision?: string;
      checkSummary?: { passed: number; failed: number; pending: number };
      failingChecks?: string[];
    }
  | { kind: 'ci'; id: number; title: string; status: string; conclusion: string; branch: string; workflow: string; age: string; ts: number; repo: string };

export type RepoTaskLaunchRequest =
  | { kind: 'issue'; repo: string; number: number; title: string; body?: string }
  | { kind: 'pr'; repo: string; number: number; title: string; branch?: string };

export type FeedFilter = 'all' | 'commit' | 'issue' | 'pr' | 'ci';

export interface WorkspaceAgentLaunchRequest {
  repoPath: string;
  runtime?: 'codex' | 'claude-code';
  modelId?: string;
  initialText?: string;
  autoSend?: boolean;
  createNew?: boolean;
  label?: string;
}

export interface AgentPanelProps {
  activeSessionKey?: string | null;
  selectedRepo?: string | null;
  selectedRepoBranch?: string | null;
  selectedRepoLocalPath?: string | null;
  activeWorkspacePath?: string | null;
  selectedRepoReadiness?: RepoReadiness | null;
  onLaunchWorkspaceAgent?: (request: WorkspaceAgentLaunchRequest) => Promise<void>;
  onLaunchWorkspaceTask?: (request: RepoTaskLaunchRequest) => Promise<void>;
  onSelectSession?: (sessionKey: string) => void;
  onSelectRepo?: (repoId: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onRepoRemoved?: (repo: RepoRegistryEntry) => void;
  onExpandWorkspace?: (workspace: string, repo: string | null) => void;
  onSelectFile?: (filePath: string, workspace?: string) => void;
  onOpenCI?: (repo: string) => void;
  onCreateIssue?: (repo?: string) => void;
  onOpenGitLog?: (workspace?: string) => void;
  onOpenDeploy?: (project?: string) => void;
  onAgentsUpdate?: (agents: AgentDetail[]) => void;
  onAgentKill?: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
  lifecycleEvents?: Map<string, { state: string; exitCode?: number; ts: number }>;
  orchestratorPackets?: OrchestratorPacket[];
  ideWorkspaceSessions?: MobileInboxSnapshot['sessions'];
}
