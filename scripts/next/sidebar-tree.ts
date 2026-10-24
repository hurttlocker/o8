import { attentionRank } from '@/components/desktop/repo-focus/tabs/chats/sections';
import { staysInWorkingView } from '@/components/desktop/repo-focus/tabs/chats/sidebar-view';

export interface SidebarSession {
  id: string; title: string; status: string; lastMessageAt: string;
  outcome?: string | null; rejected?: boolean; unread?: boolean;
}

/** The native labels project the web's working filter and attention ordering. */
export function sidebarTree(sessions: SidebarSession[], selected: string | null = null) {
  return ['working', 'review', 'recent'].flatMap(kind => {
    const rows = sessions.filter(session => {
      const attention = attentionRank(session);
      const group = attention > 0 ? 'review' : staysInWorkingView(session) ? 'working' : 'recent';
      return group === kind;
    }).sort((a, b) => (kind === 'review' ? attentionRank(b) - attentionRank(a) : 0)
      || Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
    return rows.length ? [{ kind, rows: rows.map(row => ({ id: row.id, title: row.title,
      status: row.status, selected: row.id === selected })) }] : [];
  });
}
