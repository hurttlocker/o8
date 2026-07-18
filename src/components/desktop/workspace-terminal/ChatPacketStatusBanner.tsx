'use client';

/**
 * ChatPacketStatusBanner — inline decision card at the bottom of a dispatched
 * packet's workspace chat thread. It answers "what's the next step?" right where
 * the transcript ends, so a finished packet never dead-ends on the agent's last
 * message with no call to action (Q ruling 2026-07-11).
 *
 * It self-fetches the packet's review-state (GET /api/orchestrator/review-state)
 * by packetId, which is DETACHMENT-PROOF: a completed packet drops out of the
 * in-memory mission state, but the route synthesizes from the durable lane +
 * approval rows. That's what lets a rejected/parked packet still show its status
 * and actions after the mission that spawned it is gone.
 *
 * States it surfaces: needs-revision (review declined), ready-to-merge
 * (approved), awaiting_review (agent finished), plus merged / failed /
 * recovering. Actions route through the governed control plane:
 *   - Merge          → POST /api/orchestrator/merge      (packetId, governed)
 *   - Approve & merge → submit approving review, then merge (rejection override)
 *   - Request changes → POST /api/orchestrator/rerun-with-feedback
 *   - Discard        → POST /api/orchestrator/discard-packet (archive + cleanup)
 *   - Review diff    → onReview() (opens the wide review surface)
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { LaneMergeMode } from '@/lib/lane/merge-mode';
import type { OrchestratorPacketStatus } from '@/lib/orchestrator/types';
import type { PacketReviewState } from '@/lib/orchestrator/derive-review-state';

interface ChatPacketStatusBannerProps {
  status: OrchestratorPacketStatus | null;
  laneId: string | null;
  packetId: string | null;
  /** Lane sessionKey — the fallback identity when a detached packet has no
   *  client-resolvable packetId. review-state resolves the real packetId from it. */
  sessionKey?: string | null;
  packetTitle: string | null;
  mergeMode?: LaneMergeMode | null;
  mergeModeNote?: string | null;
  /** Open the wide review surface for this packet's diff. */
  onReview?: () => void;
  /** Fired after a successful discard so the host can retire/close the tab. */
  onDiscarded?: () => void;
}

type Presentation = {
  key: 'rejected' | 'ready' | 'awaiting' | 'merged' | 'failed' | 'recovering' | 'no_changes';
  label: string;
  detail: string;
  color: string;
  background: string;
  border: string;
};

const REJECTED: Presentation = {
  key: 'rejected',
  label: 'Review declined',
  detail: 'The review found issues. Send it back with feedback, override and merge anyway, or discard it.',
  color: '#b45309',
  background: 'rgba(232, 145, 43, 0.12)',
  border: 'rgba(232, 145, 43, 0.34)',
};

const READY: Presentation = {
  key: 'ready',
  label: 'Approved',
  detail: 'Review passed and the merge gate is clean. Merge it into main.',
  color: '#15803d',
  background: 'rgba(22, 163, 74, 0.1)',
  border: 'rgba(22, 163, 74, 0.28)',
};

const NO_CHANGES: Presentation = {
  key: 'no_changes',
  label: 'Finished — no changes',
  detail: 'The agent finished without making changes. There is no diff to review or merge.',
  color: '#475569',
  background: 'rgba(100, 116, 139, 0.08)',
  border: 'rgba(100, 116, 139, 0.24)',
};

const PRESENTATION_BY_STATUS: Partial<Record<OrchestratorPacketStatus, Presentation>> = {
  awaiting_review: {
    key: 'awaiting',
    label: 'Ready for review',
    detail: 'Agent finished. Approve to merge into main, or open the diff first.',
    color: '#b45309',
    background: 'rgba(245, 158, 11, 0.1)',
    border: 'rgba(245, 158, 11, 0.28)',
  },
  released: {
    key: 'merged',
    label: 'Merged',
    detail: 'Branch merged into main. The packet is closed.',
    color: '#15803d',
    background: 'rgba(22, 163, 74, 0.1)',
    border: 'rgba(22, 163, 74, 0.28)',
  },
  failed: {
    key: 'failed',
    label: 'Failed',
    detail: 'The agent could not complete this packet. Send it back, or discard it.',
    color: '#b91c1c',
    background: 'rgba(239, 68, 68, 0.1)',
    border: 'rgba(239, 68, 68, 0.28)',
  },
  recovering: {
    key: 'recovering',
    label: 'Recovering',
    detail: 'The session was lost — re-attaching. No action needed yet.',
    color: '#1d4ed8',
    background: 'rgba(37, 99, 235, 0.08)',
    border: 'rgba(37, 99, 235, 0.24)',
  },
};

