// Types for PrPanel — mirrors the shape returned by /api/panel/prs/[number].
// The detail endpoint sources from `fetchGitHubPullRequestDetail` +
// `fetchGitHubPullRequestComments` then layers `resolvedRepo`, `readiness`,
// `workflowStage`, `reviewComments`, `issueComments`, `diffStat` on top.

export type PrTabId = 'changes' | 'checks' | 'commits' | 'reviews';

export interface PrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PrCheck {
  name: string;
  status?: string | null;
  conclusion?: string | null;
}

export interface PrReviewComment {
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

export interface PrIssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
}

export interface PrDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeable: boolean;
  reviewDecision: string | null;
  statusCheckRollup: PrCheck[];
  url: string;
  files: PrFile[];
  resolvedRepo?: string;
  reviewComments: PrReviewComment[];
  issueComments: PrIssueComment[];
  diffStat?: string;
}

export interface PrDetailResponse {
  pr: PrDetail;
}

export type CheckBucket = 'failing' | 'running' | 'passed' | 'neutral' | 'skipped';

export interface PrPanelProps {
  prNumber: number;
  repoSlug?: string | null;
  onClose: () => void;
}
