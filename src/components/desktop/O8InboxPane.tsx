'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';

const KIND_LABELS: Record<SupervisorInboxItem['kind'], string> = {
  verification_failed: 'Verification Failed',
  session_lost: 'Session Lost',
  packet_missing: 'Packet Missing',
  bounded_retry_exhausted: 'Retry Exhausted',
  merge_blocked: 'Merge Blocked',
  fetch_unreachable: 'Fetch Unreachable',
  repo_misconfigured: 'Repo Misconfigured',
  silent_exit_verification_failed: 'Silent Exit · Verification Failed',
  silent_exit_no_work: 'Silent Exit · No Work',
  silent_exit_but_work_present: 'Silent Exit · Work Salvaged',
};

const STATUS_LABELS: Record<SupervisorInboxItem['status'], string> = {
  pending: 'Pending',
  healing: 'Healing',
  self_healed: 'Self healed',
  human_required: 'Human required',
  dismissed: 'Dismissed',
};

const REFRESH_EVENT = 'o8:inbox-refresh';

interface RuntimeTranscriptEntry {
  id: string;
  role: string;
  text?: string;
  type?: string;
  timestampLabel?: string;
  toolName?: string;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function packetLabel(item: SupervisorInboxItem) {
  if (item.packetReferenceLabel && item.packetTitle) {
    return `${item.packetReferenceLabel} · ${item.packetTitle}`;
  }
  return item.packetTitle ?? item.packetReferenceLabel ?? 'Unbound lane';
}

function repoLabel(repoPath: string) {
  const parts = repoPath.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : repoPath;
}

function shortPath(pathValue: string | null) {
  if (!pathValue) return 'Unavailable';
  const parts = pathValue.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : pathValue;
}

function FileTextGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--o8-inbox-action-icon, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7" />
      <path d="M8.5 16h5" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--o8-inbox-action-icon, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.2l2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z" />
      <path d="M4 10h16" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--o8-inbox-action-icon, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M5 5.5h14a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H11l-4.4 3v-3H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z" />
      <path d="M8 10h8" />
      <path d="M8 13.5h5.5" />
    </svg>
  );
}

function ArchiveGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--o8-inbox-action-icon, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 5.5h16v4H4z" />
      <path d="M6 9.5V19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9.5" />
      <path d="M9.5 14h5" />
    </svg>
  );
}

