'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import { composeSupervisorInboxCardCopy } from '@/lib/inbox/card-copy';
import { fireInvalidation } from '@/lib/query/use-reactive-query';
import { O8ApprovalCards } from './o8-panel/O8ApprovalCards';

const KIND_LABELS: Record<SupervisorInboxItem['kind'], string> = {
  verification_failed: 'Verification Failed',
  session_lost: 'Session Lost',
  packet_missing: 'Packet Missing',
  bounded_retry_exhausted: 'Retry Exhausted',
  merge_blocked: 'Merge Blocked',
  fetch_unreachable: 'Fetch Unreachable',
  repo_misconfigured: 'Repo Misconfigured',
  packet_no_changes: 'Finished · No Changes',
  silent_exit_verification_failed: 'Silent Exit · Verification Failed',
  silent_exit_no_work: 'Silent Exit · No Work',
  silent_exit_but_work_present: 'Silent Exit · Work Salvaged',
  no_session_binding: 'No Session Binding',
};

const STATUS_LABELS: Record<SupervisorInboxItem['status'], string> = {
  pending: 'Pending',
  healing: 'Healing',
  self_healed: 'Self healed',
  escalated: 'Escalated',
  resolved: 'Resolved',
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

function RetryGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--o8-inbox-action-icon, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--o8-inbox-action-icon, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
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

export function O8InboxPane({ active = true }: { active?: boolean }) {
  const [items, setItems] = useState<SupervisorInboxItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvalLoading, setApprovalLoading] = useState(true);
  const [filter, setFilter] = useState<'active' | 'self_healed' | 'all'>('active');
  const [expandedTranscriptById, setExpandedTranscriptById] = useState<Record<string, RuntimeTranscriptEntry[]>>({});
  const [actionNoteById, setActionNoteById] = useState<Record<string, string>>({});
  const [approvalNoteById, setApprovalNoteById] = useState<Record<string, string>>({});
  const [busyApproval, setBusyApproval] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  // #1569: latch while a retry/stop verb runs — a double-click on Retry would
  // otherwise relaunch two fresh workers.
  const [busyIncidentId, setBusyIncidentId] = useState<string | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshTrailingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshTrailingRef.current = true;
      return refreshInFlightRef.current;
    }
    const request = (async () => {
      do {
        refreshTrailingRef.current = false;
        const [inboxResult, approvalsResult] = await Promise.allSettled([
          fetch('/api/panel/supervisor-inbox?includeDismissed=1&scope=all', { cache: 'no-store' })
            .then(async (response) => {
              if (!response.ok) return null;
              const body = await response.json();
              return Array.isArray(body?.items) ? body.items as SupervisorInboxItem[] : null;
            }),
          fetch('/api/panel/approvals?status=pending', { cache: 'no-store' })
            .then(async (response) => {
              if (!response.ok) return null;
              const body = await response.json();
              return Array.isArray(body?.approvals) ? body.approvals as ApprovalRecord[] : null;
            }),
        ]);

        if (inboxResult.status === 'fulfilled' && inboxResult.value) setItems(inboxResult.value);
        if (approvalsResult.status === 'fulfilled' && approvalsResult.value) setApprovals(approvalsResult.value);
        setLoading(false);
        setApprovalLoading(false);
      } while (refreshTrailingRef.current);
    })();
    refreshInFlightRef.current = request;
    try {
      await request;
    } finally {
      if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const handleEvent = (event: Event) => {
      const queryKey = (event as CustomEvent<{ queryKey?: string[] }>).detail?.queryKey;
      if (queryKey && queryKey[0] !== 'approvals') return;
      void refresh();
    };
    window.addEventListener(REFRESH_EVENT, handleEvent);
    window.addEventListener('o8:supervisor-inbox', handleEvent);
    window.addEventListener('o8:inbox', handleEvent);
    window.addEventListener('o8:realtime', handleEvent);
    window.addEventListener('o8:lifecycle-reconcile', handleEvent);
    window.addEventListener('o8:invalidate', handleEvent);
    // Push-not-poll: supervisor + approval WS events (and REFRESH_EVENT) drive
    // live updates, so this timer is only a safety net for a dropped event.
    const interval = window.setInterval(() => { void refresh(); }, 300000);
    return () => {
      window.removeEventListener(REFRESH_EVENT, handleEvent);
      window.removeEventListener('o8:supervisor-inbox', handleEvent);
      window.removeEventListener('o8:inbox', handleEvent);
      window.removeEventListener('o8:realtime', handleEvent);
      window.removeEventListener('o8:lifecycle-reconcile', handleEvent);
      window.removeEventListener('o8:invalidate', handleEvent);
      window.clearInterval(interval);
    };
  }, [active, refresh]);

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

  const setApprovalNote = useCallback((id: string, note: string) => {
    setApprovalNoteById((current) => ({ ...current, [id]: note }));
    window.setTimeout(() => {
      setApprovalNoteById((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }, 3000);
  }, []);

  const resolveApproval = useCallback(async (approval: ApprovalRecord, action: 'approve' | 'reject') => {
    setBusyApproval({ id: approval.id, action });
    setApprovalNote(approval.id, action === 'approve' ? 'Approving...' : 'Rejecting...');
    try {
      const response = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: approval.id }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string; note?: string } | null;
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `Unable to ${action} approval.`);
      }
      setApprovalNote(approval.id, payload?.note ?? (action === 'approve' ? 'Approved.' : 'Rejected.'));
      fireInvalidation('invalidate', ['approvals', 'all']);
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
      await refresh();
    } catch (error) {
      setApprovalNote(approval.id, error instanceof Error ? error.message : `Unable to ${action} approval.`);
    } finally {
      setBusyApproval(null);
    }
  }, [refresh, setApprovalNote]);

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
    // Mark escalated — heal-bot auto-resolves once the faulting packet's lane
    // merges. Flips the card out of the "awaiting you" rot into "in flight".
    void fetch('/api/panel/supervisor-inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'escalate', id: item.id }),
    }).then(() => {
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
      refresh();
    }).catch(() => {});
    setActionNote(item.id, 'Escalated to orchestrator.');
  }, [setActionNote, refresh]);

  // #1569: the retry-exhausted copy tells the operator to "retry manually or
  // stop the packet" — these are those verbs. Retry = layer-4 fresh redispatch
  // carrying the incident's error as feedback (the warm session is dead by the
  // time bounded retries exhaust, so steer isn't an option); the incident flips
  // to escalated so it reads "in flight" and heal-bot auto-resolves it on merge.
  // Stop = interrupt + hold, then the incident is dismissed as operator-decided.
  const retryPacket = useCallback(async (item: SupervisorInboxItem) => {
    if (!item.packetId || busyIncidentId) return;
    setBusyIncidentId(item.id);
    setActionNote(item.id, 'Relaunching a fresh worker...');
    try {
      const response = await fetch('/api/orchestrator/rerun-with-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packetId: item.packetId,
          feedback: `Operator retried manually from the Incident Queue after bounded retries were exhausted. Original failure: ${item.errorExcerpt || 'see lane events.'}`,
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? 'Retry was rejected.');
      await fetch('/api/panel/supervisor-inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'escalate', id: item.id }),
      }).catch(() => {});
      setActionNote(item.id, 'Fresh worker relaunched.');
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
      await refresh();
    } catch (error) {
      setActionNote(item.id, error instanceof Error ? error.message : 'Retry failed.');
    } finally {
      setBusyIncidentId(null);
    }
  }, [busyIncidentId, refresh, setActionNote]);

  const stopPacket = useCallback(async (item: SupervisorInboxItem) => {
    if (!item.packetId || busyIncidentId) return;
    setBusyIncidentId(item.id);
    setActionNote(item.id, 'Stopping the packet...');
    try {
      const response = await fetch('/api/orchestrator/stop-packet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId: item.packetId }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? 'Stop was rejected.');
      await fetch('/api/panel/supervisor-inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss', id: item.id }),
      }).catch(() => {});
      setActionNote(item.id, 'Packet stopped and held.');
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
      await refresh();
    } catch (error) {
      setActionNote(item.id, error instanceof Error ? error.message : 'Stop failed.');
    } finally {
      setBusyIncidentId(null);
    }
  }, [busyIncidentId, refresh, setActionNote]);

  const humanRequired = items.filter((item) => item.status === 'human_required');
  const escalated = items.filter((item) => item.status === 'escalated');
  const selfHealed = items.filter((item) => item.status === 'self_healed');
  const pending = items.filter((item) => item.status === 'pending');
  const healing = items.filter((item) => item.status === 'healing');

  const visibleItems = filter === 'active'
    ? [...humanRequired, ...escalated, ...pending]
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
        <div style={{ fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.45, color: 'var(--t-text-faint)', marginBottom: 6 }}>
          Approval requests and deduped agent failures that still need operator attention.
        </div>
        {(approvals.length + humanRequired.length + escalated.length + pending.length + healing.length) > 0 ? (
          <div style={{ fontSize: 10, fontWeight: 300, letterSpacing: '0.02em', color: 'var(--t-text-faint)', marginBottom: 10 }}>
            {approvals.length} approval{approvals.length === 1 ? '' : 's'} · {escalated.length} escalated · {humanRequired.length} awaiting you · {pending.length + healing.length} open
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <FilterChip
            label={`Active · ${humanRequired.length + escalated.length + pending.length}`}
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
        {approvalLoading && approvals.length === 0 ? (
          <div style={{ paddingTop: 8, paddingRight: 4, paddingBottom: 8, paddingLeft: 4, color: 'var(--t-text-secondary)', fontSize: 12 }}>Loading approvals...</div>
        ) : null}
        <O8ApprovalCards
          approvals={approvals}
          busyApproval={busyApproval}
          noteById={approvalNoteById}
          onResolve={resolveApproval}
        />
        {loading && items.length === 0 && approvals.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--t-text-secondary)', fontSize: 12 }}>Loading…</div>
        ) : visibleItems.length === 0 && approvals.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'break-word' }}>
            {filter === 'active'
              ? 'No active approvals or supervisor inbox items. Heal-bot caught everything else.'
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
            const isEscalated = item.status === 'escalated';
            const isSelfHealed = item.status === 'self_healed';
            const isResolved = item.status === 'resolved';
            const transcriptPreview = expandedTranscriptById[item.id] ?? null;
            const actionNote = actionNoteById[item.id] ?? null;
            const copy = composeSupervisorInboxCardCopy(item);

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
                        ? 'var(--t-warning-soft)'
                        : isEscalated
                          ? 'var(--t-accent-soft)'
                          : (isSelfHealed || isResolved)
                            ? 'var(--t-accent-soft)'
                            : 'var(--t-border)',
                      color: isHumanRequired
                        ? 'var(--t-warning)'
                        : isEscalated
                          ? 'var(--t-accent)'
                          : (isSelfHealed || isResolved)
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
                  {copy.headline}
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.45, color: 'var(--t-text-faint)', marginBottom: 6 }}>
                  {copy.subline}
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
                      <div style={{ fontSize: 10, color: 'var(--t-text-secondary)' }}>No transcript yet.</div>
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
                  {isHumanRequired && item.packetId ? (
                    <>
                      <InboxActionButton
                        title="Retry packet (fresh worker)"
                        onClick={() => { void retryPacket(item); }}
                        disabled={busyIncidentId !== null}
                      >
                        <RetryGlyph />
                      </InboxActionButton>
                      <InboxActionButton
                        title="Stop packet"
                        onClick={() => { void stopPacket(item); }}
                        disabled={busyIncidentId !== null}
                      >
                        <StopGlyph />
                      </InboxActionButton>
                    </>
                  ) : null}
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
                  {!isSelfHealed && !isResolved ? (
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
      ? 'var(--t-warning-soft)'
      : tone === 'accent'
        ? 'var(--t-accent-soft)'
        : 'var(--t-panel-active, var(--t-input-bg))'
    : 'var(--t-bg-card)';
  const color = active
    ? tone === 'warning'
      ? '#f29b62'
      : tone === 'accent'
        ? 'var(--t-accent)'
        : 'var(--t-text)'
    : 'var(--t-text-secondary)';

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
