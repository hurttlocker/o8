export const FOCUS_REPO_SETUP_EVENT = 'cortex:focus-repo-setup';
export const OPEN_REPO_WORKSPACE_EVENT = 'cortex:open-repo-workspace';
/** Focus an existing workspace tab for a repo, or open one when unbound. */
export const FOCUS_REPO_WORKSPACE_TAB_EVENT = 'o8:focus-repo-workspace-tab';
export const REQUEST_ADD_REPO_EVENT = 'cortex:request-add-repo';
/** Open the full-screen mobile-pairing QR view (a canvas tab). */
export const OPEN_MOBILE_PAIRING_EVENT = 'cortex:open-mobile-pairing';
/** Open the desktop Settings overlay to a specific tab. */
export const OPEN_SETTINGS_TAB_EVENT = 'cortex:open-settings-tab';

export interface FocusRepoSetupDetail {
  repoId?: string;
  repoPath?: string;
}

export interface OpenRepoWorkspaceDetail {
  repoId?: string;
  repoPath?: string;
}

export interface FocusRepoWorkspaceTabDetail {
  repoId?: string;
  repoPath?: string;
}

export function dispatchFocusRepoWorkspaceTab(detail: FocusRepoWorkspaceTabDetail): boolean {
  if (typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent(FOCUS_REPO_WORKSPACE_TAB_EVENT, { detail }));
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RequestAddRepoDetail {}

export interface OpenSettingsTabDetail {
  /** A `SettingsTab` value — kept loose here so this lib file stays free of
   *  component imports. The page-level listener narrows it. */
  tab: string;
}
