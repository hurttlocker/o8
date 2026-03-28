'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface ThoughtsHistoryEntry {
  tabId: string;
  title: string;
  preview: string;
  messageCount: number;
  model: string;
  savedAt: string;
  modifiedAt: string;
  starred: boolean;
  repoName?: string | null;
}

export interface ThoughtsHistoryPanelHandle {
  refresh: () => void;
}

export const ThoughtsHistoryPanel = forwardRef<ThoughtsHistoryPanelHandle, {
  visible: boolean;
  activeThreadId: string | null;
  onSelectThread: (tabId: string) => void;
  thoughtsBodyBackground: string;
  thoughtsElevatedSurface: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
}>(function ThoughtsHistoryPanel({
  visible,
  activeThreadId,
  onSelectThread,
  thoughtsBodyBackground,
  thoughtsElevatedSurface,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
}, ref) {
  const [entries, setEntries] = useState<ThoughtsHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fetchRef = useRef(0);

  const fetchHistory = useCallback(async () => {
    const id = ++fetchRef.current;
    setLoading(true);
    try {
      const res = await fetch('/api/v2/chat-history/list');
      if (!res.ok || id !== fetchRef.current) return;
      const data = await res.json() as { conversations?: ThoughtsHistoryEntry[] };
      const thoughts = (data.conversations ?? []).filter(
        (c) => c.tabId.startsWith('thoughts-'),
      );
      if (id === fetchRef.current) setEntries(thoughts);
    } catch {
      // silent
    } finally {
      if (id === fetchRef.current) setLoading(false);
    }
  }, []);

  const deleteThread = useCallback(async (tabId: string) => {
    setDeletingId(tabId);
    try {
      await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`, { method: 'DELETE' });
      setEntries(prev => prev.filter(e => e.tabId !== tabId));
    } catch { /* silent */ }
    setDeletingId(null);
  }, []);

  useEffect(() => {
    if (visible) void fetchHistory();
  }, [visible, fetchHistory]);

  useImperativeHandle(ref, () => ({ refresh: fetchHistory }), [fetchHistory]);

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  return (
    <div className="thoughts-scroll" style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      minHeight: 0,
    }}>
      <div style={{
        padding: '10px 12px 6px',
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 9,
          fontWeight: 700,
          textTransform: 'uppercase',
          color: 'var(--t-text-muted)',
          letterSpacing: '0.05em',
        }}>
          Conversations
        </div>
      </div>

      <div className="thoughts-scroll" style={{
        flex: 1,
        overflowY: 'auto',
        padding: '0 8px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: thoughtsBodyBackground,
        minHeight: 0,
      }}>
        {loading && entries.length === 0 && (
          <div style={{
            padding: '20px 0',
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--t-text-muted)',
          }}>
            Loading...
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div style={{
            padding: '20px 12px',
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--t-text-muted)',
            lineHeight: 1.6,
          }}>
            No conversations yet. Your Thoughts chats will appear here.
          </div>
        )}

        {entries.map((entry) => {
          const isActive = entry.tabId === activeThreadId;
          return (
            <button
              key={entry.tabId}
              type="button"
              onClick={() => onSelectThread(entry.tabId)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                padding: '8px 10px',
                borderRadius: 10,
                border: isActive ? '1px solid var(--t-accent-border)' : '1px solid transparent',
                background: isActive ? 'var(--t-accent-soft)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 120ms ease, border-color 120ms ease',
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <div style={{
                  flex: 1,
                  fontSize: 11,
                  fontWeight: 600,
                  color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  lineHeight: 1.3,
                }}>
                  {entry.title}
                </div>
                {entry.starred && (
                  <span style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: '#f59e0b',
                    flexShrink: 0,
                  }} />
                )}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteThread(entry.tabId);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void deleteThread(entry.tabId); } }}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 700,
                    lineHeight: 1,
                    color: 'var(--t-text-faint)',
                    opacity: deletingId === entry.tabId ? 0.3 : 0.6,
                    transition: 'opacity 120ms ease',
                  }}
                >
                  -
                </span>
              </div>
              <div style={{
                fontSize: 10,
                color: 'var(--t-text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 1.3,
              }}>
                {entry.preview}
              </div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 9,
                color: 'var(--t-text-muted)',
              }}>
                <span>{relativeTime(entry.modifiedAt)}</span>
                <span style={{ opacity: 0.4 }}>{entry.messageCount} msgs</span>
                {entry.repoName && (
                  <span style={{
                    marginLeft: 'auto',
                    opacity: 0.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 80,
                  }}>
                    {entry.repoName}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});
