export type RepoIssue = { number: number; title: string; url?: string; labels?: string[] };

export type ReviewChangedFile = {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  additions?: number | null;
  deletions?: number | null;
};

export type ReviewSnapshot = {
  changedFiles?: ReviewChangedFile[];
  diffStat?: string;
  warnings?: string[];
  recentCommits?: string[];
  error?: string;
};

export type ReviewPanelState = {
  loaded: boolean;
  loading: boolean;
  laneId: string | null;
  worktreePath: string | null;
  repoPath: string | null;
  snapshot: ReviewSnapshot | null;
  error: string | null;
  action: 'create_pr' | 'merge' | null;
  actionError: string | null;
  actionNote: string | null;
  prUrl: string | null;
  showAllFiles: boolean;
};

export type RepoIssuesGroup = {
  repoId: string;
  repoName: string;
  slug: string;
  issues: RepoIssue[];
};

export type EditingField = {
  packetId: string;
  field: 'summary' | 'runtime' | 'repo' | 'branch';
} | null;