export function O8InboxPane() {
  const [items, setItems] = useState<SupervisorInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'active' | 'self_healed' | 'all'>('active');
  const [expandedTranscriptById, setExpandedTranscriptById] = useState<Record<string, RuntimeTranscriptEntry[]>>({});
  const [actionNoteById, setActionNoteById] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/supervisor-inbox?includeDismissed=1&scope=all', { cache: 'no-store' });
      if (!response.ok) return;
      const body = await response.json();
      if (Array.isArray(body?.items)) setItems(body.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const handleEvent = () => refresh();
    window.addEventListener(REFRESH_EVENT, handleEvent);
    window.addEventListener('o8:supervisor-inbox', handleEvent);
    const interval = window.setInterval(refresh, 15000);
    return () => {
      window.removeEventListener(REFRESH_EVENT, handleEvent);
      window.removeEventListener('o8:supervisor-inbox', handleEvent);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const setActionNote = useCallback((id: string, note: string) => {
    setActionNoteById((current) => ({ ...current, [id]: note }));
    window.setTimeout(() => {
      setActionNoteById((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, 2500);
  }, []);

  const dismiss = useCallback(async (id: string) => {
    await fetch('/api/panel/supervisor-inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', id }),
    });
    window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
    refresh();
  }, [refresh]);

  const openTranscript = useCallback(async (item: SupervisorInboxItem) => {
    if (!item.transcriptLink) {
      setActionNote(item.id, 'No transcript for this incident.');
      return;
    }
    if (expandedTranscriptById[item.id]) {
      setExpandedTranscriptById((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      return;
    }
    try {
      const response = await fetch(item.transcriptLink, { cache: 'no-store' });
      if (!response.ok) throw new Error('Transcript unavailable.');
      const body = await response.json() as { transcript?: RuntimeTranscriptEntry[] };
      setExpandedTranscriptById((current) => ({
        ...current,
        [item.id]: Array.isArray(body.transcript) ? body.transcript.slice(-8) : [],
      }));
    } catch {
      setActionNote(item.id, 'Transcript could not be loaded.');
    }
  }, [expandedTranscriptById, setActionNote]);

  const openWorktree = useCallback(async (item: SupervisorInboxItem) => {
    const path = item.worktreePath ?? item.repoPath;
    if (!path) {
      setActionNote(item.id, 'No worktree path for this incident.');
      return;
    }
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(path);
        setActionNote(item.id, 'Opened worktree.');
        return;
      }
      await navigator.clipboard?.writeText(path);
      setActionNote(item.id, 'Copied worktree path.');
    } catch {
      setActionNote(item.id, path);
    }
  }, [setActionNote]);

  const addToChat = useCallback((item: SupervisorInboxItem) => {
    const repoName = repoLabel(item.repoPath);
    const details = [
      `${KIND_LABELS[item.kind]} (${STATUS_LABELS[item.status]})`,
      item.packetTitle ? `Task: ${item.packetTitle}` : null,
      item.packetReferenceLabel ? `Packet: ${item.packetReferenceLabel}` : null,
      item.repeatCount > 1 ? `Repeated: ${item.repeatCount} times` : null,
      `Last seen: ${formatTimestamp(item.lastSeenAt)}`,
      `Problem: ${item.errorExcerpt}`,
      item.worktreePath ? `Worktree: ${item.worktreePath}` : null,
    ].filter(Boolean).join('\n');
    window.dispatchEvent(new CustomEvent('o8:resolve-blocker', {
      detail: {
        repoPath: item.repoPath,
        repoName,
        explanation: details,
        statusLabel: KIND_LABELS[item.kind],
      },
    }));
    setActionNote(item.id, 'Added to orchestrator draft.');
  }, [setActionNote]);

  const humanRequired = items.filter((item) => item.status === 'human_required');
  const selfHealed = items.filter((item) => item.status === 'self_healed');
  const pending = items.filter((item) => item.status === 'pending');

  const visibleItems = filter === 'active'
    ? [...humanRequired, ...pending]
    : filter === 'self_healed'
      ? selfHealed
      : items;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div
        style={{
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 16,
          paddingRight: 16,
          borderBottom: '1px solid var(--t-border)',
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontWeight: 300,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--t-text-faint)',
            marginBottom: 4,
          }}
        >
          Governance
        </div>
        <div style={{ fontSize: 15, fontWeight: 350, letterSpacing: '-0.1px', color: 'var(--t-text)', marginBottom: 3 }}>
          Incident Queue
        </div>
        <div style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.45, color: 'var(--t-text-faint)', marginBottom: 10 }}>
          Deduped agent failures that still need operator attention.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <FilterChip
            label={`Active · ${humanRequired.length + pending.length}`}
            active={filter === 'active'}
            onClick={() => setFilter('active')}
            tone="warning"
          />
          <FilterChip
            label={`Self-healed · ${selfHealed.length}`}
            active={filter === 'self_healed'}
            onClick={() => setFilter('self_healed')}
            tone="accent"
          />
          <FilterChip
            label="All"
            active={filter === 'all'}
            onClick={() => setFilter('all')}
            tone="neutral"
          />
        </div>
      </div>

      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingTop: 8, paddingBottom: 12, paddingLeft: 12, paddingRight: 12 }}>
        {loading && items.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--t-text-secondary)', fontSize: 12 }}>Loading…</div>
        ) : visibleItems.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'break-word' }}>
            {filter === 'active'
              ? 'No active supervisor inbox items. Heal-bot caught everything else.'
              : filter === 'self_healed'
                ? 'No self-healed items yet. Heal-bot will log fixes here.'
                : 'Supervisor inbox is empty.'}
          </div>
        ) : (
          visibleItems.map((item) => {
            const verificationKind = typeof item.payload.verificationKind === 'string'
              ? item.payload.verificationKind
              : null;
            const diffStat = typeof item.payload.diffStat === 'string' ? item.payload.diffStat : null;
            const lastCommit = item.payload.lastCommit && typeof item.payload.lastCommit === 'object'
              ? item.payload.lastCommit as { subject?: string }
              : null;
            const isHumanRequired = item.status === 'human_required';
            const isSelfHealed = item.status === 'self_healed';
            const transcriptPreview = expandedTranscriptById[item.id] ?? null;
            const actionNote = actionNoteById[item.id] ?? null;

            return (
              <article
                key={item.id}
                style={{
                  padding: '10px 12px',
                  marginBottom: 6,
                  borderRadius: 8,
                  border: '1px solid var(--t-border)',
                  background: 'var(--t-bg-card)',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 16,
                      paddingLeft: 6,
                      paddingRight: 6,
                      borderRadius: 6,
                      background: isHumanRequired
                        ? 'var(--t-warning-soft, rgba(249, 115, 22, 0.12))'
                        : isSelfHealed
                          ? 'var(--t-accent-soft)'
                          : 'var(--t-border)',
                      color: isHumanRequired
                        ? 'var(--t-warning, #c2410c)'
                        : isSelfHealed
                          ? 'var(--t-accent)'
                          : 'var(--t-text-secondary)',
                      fontSize: 9,
                      fontWeight: 300,
                      letterSpacing: '0.04em',
                    }}
                  >
                    {KIND_LABELS[item.kind]}
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', color: 'var(--t-text-faint)' }}>
                    {STATUS_LABELS[item.status]}
                  </span>
                  {verificationKind ? (
                    <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', color: 'var(--t-text-faint)' }}>
                      {verificationKind}
                    </span>
                  ) : null}
                  {item.repeatCount > 1 ? (
                    <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', color: 'var(--t-text-faint)' }}>
                      x{item.repeatCount}
                    </span>
                  ) : null}
                  <span style={{ fontSize: 9, fontWeight: 260, letterSpacing: '-0.2px', color: 'var(--t-text-faint)', marginLeft: 'auto' }}>
                    {formatTimestamp(item.lastSeenAt)}
                  </span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)', marginBottom: 4, lineHeight: 1.25 }}>
                  {packetLabel(item)}
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.45, color: 'var(--t-text-faint)', marginBottom: 6 }}>
                  {item.errorExcerpt}
                </div>
                {transcriptPreview ? (
                  <div
                    style={{
                      marginBottom: 8,
                      borderRadius: 7,
                      border: '1px solid var(--t-divider-subtle)',
                      background: 'var(--t-bg-subtle)',
                      maxHeight: 170,
                      overflowY: 'auto',
                      padding: '7px 8px',
                    }}
                  >
                    {transcriptPreview.length === 0 ? (
                      <div style={{ fontSize: 10, color: 'var(--t-text-secondary)' }}>No transcript rows found.</div>
                    ) : transcriptPreview.map((entry) => (
                      <div key={entry.id} style={{ marginBottom: 7 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>{entry.timestampLabel ?? entry.type ?? 'entry'}</span>
                          <span style={{ fontSize: 9, color: 'var(--t-text-secondary)' }}>{entry.toolName ?? entry.role}</span>
                        </div>
                        <div style={{ fontSize: 10, lineHeight: 1.35, color: 'var(--t-text)', whiteSpace: 'pre-wrap' }}>
                          {(entry.text ?? '').trim() || '(empty)'}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10, color: 'var(--t-text-faint)' }}>
                  <span>{repoLabel(item.repoPath)}</span>
                  <span>{shortPath(item.worktreePath ?? item.repoPath)}</span>
                  {lastCommit?.subject ? <span>{lastCommit.subject}</span> : null}
                  {diffStat ? <span>{diffStat}</span> : null}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                  <div style={{ minWidth: 0, flex: 1, fontSize: 10, color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {actionNote}
                  </div>
                  <InboxActionButton
                    title={transcriptPreview ? 'Hide transcript' : 'Preview transcript'}
                    onClick={() => { void openTranscript(item); }}
                    disabled={!item.transcriptLink}
                  >
                    <FileTextGlyph />
                  </InboxActionButton>
                  <InboxActionButton
                    title="Open worktree"
                    onClick={() => { void openWorktree(item); }}
                  >
                    <FolderGlyph />
                  </InboxActionButton>
                  <InboxActionButton
                    title="Add to orchestrator chat"
                    onClick={() => addToChat(item)}
                  >
                    <ChatGlyph />
                  </InboxActionButton>
                  {!isSelfHealed ? (
                    <InboxActionButton
                      title="Dismiss incident"
                      onClick={() => dismiss(item.id)}
                    >
                      <ArchiveGlyph />
                    </InboxActionButton>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

function InboxActionButton({
  title,
  onClick,
  disabled = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        // Flat per DESIGN.md §06.7 — transparent at rest, var(--t-hover) on
        // hover, no border, no bg-card chunk.
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 7,
        border: 'none',
        background: 'transparent',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: 1,
        flexShrink: 0,
        ['--o8-inbox-action-icon' as string]: disabled ? 'var(--t-text-faint, #94a3b8)' : 'var(--t-text-secondary, #64748b)',
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (!disabled) {
          event.currentTarget.style.background = 'var(--t-hover)';
          event.currentTarget.style.color = 'var(--t-text)';
          event.currentTarget.style.setProperty('--o8-inbox-action-icon', 'var(--t-text, #0f172a)');
        }
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)';
        event.currentTarget.style.setProperty('--o8-inbox-action-icon', disabled ? 'var(--t-text-faint, #94a3b8)' : 'var(--t-text-secondary, #64748b)');
      }}
    >
      {children}
    </button>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  tone,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tone: 'warning' | 'accent' | 'neutral';
}) {
  const activeBackground = active
    ? tone === 'warning'
      ? 'rgba(249, 115, 22, 0.08)'
      : tone === 'accent'
        ? 'var(--t-accent-soft, rgba(96, 165, 250, 0.1))'
        : 'var(--t-panel-active, var(--t-input-bg))'
    : 'var(--t-bg-card)';
  const color = active
    ? tone === 'warning'
      ? '#f29b62'
      : tone === 'accent'
        ? 'var(--t-accent)'
        : 'var(--t-text)'
    : 'var(--t-text-secondary)';
  const borderColor = active
    ? tone === 'warning'
      ? 'rgba(249, 115, 22, 0.2)'
      : tone === 'accent'
        ? 'var(--t-accent-border, rgba(96, 165, 250, 0.22))'
        : 'var(--t-divider-subtle)'
    : 'var(--t-divider-subtle)';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        // Flat filter chip — drops always-on border for clean transparent
        // rest. Active state uses tone-tinted soft fill; inactive is fully
        // transparent and crossfades to var(--t-hover) on hover.
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        paddingLeft: 11,
        paddingRight: 11,
        borderRadius: 7,
        border: 'none',
        background: active ? activeBackground : 'transparent',
        color,
        fontSize: 11,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        cursor: 'pointer',
        lineHeight: 1.25,
        whiteSpace: 'nowrap',
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (!active) {
          event.currentTarget.style.background = 'var(--t-hover)';
          event.currentTarget.style.color = 'var(--t-text)';
        }
      }}
      onMouseLeave={(event) => {
        if (!active) {
          event.currentTarget.style.background = 'transparent';
          event.currentTarget.style.color = 'var(--t-text-secondary)';
        }
      }}
    >
      {label}
    </button>
  );
}
