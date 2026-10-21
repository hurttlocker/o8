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

/** Restore current tools and the supported aliases from older saved layouts. */
export function normalizePanelTab(raw: string | null | undefined): O8Tab | null {
  if (!raw) return null;
  if (raw === 'diff' || raw === 'changes' || raw === 'workspace') return 'review';
  if (raw === 'prs') return 'activity';
  return isRightUtilityTab(raw as O8Tab) || raw === 'launcher' || raw === 'compare' || raw === 'handoffs'
    ? raw as O8Tab : null;
}
