export type O8Tab =
  | 'workspace'
  | 'browser'
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

export type RightUtilityTab = Extract<O8Tab, 'files' | 'side-chat' | 'browser' | 'review' | 'terminal' | 'inbox'>;

const RIGHT_UTILITY_TAB_IDS: RightUtilityTab[] = ['files', 'side-chat', 'browser', 'review', 'terminal', 'inbox'];

export function isRightUtilityTab(tab: O8Tab): tab is RightUtilityTab {
  return RIGHT_UTILITY_TAB_IDS.includes(tab as RightUtilityTab);
}
