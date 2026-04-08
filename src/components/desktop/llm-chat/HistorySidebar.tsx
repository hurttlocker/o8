import { memo } from 'react';
import { MessageSquare, PanelLeftClose, Star, Trash2 } from 'lucide-react';

import type { SavedChatRepoContext } from '@/lib/llm/chat-history';

import { THEME_ACCENT_SOFT, THEME_BG_CARD, type HistoryConversationItem } from './shared';

function HistorySidebarBase({
  groupedHistory,
  historyItems,
  historyLoading,
  historyOpen,
  historySearch,
  loadHistory,
  onClose,
  onHistorySearchChange,
  onOpenHistoryChat,
  toggleStar,
  deleteHistory,
}: {
  groupedHistory: Array<{ label: string; items: HistoryConversationItem[] }>;
  historyItems: HistoryConversationItem[];
  historyLoading: boolean;
  historyOpen: boolean;
  historySearch: string;
  loadHistory: (search?: string) => void;
  onClose: () => void;
  onHistorySearchChange: (value: string) => void;
  onOpenHistoryChat?: (historyTabId: string, title: string, repo?: SavedChatRepoContext | null) => void;
  toggleStar: (tabId: string, starred: boolean) => void;
  deleteHistory: (tabId: string) => void;
}) {
  return (
    <div style={{ width: historyOpen ? 260 : 0, minWidth: historyOpen ? 260 : 0, borderRight: historyOpen ? '1px solid var(--t-divider)' : 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', transition: 'width 200ms ease, min-width 200ms ease', background: 'var(--t-chat-surface-bg, #ffffff)' }}>
      {historyOpen ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, paddingRight: 10, paddingBottom: 12, paddingLeft: 14, borderBottom: '1px solid var(--t-divider)' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>History</span>
            <button type="button" onClick={onClose} style={{ display: 'flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4, borderRadius: 6 }}>
              <PanelLeftClose size={14} />
            </button>
          </div>
          <div style={{ paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10 }}>
            <input
              type="text"
              value={historySearch}
              onChange={(event) => {
                onHistorySearchChange(event.target.value);
                loadHistory(event.target.value || undefined);
              }}
              placeholder="Search conversations..."
              style={{ width: '100%', paddingTop: 7, paddingRight: 10, paddingBottom: 7, paddingLeft: 10, border: '1px solid var(--t-panel-border)', borderRadius: 8, fontSize: 12, outline: 'none', boxSizing: 'border-box', background: THEME_BG_CARD, transition: 'border-color 150ms' }}
              onFocus={(event) => {
                event.currentTarget.style.borderColor = 'var(--t-accent, #2563eb)';
              }}
              onBlur={(event) => {
                event.currentTarget.style.borderColor = 'var(--t-panel-border)';
              }}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
            {historyLoading ? (
              <div style={{ textAlign: 'center', paddingTop: 20, color: 'var(--t-text-muted)', fontSize: 12 }}>Loading...</div>
            ) : historyItems.length === 0 ? (
              <div style={{ textAlign: 'center', paddingTop: 20, color: 'var(--t-text-muted)', fontSize: 12 }}>{historySearch ? 'No matches' : 'No saved conversations'}</div>
            ) : (
              groupedHistory.map((group) => (
                <div key={group.label}>
                  <div style={{ paddingTop: 10, paddingBottom: 4, paddingLeft: 14, fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{group.label}</div>
                  {group.items.map((conversation) => (
                    <div
                      key={conversation.tabId}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 6, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 14, cursor: 'pointer', transition: 'background 100ms', borderRadius: 6, marginLeft: 4, marginRight: 4 }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.background = THEME_ACCENT_SOFT;
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background = 'transparent';
                      }}
                      onClick={() => {
                        if (!onOpenHistoryChat) return;
                        const historyRepo = conversation.repoName || conversation.repoPath ? {
                          name: conversation.repoName ?? undefined,
                          localPath: conversation.repoPath ?? undefined,
                          branch: conversation.repoBranch ?? undefined,
                          remoteUrl: conversation.remoteUrl ?? undefined,
                        } : null;
                        onOpenHistoryChat(conversation.tabId, conversation.title, historyRepo);
                      }}
                    >
                      <MessageSquare size={13} style={{ color: 'var(--t-text-muted)', marginTop: 2, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversation.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[conversation.repoBranch ? `${conversation.repoBranch}` : null, `${conversation.messageCount} msgs`, conversation.model.split('/').pop()].filter(Boolean).join(' | ')}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                        <button type="button" onClick={(event) => { event.stopPropagation(); toggleStar(conversation.tabId, !conversation.starred); }} style={{ border: 'none', background: 'transparent', cursor: 'pointer', paddingTop: 2, paddingRight: 2, paddingBottom: 2, paddingLeft: 2, color: conversation.starred ? '#f59e0b' : 'var(--t-text-faint)' }} title={conversation.starred ? 'Unstar' : 'Star'}>
                          <Star size={12} fill={conversation.starred ? '#f59e0b' : 'none'} />
                        </button>
                        <button type="button" onClick={(event) => { event.stopPropagation(); deleteHistory(conversation.tabId); }} style={{ border: 'none', background: 'transparent', cursor: 'pointer', paddingTop: 2, paddingRight: 2, paddingBottom: 2, paddingLeft: 2, color: 'var(--t-text-faint)' }} title="Delete">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export const HistorySidebar = memo(HistorySidebarBase);
