'use client';

/**
 * OrchestratorHistorySidebar — collapsible left drawer for browsing past
 * orchestrator conversations. Visually parallels the Assistant tab's
 * HistorySidebar but wired to the orchestrator history endpoint
 * (`/api/v2/chat-history/list` filtered by the `thoughts-` prefix).
 *
 * Renders inline inside the Orchestrator tab. When closed, it collapses
 * to zero width; when open, it takes ~260px and the chat narrows.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquare, PanelLeftClose, Trash2 } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from '@/components/desktop/repo-registry/shared';

interface OrchestratorThread {
  tabId: string;
  title: string;
  modifiedAt: string;
  messageCount?: number;
  model?: string;
}

function threadRuntime(model?: string): 'claude-code' | 'codex' | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('codex') || lower.startsWith('gpt')) return 'codex';
  return null;
}

interface OrchestratorHistorySidebarProps {
  open: boolean;
  currentThreadId: string | null;
  onClose: () => void;
  onSelectThread: (tabId: string) => void;
}

function groupThreads(threads: OrchestratorThread[]): Array<{ label: string; items: OrchestratorThread[] }> {
  const today: OrchestratorThread[] = [];
  const yesterday: OrchestratorThread[] = [];
  const thisWeek: OrchestratorThread[] = [];
  const older: OrchestratorThread[] = [];

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  for (const thread of threads) {
    const ts = new Date(thread.modifiedAt).getTime();
    if (ts >= startOfToday) today.push(thread);
    else if (ts >= startOfYesterday) yesterday.push(thread);
    else if (ts >= startOfWeek) thisWeek.push(thread);
    else older.push(thread);
  }

  const groups: Array<{ label: string; items: OrchestratorThread[] }> = [];
  if (today.length > 0) groups.push({ label: 'Today', items: today });
  if (yesterday.length > 0) groups.push({ label: 'Yesterday', items: yesterday });
  if (thisWeek.length > 0) groups.push({ label: 'This week', items: thisWeek });
  if (older.length > 0) groups.push({ label: 'Older', items: older });
  return groups;
}

function OrchestratorHistorySidebarBase({
  open,
  currentThreadId,
  onClose,
  onSelectThread,
}: OrchestratorHistorySidebarProps) {
  const [threads, setThreads] = useState<OrchestratorThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchThreads = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v2/chat-history/list');
      if (!res.ok) return;
      const data = await res.json() as {
        conversations?: Array<{ tabId: string; title?: string; modifiedAt: string; messageCount?: number; model?: string }>;
      };
      const filtered = (data.conversations ?? [])
        .filter((c) => c.tabId.startsWith('thoughts-'))
        .map((c) => ({
          tabId: c.tabId,
          title: c.title?.trim() || 'Untitled conversation',
          modifiedAt: c.modifiedAt,
          messageCount: c.messageCount,
          model: c.model,
        }));
      setThreads(filtered);
    } catch {
      // silent — best effort
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDelete = useCallback(async (threadTabId: string) => {
    // Optimistic — drop from local state first so the click feels instant.
    setThreads((current) => current.filter((t) => t.tabId !== threadTabId));
    setDeletingId(threadTabId);
    try {
      await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadTabId)}`, {
        method: 'DELETE',
      });
    } catch {
      // Best-effort; on failure we've already dropped from the UI. If the
      // fetch actually failed the next fetchThreads() call will re-populate.
    } finally {
      setDeletingId(null);
    }
  }, []);

  useEffect(() => {
    if (open) void fetchThreads();
  }, [open, fetchThreads]);

  const filteredThreads = useMemo(() => {
    if (!search.trim()) return threads;
    const needle = search.trim().toLowerCase();
    return threads.filter((t) => t.title.toLowerCase().includes(needle));
  }, [threads, search]);

  const grouped = useMemo(() => groupThreads(filteredThreads), [filteredThreads]);

  return (
    <div
      style={{
        width: open ? 260 : 0,
        minWidth: open ? 260 : 0,
        borderRightWidth: open ? 1 : 0,
        borderRightStyle: 'solid',
        borderRightColor: 'var(--t-divider-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 200ms ease, min-width 200ms ease',
        background: 'var(--t-chat-surface-bg, #ffffff)',
        flexShrink: 0,
      }}
    >
      {open ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 12,
              paddingRight: 10,
              paddingBottom: 12,
              paddingLeft: 14,
              borderBottomWidth: 1,
              borderBottomStyle: 'solid',
              borderBottomColor: 'var(--t-divider-subtle)',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--t-text)',
                letterSpacing: '-0.01em',
              }}
            >
              Orchestrator History
            </span>
            <button
              type="button"
              onClick={onClose}
              title="Hide history"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderWidth: 0,
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                cursor: 'pointer',
              }}
            >
              <PanelLeftClose size={13} />
            </button>
          </div>

          <div style={{ paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, flexShrink: 0 }}>
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search conversations..."
              style={{
                width: '100%',
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 6,
                paddingLeft: 10,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-input-border)',
                borderRadius: 8,
                fontSize: 11,
                outline: 'none',
                boxSizing: 'border-box',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                transition: 'border-color 150ms',
              }}
              onFocus={(event) => {
                event.currentTarget.style.borderColor = 'var(--t-accent-border)';
              }}
              onBlur={(event) => {
                event.currentTarget.style.borderColor = 'var(--t-input-border)';
              }}
            />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
            {loading ? (
              <div style={{ textAlign: 'center', paddingTop: 20, color: 'var(--t-text-muted)', fontSize: 11 }}>Loading…</div>
            ) : filteredThreads.length === 0 ? (
              <div style={{ textAlign: 'center', paddingTop: 20, color: 'var(--t-text-muted)', fontSize: 11 }}>
                {search ? 'No matches' : 'No saved conversations'}
              </div>
            ) : (
              grouped.map((group) => (
                <div key={group.label}>
                  <div
                    style={{
                      paddingTop: 10,
                      paddingBottom: 4,
                      paddingLeft: 14,
                      fontSize: 9,
                      fontWeight: 700,
                      color: 'var(--t-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    {group.label}
                  </div>
                  {group.items.map((thread) => {
                    const isCurrent = thread.tabId === currentThreadId;
                    const isDeleting = deletingId === thread.tabId;
                    const runtime = threadRuntime(thread.model);
                    return (
                      <div
                        key={thread.tabId}
                        data-thread-row={thread.tabId}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 2,
                          width: 'calc(100% - 8px)',
                          marginLeft: 4,
                          marginRight: 4,
                          borderRadius: 7,
                          background: isCurrent ? 'var(--t-accent-soft)' : 'transparent',
                          transition: 'background 100ms',
                          opacity: isDeleting ? 0.4 : 1,
                          position: 'relative',
                        }}
                        onMouseEnter={(event) => {
                          if (!isCurrent) {
                            event.currentTarget.style.background = 'var(--t-panel-hover)';
                          }
                          const del = event.currentTarget.querySelector('[data-delete-btn]') as HTMLElement | null;
                          if (del) del.style.opacity = '1';
                        }}
                        onMouseLeave={(event) => {
                          if (!isCurrent) {
                            event.currentTarget.style.background = 'transparent';
                          }
                          const del = event.currentTarget.querySelector('[data-delete-btn]') as HTMLElement | null;
                          if (del) del.style.opacity = '0';
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectThread(thread.tabId)}
                          disabled={isDeleting}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            flex: 1,
                            minWidth: 0,
                            paddingTop: 9,
                            paddingRight: 4,
                            paddingBottom: 9,
                            paddingLeft: 12,
                            borderWidth: 0,
                            background: 'transparent',
                            cursor: isDeleting ? 'default' : 'pointer',
                            textAlign: 'left',
                            fontFamily: '-apple-system, system-ui, sans-serif',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 22,
                              height: 22,
                              borderRadius: 6,
                              flexShrink: 0,
                              background: runtime
                                ? 'transparent'
                                : isCurrent
                                  ? 'var(--t-accent)'
                                  : 'var(--t-bg-card)',
                              color: isCurrent ? '#ffffff' : 'var(--t-text-muted)',
                              transition: 'background 120ms ease, color 120ms ease',
                            }}
                          >
                            {runtime === 'claude-code' ? (
                              <ClaudeIcon size={16} />
                            ) : runtime === 'codex' ? (
                              <CodexIcon size={16} />
                            ) : (
                              <MessageSquare size={12} strokeWidth={2} />
                            )}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 11.5,
                                fontWeight: isCurrent ? 600 : 500,
                                color: 'var(--t-text)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                lineHeight: 1.3,
                                letterSpacing: '-0.005em',
                              }}
                            >
                              {thread.title}
                            </div>
                            {thread.messageCount != null && thread.messageCount > 0 ? (
                              <div
                                style={{
                                  fontSize: 9.5,
                                  color: 'var(--t-text-muted)',
                                  marginTop: 2,
                                  fontWeight: 500,
                                }}
                              >
                                {thread.messageCount} msg{thread.messageCount !== 1 ? 's' : ''}
                              </div>
                            ) : null}
                          </div>
                        </button>
                        <button
                          type="button"
                          data-delete-btn
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDelete(thread.tabId);
                          }}
                          disabled={isDeleting}
                          title="Delete conversation"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 22,
                            height: 22,
                            marginRight: 6,
                            borderWidth: 0,
                            borderRadius: 5,
                            background: 'transparent',
                            color: 'var(--t-text-muted)',
                            cursor: isDeleting ? 'default' : 'pointer',
                            opacity: 0,
                            transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
                            flexShrink: 0,
                          }}
                          onMouseEnter={(event) => {
                            event.currentTarget.style.background = 'rgba(239, 68, 68, 0.12)';
                            event.currentTarget.style.color = '#ef4444';
                          }}
                          onMouseLeave={(event) => {
                            event.currentTarget.style.background = 'transparent';
                            event.currentTarget.style.color = 'var(--t-text-muted)';
                          }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export const OrchestratorHistorySidebar = memo(OrchestratorHistorySidebarBase);