interface ReviewStateResponse {
  state?: PacketReviewState;
  lane?: string | null;
  packetId?: string | null;
  title?: string | null;
  outcome?: 'no_changes' | null;
  outcomeNote?: string | null;
  orchestratorReview?: { verdict?: string; summary?: string } | null;
}

export function ChatPacketStatusBanner({
  status,
  laneId,
  packetId,
  sessionKey,
  packetTitle,
  mergeMode,
  mergeModeNote,
  onReview,
  onDiscarded,
}: ChatPacketStatusBannerProps) {
  const prOnlyMode = mergeMode === 'pr_only';
  const prOnlyCaption = mergeModeNote ?? 'PR-only mode is active. Create a PR for human merge.';
  const [pending, setPending] = useState<'merge' | 'create_pr' | 'reject' | 'discard' | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [reviewState, setReviewState] = useState<PacketReviewState | null>(null);
  const [resolvedLaneId, setResolvedLaneId] = useState<string | null>(null);
  const [resolvedPacketId, setResolvedPacketId] = useState<string | null>(null);
  const [resolvedTitle, setResolvedTitle] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState<string | null>(null);
  const [resolvedOutcome, setResolvedOutcome] = useState<'no_changes' | null>(null);
  const [resolvedOutcomeNote, setResolvedOutcomeNote] = useState<string | null>(null);
  const [reasonExpanded, setReasonExpanded] = useState(false);

  // Self-fetch the durable review-state so the banner works even when the packet
  // has detached from live mission state (the whole point — see file header).
  // Resolve by packetId when we have it, else by the lane sessionKey — a detached
  // packet has no client packetId, so sessionKey is the only handle, and the
  // route hands back the real packetId for our actions.
  useEffect(() => {
    const query = packetId
      ? `packetId=${encodeURIComponent(packetId)}`
      : sessionKey
        ? `sessionKey=${encodeURIComponent(sessionKey)}`
        : null;
    if (!query) {
      setReviewState(null);
      setResolvedOutcome(null);
      setResolvedOutcomeNote(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/orchestrator/review-state?${query}`);
        if (!res.ok) {
          if (active) {
            setReviewState(null);
            setResolvedOutcome(null);
            setResolvedOutcomeNote(null);
          }
          return;
        }
        const data = await res.json() as ReviewStateResponse;
        if (!active) return;
        setReviewState(data.state ?? null);
        setResolvedLaneId(data.lane ?? null);
        setResolvedPacketId(data.packetId ?? null);
        setResolvedTitle(data.title ?? null);
        setResolvedOutcome(data.outcome ?? null);
        setResolvedOutcomeNote(data.outcomeNote ?? null);
        // The rejection reason lives on the durable review summary — show it so
        // "declined" isn't a dead-end that forces you to open the diff to guess why.
        setReviewReason(data.orchestratorReview?.verdict === 'rejected' ? (data.orchestratorReview?.summary ?? null) : null);
      } catch {
        if (active) {
          setReviewState(null);
          setResolvedOutcome(null);
          setResolvedOutcomeNote(null);
        }
      }
    })();
    return () => { active = false; };
  }, [packetId, sessionKey]);

  const effectiveLaneId = laneId ?? resolvedLaneId;
  // The id our actions (merge / discard / review / rerun) operate on — the
  // prop packetId when present, else the one review-state resolved from sessionKey.
  const actionPacketId = packetId ?? resolvedPacketId;

  // Verdict-based state wins over the raw packet status: needs-revision and
  // ready-to-merge are derived from the actual review + merge gate, so they're
  // more truthful than a status string that lags.
  const presentation: Presentation | undefined =
    resolvedOutcome === 'no_changes' ? NO_CHANGES
    : reviewState === 'needs-revision' ? REJECTED
    : reviewState === 'ready-to-merge' ? READY
    : reviewState === 'merged' ? PRESENTATION_BY_STATUS.released
    : (status ? PRESENTATION_BY_STATUS[status] : undefined);

  const runMerge = useCallback(async (override: boolean) => {
    if (!actionPacketId) return;
    setPending('merge');
    setActionError(null);
    setActionNote(null);
    try {
      // Override path: a declined review blocks merge, so record an approving
      // operator review first, then merge through the governed packet route.
      if (override) {
        const reviewRes = await fetch('/api/orchestrator/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packetId: actionPacketId, approved: true, findings: [] }),
        });
        if (!reviewRes.ok) {
          const rb = await reviewRes.json().catch(() => null) as { error?: { message?: string } } | null;
          throw new Error(rb?.error?.message ?? 'Unable to override the review.');
        }
      }
      const res = await fetch('/api/orchestrator/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId: actionPacketId }),
      });
      const payload = await res.json().catch(() => null) as {
        ok?: boolean;
        result?: { merged?: boolean; status?: string; note?: string } | null;
        error?: { message?: string } | null;
      } | null;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to merge.');
      }
      const result = payload.result ?? null;
      if (result?.status === 'pending_operator_approval') {
        setActionNote('Approval raised — clear it from the inbox to merge.');
      } else if (result?.merged) {
        setActionNote('Merged into main.');
      } else {
        throw new Error(result?.note ?? 'Merge was blocked.');
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Merge failed.');
    } finally {
      setPending(null);
    }
  }, [actionPacketId]);

  const createPr = useCallback(async () => {
    if (!effectiveLaneId) return;
    setPending('create_pr');
    setActionError(null);
    setActionNote(null);
    try {
      const response = await fetch('/api/lanes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verb: 'create_pr', laneId: effectiveLaneId, commitMessage: 'Auto-commit from lane' }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; note?: string } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.note ?? 'Unable to create PR.');
      }
      setActionNote(payload.note ?? 'PR created.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to create PR.');
    } finally {
      setPending(null);
    }
  }, [effectiveLaneId]);

  const discard = useCallback(async () => {
    if (!actionPacketId) return;
    setPending('discard');
    setActionError(null);
    setActionNote(null);
    try {
      const response = await fetch('/api/orchestrator/discard-packet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId: actionPacketId }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        result?: { note?: string } | null;
        error?: { message?: string } | null;
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to discard.');
      }
      setActionNote(payload.result?.note ?? 'Discarded.');
      onDiscarded?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to discard.');
    } finally {
      setPending(null);
    }
  }, [actionPacketId, onDiscarded]);

  // Request changes HANDS THE PACKET TO THE ORCHESTRATOR (Q ruling 2026-07-11) —
  // a declined packet's recovery is a decision (rebase / re-dispatch / fix / drop),
  // so it goes to the brain that owns recovery, not blindly back to a fresh worker.
  // We compose the reason + optional operator note and pre-fill the orchestrator
  // composer (via the dashboard 'o8:orchestrator-inject' listener), focusing that
  // tab so the operator can review and send.
  const submitFeedback = useCallback(() => {
    if (typeof window === 'undefined') return;
    const note = feedback.trim();
    const title = packetTitle ?? resolvedTitle ?? actionPacketId ?? 'the dispatched packet';
    const lines = [
      `The review DECLINED "${title}" and it needs recovery — your call (rebase & re-dispatch, fix it directly, or drop it).`,
    ];
    if (reviewReason) lines.push('', 'Why it was declined:', reviewReason);
    if (note) lines.push('', `My note: ${note}`);
    if (actionPacketId) lines.push('', `Packet: ${actionPacketId}`);
    window.dispatchEvent(new CustomEvent('o8:orchestrator-inject', { detail: { text: lines.join('\n') } }));
    setActionNote('Handed to the orchestrator — review the message in its composer and send.');
    setFeedback('');
    setFeedbackOpen(false);
  }, [feedback, packetTitle, resolvedTitle, actionPacketId, reviewReason]);

  if (!presentation) return null;
  const p = presentation;
  const busy = pending !== null;
  // Which action buttons this presentation offers.
  const canMerge = (p.key === 'ready' || p.key === 'awaiting') && !prOnlyMode;
  const canOverrideMerge = p.key === 'rejected' && !prOnlyMode;
  const canRequestChanges = p.key === 'rejected' || p.key === 'awaiting' || p.key === 'failed';
  const canReview = Boolean(onReview) && (p.key === 'rejected' || p.key === 'ready' || p.key === 'awaiting');
  const canCreatePr = Boolean(effectiveLaneId) && (p.key === 'awaiting' || p.key === 'ready' || prOnlyMode);
  const canDiscard = p.key !== 'merged' && p.key !== 'recovering' && p.key !== 'no_changes';
  const showActions = canMerge || canOverrideMerge || canRequestChanges || canReview || canCreatePr || canDiscard;

  const pill = (
    label: string,
    onClick: () => void,
    variant: 'primary' | 'secondary' | 'ghost' | 'danger',
    isBusy?: boolean,
  ) => {
    const styles: Record<typeof variant, { bg: string; color: string; border: string }> = {
      primary: { bg: p.color, color: '#fff', border: p.color },
      secondary: { bg: 'transparent', color: p.color, border: p.border },
      ghost: { bg: 'transparent', color: 'var(--t-text-muted)', border: 'transparent' },
      danger: { bg: 'transparent', color: 'var(--t-text-muted)', border: 'var(--t-panel-border)' },
    };
    const s = styles[variant];
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        style={{
          paddingTop: 4,
          paddingRight: 10,
          paddingBottom: 4,
          paddingLeft: 10,
          borderRadius: 8,
          borderWidth: variant === 'ghost' ? 0 : 1,
          borderStyle: 'solid',
          borderColor: s.border,
          background: isBusy ? 'var(--t-panel-hover)' : s.bg,
          color: s.color,
          fontSize: 11,
          fontWeight: 400,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy && !isBusy ? 0.6 : 1,
          fontFamily: 'var(--font-sans-system)',
          letterSpacing: '-0.1px',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      style={{
        marginTop: 8,
        marginRight: 14,
        marginLeft: 14,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: p.border,
        background: p.background,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span
          style={{
            paddingTop: 1,
            paddingRight: 7,
            paddingBottom: 1,
            paddingLeft: 7,
            borderRadius: 999,
            background: p.color,
            color: '#fff',
            fontSize: 9,
            fontWeight: 400,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          {p.label}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 400, color: p.color, letterSpacing: '-0.1px' }}>
            {packetTitle ?? resolvedTitle ?? 'Dispatched packet'}
          </div>
          <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
            {p.key === 'awaiting' && prOnlyMode
              ? 'PR-only mode is active. Create a PR so a human can merge.'
              : p.key === 'no_changes' && resolvedOutcomeNote
                ? resolvedOutcomeNote
                : p.detail}
          </div>
          {p.key === 'rejected' && reviewReason ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => setReasonExpanded((v) => !v)}
              title={reasonExpanded ? 'Collapse reason' : 'Expand full reason'}
              style={{
                marginTop: 8,
                paddingTop: 6,
                paddingBottom: 6,
                paddingLeft: 10,
                paddingRight: 10,
                borderTopWidth: 0,
                borderRightWidth: 0,
                borderBottomWidth: 0,
                borderLeftWidth: 2,
                borderStyle: 'solid',
                borderColor: p.color,
                borderTopRightRadius: 6,
                borderBottomRightRadius: 6,
                background: p.background,
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: p.color }}>Why declined</span>
                <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)' }}>{reasonExpanded ? 'less' : 'more'}</span>
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 300,
                  color: 'var(--t-text-secondary)',
                  lineHeight: 1.5,
                  marginTop: 3,
                  ...(reasonExpanded
                    ? {}
                    : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
                } as CSSProperties}
              >
                {reviewReason}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {feedbackOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Add a note for the orchestrator (optional) — the decline reason is already included."
            style={{
              width: '100%',
              minHeight: 64,
              maxHeight: 160,
              resize: 'vertical',
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-panel-border)',
              background: 'var(--t-input-bg, var(--t-panel))',
              color: 'var(--t-text)',
              paddingTop: 6,
              paddingRight: 8,
              paddingBottom: 6,
              paddingLeft: 8,
              fontSize: 11,
              fontFamily: 'var(--font-sans-system)',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            {pill('Send to orchestrator', () => { submitFeedback(); }, 'secondary')}
            {pill('Cancel', () => { setFeedbackOpen(false); setFeedback(''); }, 'danger')}
          </div>
        </div>
      ) : showActions ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {canReview && onReview ? pill('Review diff', onReview, 'secondary') : null}
          {canMerge ? pill(pending === 'merge' ? 'Merging…' : 'Approve & merge', () => { void runMerge(false); }, 'primary', pending === 'merge') : null}
          {/* On a DECLINED packet, merging silently overrides the rejection — label it so. */}
          {canOverrideMerge ? pill(pending === 'merge' ? 'Merging…' : 'Override & merge', () => { void runMerge(true); }, 'primary', pending === 'merge') : null}
          {canCreatePr ? pill(pending === 'create_pr' ? 'Creating PR…' : 'Create PR', () => { void createPr(); }, prOnlyMode ? 'primary' : 'secondary', pending === 'create_pr') : null}
          {canRequestChanges ? pill('Request changes', () => setFeedbackOpen(true), 'secondary') : null}
          {canDiscard ? pill(pending === 'discard' ? 'Discarding…' : 'Discard', () => { void discard(); }, 'danger', pending === 'discard') : null}
        </div>
      ) : null}

      {prOnlyMode && p.key === 'awaiting' ? (
        <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.4 }}>
          {prOnlyCaption}
        </div>
      ) : null}

      {actionNote ? (
        <div style={{ fontSize: 11, color: p.color, lineHeight: 1.4 }}>
          {actionNote}
        </div>
      ) : null}
      {actionError ? (
        <div style={{ fontSize: 11, color: '#b91c1c', lineHeight: 1.4 }}>
          {actionError}
        </div>
      ) : null}
    </div>
  );
}
