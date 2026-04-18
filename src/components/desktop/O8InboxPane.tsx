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
};

const STATUS_LABELS: Record<SupervisorInboxItem['status'], string> = {
  pending: 'Pending',
  self_healed: 'Self healed',
  human_required: 'Human required',
  dismissed: 'Dismissed',
};

const REFRESH_EVENT = 'o8:inbox-refresh';

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

export function O8InboxPane() {
  const [items, setItems] = useState<SupervisorInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'active' | 'self_healed' | 'all'>('active');

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/supervisor-inbox?includeDismissed=1', { cache: 'no-store' });
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
    const interval = window.setInterval(refresh, 8000);
    return () => {
      window.removeEventListener(REFRESH_EVENT, handleEvent);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const dismiss = useCallback(async (id: string) => {
    await fetch('/api/panel/supervisor-inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', id }),
    });
    refresh();
  }, [refresh]);

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
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
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
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--t-text-faint)',
            marginBottom: 2,
          }}
        >
          Governance
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', marginBottom: 2 }}>
          Supervisor Inbox
        </div>
        <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', marginBottom: 10 }}>
          Persistent escalation ledger. No transcript bleed.
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
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

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 8, paddingBottom: 12, paddingLeft: 12, paddingRight: 12 }}>
        {loading && items.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--t-text-secondary)', fontSize: 12 }}>Loading…</div>
        ) : visibleItems.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--t-text-secondary)', fontSize: 12 }}>
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
                      fontWeight: 700,
                    }}
                  >
                    {KIND_LABELS[item.kind]}
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--t-text-secondary)' }}>
                    {STATUS_LABELS[item.status]}
                  </span>
                  {verificationKind ? (
                    <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--t-text-faint)' }}>
                      {verificationKind}
                    </span>
                  ) : null}
                  <span style={{ fontSize: 9, color: 'var(--t-text-faint)', marginLeft: 'auto' }}>
                    {formatTimestamp(item.createdAt)}
                  </span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)', marginBottom: 3 }}>
                  {packetLabel(item)}
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-secondary)', marginBottom: 6 }}>
                  {item.errorExcerpt}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10, color: 'var(--t-text-faint)' }}>
                  <span>{repoLabel(item.repoPath)}</span>
                  <span>{shortPath(item.worktreePath ?? item.repoPath)}</span>
                  {lastCommit?.subject ? <span>{lastCommit.subject}</span> : null}
                  {diffStat ? <span>{diffStat}</span> : null}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8, fontSize: 10, fontWeight: 700 }}>
                  {item.transcriptLink ? (
                    <a href={item.transcriptLink} target="_blank" rel="noreferrer" style={{ color: 'var(--t-accent)', textDecoration: 'none' }}>
                      Transcript
                    </a>
                  ) : null}
                  {item.worktreeLink ? (
                    <a href={item.worktreeLink} style={{ color: 'var(--t-accent)', textDecoration: 'none' }}>
                      Worktree
                    </a>
                  ) : null}
                  {!isSelfHealed ? (
                    <button
                      type="button"
                      onClick={() => dismiss(item.id)}
                      style={{
                        marginLeft: 'auto',
                        height: 20,
                        paddingLeft: 8,
                        paddingRight: 8,
                        borderRadius: 5,
                        border: '1px solid var(--t-border)',
                        background: 'var(--t-panel)',
                        color: 'var(--t-text-secondary)',
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Dismiss
                    </button>
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
  const background = active
    ? tone === 'warning'
      ? 'var(--t-warning-soft, rgba(249, 115, 22, 0.12))'
      : tone === 'accent'
        ? 'var(--t-accent-soft)'
        : 'var(--t-bg-card)'
    : 'transparent';
  const color = active
    ? tone === 'warning'
      ? 'var(--t-warning, #c2410c)'
      : tone === 'accent'
        ? 'var(--t-accent)'
        : 'var(--t-text)'
    : 'var(--t-text-secondary)';
  const borderColor = active ? 'var(--t-border)' : 'transparent';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 22,
        paddingLeft: 9,
        paddingRight: 9,
        borderRadius: 6,
        border: `1px solid ${borderColor}`,
        background,
        color,
        fontSize: 10,
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}
