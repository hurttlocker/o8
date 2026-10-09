import { attentionRank, type AttentionSubject } from './sections';

export type ChatGroupMode = 'repo' | 'date' | 'flat' | 'chronological' | 'working' | 'scheduled';
export const CHAT_GROUP_BY_KEY = 'o8:chat-group-by';
export const CHAT_VIEW_LABELS: Record<ChatGroupMode, string> = {
  flat: 'Priority', chronological: 'Chronological', working: 'Working', scheduled: 'Scheduled',
  repo: 'By repo', date: 'By date',
};
export function isChatGroupMode(value: unknown): value is ChatGroupMode {
  return typeof value === 'string' && Object.hasOwn(CHAT_VIEW_LABELS, value);
}
/** Working view keeps decisions and the selected thread reachable, but excludes idle/queued work. */
export function staysInWorkingView(subject: AttentionSubject, selected = false): boolean {
  if (selected || attentionRank(subject) > 0) return true;
  if (subject.outcome) return false;
  return ['running', 'working', 'active', 'launching', 'merging', 'huddling'].includes(subject.status ?? '');
}
