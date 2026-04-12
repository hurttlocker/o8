import type { RepoReadiness } from '@/lib/repos/types';
import type { ReviewChangedFile, ReviewWorktreeSummary } from '@/lib/fleet/types';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';

export type WorkspacePanelTabId = 'changes' | 'files' | 'env' | 'git-log';

export interface WorkspaceSidePanelRepo {
  name: string;
  localPath: string;
  branch?: string | null;
  readiness?: RepoReadiness | null;
  remoteUrl?: string;
  isWorktree?: boolean;
  worktreeStatus?: string | null;
}

export interface WorkspaceChatTargetOption {
  sessionKey: string;
  label: string;
  detail?: string | null;
}

export type WorkspaceSidePanelView = 'blank' | 'diff' | 'git-log';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface WorkspaceReviewCheckRun {
  databaseId: number;
  displayTitle: string;
  event: string;
  headBranch: string;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  workflowName: string;
  url: string;
}

export interface WorkspaceReviewCheckRunDetail {
  run: {
    databaseId: number;
    displayTitle: string;
    event: string;
    headBranch: string;
    headSha: string;
    status: string;
    conclusion: string;
    createdAt: string;
    updatedAt: string;
    workflowName: string;
    url: string;
    pullRequests?: Array<{ number: number; url: string }>;
    jobs?: Array<{
      databaseId: number;
      name: string;
      status: string;
      conclusion: string;
      startedAt: string;
      completedAt: string;
      url: string;
      annotations: Array<{
        path: string;
        startLine: number;
        endLine: number;
        level: string;
        message: string;
        title: string;
        rawDetails: string;
        blobUrl: string;
      }>;
    }>;
    annotations?: Array<{
      path: string;
      startLine: number;
      endLine: number;
      level: string;
      message: string;
      title: string;
      rawDetails: string;
      blobUrl: string;
      jobName?: string;
      jobUrl?: string;
    }>;
  };
  logs?: string;
}

export interface WorkspaceDeploymentItem {
  id: string;
  label: string;
  environment?: string;
  state: string;
  url?: string;
  sha?: string;
  createdAt?: string;
  target?: string;
  commitMessage?: string;
  source: 'vercel' | 'github';
}

export interface WorkspaceIssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
}

export interface WorkspaceReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  side: string;
  createdAt: string;
  state: string;
  diffHunk: string;
  inReplyTo: number | null;
}

export interface WorkspacePullRequestDetail {
  pr: {
    number: number;
    title: string;
    state?: 'open' | 'closed' | 'merged';
    reviewDecision?: string | null;
    headRefName?: string | null;
    url?: string;
    resolvedRepo?: string;
    reviewComments: WorkspaceReviewComment[];
    issueComments: WorkspaceIssueComment[];
    workflowStage?: { key?: string; label?: string } | null;
    readiness?: RepoReadiness | null;
  };
}

export interface WorkspaceResolvedPullRequest {
  number: number;
  title: string;
  state?: string;
  reviewDecision?: string | null;
  headRefName?: string | null;
  url?: string;
  isDraft?: boolean;
}

export interface WorkflowRunGroup {
  key: string;
  title: string;
  branch: string;
  updatedAt?: string;
  createdAt?: string;
  runs: WorkspaceReviewCheckRun[];
}

export interface WorkspaceGitLogCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  refs: { type: string; name: string }[];
}

export type { ReviewChangedFile, ReviewWorktreeSummary };
export type { AgentPanelChatInjectionPayload };
