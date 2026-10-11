export type O8Tab =
  | 'workspace'
  | 'browser'
  | 'device'
  | 'prs'
  | 'activity'
  | 'threads'
  | 'resources'
  | 'handoffs'
  | 'inbox'
  | 'spec'
  | 'launcher'
  | 'files'
  | 'side-chat'
  | 'review'
  | 'compare'
  | 'targets'
  | 'terminal';

export type RightUtilityTab = Exclude<O8Tab, 'workspace' | 'prs' | 'handoffs' | 'launcher' | 'compare'>;

const RIGHT_UTILITY_TAB_IDS: RightUtilityTab[] = ['files', 'browser', 'device', 'terminal', 'review', 'inbox', 'spec', 'threads', 'activity', 'side-chat', 'resources', 'targets'];

/** Legacy destinations keep working without a second discovery entry. */
export function canonicalPanelTab(tab: O8Tab): O8Tab {
  return tab === 'workspace' ? 'review' : tab === 'handoffs' ? 'threads' : tab === 'prs' ? 'activity' : tab;
}

export function isRightUtilityTab(tab: O8Tab): tab is RightUtilityTab {
  return RIGHT_UTILITY_TAB_IDS.includes(tab as RightUtilityTab);
}
