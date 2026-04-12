export const FOCUS_REPO_SETUP_EVENT = 'cortex:focus-repo-setup';
export const OPEN_REPO_WORKSPACE_EVENT = 'cortex:open-repo-workspace';
export const REQUEST_ADD_REPO_EVENT = 'cortex:request-add-repo';

export interface FocusRepoSetupDetail {
  repoId?: string;
  repoPath?: string;
}

export interface OpenRepoWorkspaceDetail {
  repoId?: string;
  repoPath?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RequestAddRepoDetail {}
