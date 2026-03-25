export const FOCUS_REPO_SETUP_EVENT = 'cortex:focus-repo-setup';
export const OPEN_REPO_WORKSPACE_EVENT = 'cortex:open-repo-workspace';

export interface FocusRepoSetupDetail {
  repoId?: string;
  repoPath?: string;
}

export interface OpenRepoWorkspaceDetail {
  repoId?: string;
  repoPath?: string;
}
