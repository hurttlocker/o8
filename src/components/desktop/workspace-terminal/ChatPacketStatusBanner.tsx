'use client';

/**
 * ChatPacketStatusBanner — inline status card for the bottom of a
 * dispatched packet's workspace chat thread.
 *
 * Renders when the live packet status moves out of the in-flight zone
 * (awaiting_review / released / failed / recovering) so the operator
 * always sees the next step inline with the transcript, not just in
 * the tab header pill or the O8 Activity tab.
 *
 * Action buttons (Approve & Merge / Create PR) wire directly to
 * /api/lanes — same verbs the Activity tab's full PacketReviewCard
 * uses. The banner is intentionally narrower than that card; for a
 * full review surface (review snapshot, file list, conflict log) the
 * "Open in Activity" link bounces the operator to the wide panel.
 */

import { useCallback, useState } from 'react';
import type { LaneMergeMode } from '@/lib/lane/merge-mode';
import type { OrchestratorPacketStatus } from '@/lib/orchestrator/types';

interface ChatPacketStatusBannerProps {
  status: OrchestratorPacketStatus | null;
  laneId: string | null;
  packetId: string | null;
  packetTitle: string | null;
  mergeMode?: LaneMergeMode | null;
  mergeModeNote?: string | null;
  onOpenInActivity?: () => void;
}

type Tone = {
  label: string;
  detail: string;
  color: string;
  background: string;
  border: string;
};

const TONE_BY_STATUS: Partial<Record<OrchestratorPacketStatus, Tone>> = {
  awaiting_review: {
    label: 'Ready for review',
    detail: 'Agent finished. Approve to merge into main, or open the diff first.',
    color: '#b45309',
    background: 'rgba(245, 158, 11, 0.1)',
    border: 'rgba(245, 158, 11, 0.28)',
  },
  released: {
    label: 'Merged',
    detail: 'Branch merged into main. The packet is closed.',
    color: '#15803d',
    background: 'rgba(22, 163, 74, 0.1)',
    border: 'rgba(22, 163, 74, 0.28)',
  },
  failed: {
    label: 'Failed',
    detail: 'The agent could not complete this packet. Open the Activity tab to retry or reset.',
    color: '#b91c1c',
    background: 'rgba(239, 68, 68, 0.1)',
    border: 'rgba(239, 68, 68, 0.28)',
  },
  recovering: {
    label: 'Recovering',
    detail: 'The session was lost — re-attaching. No action needed yet.',
    color: '#1d4ed8',
    background: 'rgba(37, 99, 235, 0.08)',
    border: 'rgba(37, 99, 235, 0.24)',
  },
};

export function ChatPacketStatusBanner({
  status,
  laneId,
  packetId,
  packetTitle,
  mergeMode,
  mergeModeNote,
  onOpenInActivity,
}: ChatPacketStatusBannerProps) {
  const tone = status ? TONE_BY_STATUS[status] : undefined;
  const prOnlyMode = mergeMode === 'pr_only';
  const prOnlyCaption = mergeModeNote ?? 'PR-only mode is active. Create a PR for human merge.';
  const [pending, setPending] = useState<'merge' | 'create_pr' | 'reject' | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');

  const callLaneAction = useCallback(async (verb: 'merge' | 'create_pr') => {
    if (!laneId) return;
    setPending(verb);
    setActionError(null);
    setActionNote(null);
    try {
      const response = await fetch('/api/lanes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verb,
          laneId,
          commitMessage: verb === 'create_pr' ? 'Auto-commit from lane' : `Merge lane: ${packetTitle ?? 'packet'}`,
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; note?: string } | null;
      const note = payload?.note ?? (verb === 'create_pr' ? 'Unable to create PR.' : 'Unable to merge.');
      if (!response.ok || !payload?.ok) {
        throw new Error(verb === 'merge' && /conflict/i.test(note) ? `${note} Try Create PR instead.` : note);
      }
      setActionNote(note);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Lane action failed.');
    } finally {
      setPending(null);
    }
  }, [laneId, packetTitle]);

  // #1293 FIX 2 — request changes / reject. Sends the packet back to the agent
  // with operator feedback via /api/orchestrator/rerun-with-feedback (mirrors
  // ReviewPane's respec wiring). Keyed on packetId (not laneId) so it works
  // whenever a packet is bound, even before a lane rebinds.
  const submitFeedback = useCallback(async () => {
    const trimmed = feedback.trim();
    if (!packetId || !trimmed) return;
    setPending('reject');
    setActionError(null);
    setActionNote(null);
    try {
      const response = await fetch('/api/orchestrator/rerun-with-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId, feedback: trimmed }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        result?: { note?: string };
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to request changes.');
      }
      setActionNote(payload.result?.note ?? 'Sent back to the agent with your feedback.');
      setFeedback('');
      setFeedbackOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to request changes.');
    } finally {
      setPending(null);
    }
  }, [feedback, packetId]);

  if (!tone) return null;

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
        borderColor: tone.border,
        background: tone.background,
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
            background: tone.color,
            color: '#fff',
            fontSize: 9,
            fontWeight: 400,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          {tone.label}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 400, color: tone.color, letterSpacing: '-0.1px' }}>
            {packetTitle ?? 'Dispatched packet'}
          </div>
          <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
            {status === 'awaiting_review' && prOnlyMode
              ? 'PR-only mode is active. Create a PR so a human can merge.'
              : tone.detail}
          </div>
        </div>
      </div>

      {status === 'awaiting_review' && (laneId || packetId) ? (
        feedbackOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What needs to change? Be specific — this prepends to the original prompt."
              disabled={pending === 'reject'}
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
              <button
                type="button"
                onClick={() => { void submitFeedback(); }}
                disabled={!feedback.trim() || pending === 'reject'}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: tone.border,
                  background: tone.background,
                  color: tone.color,
                  fontSize: 11,
                  fontWeight: 400,
                  cursor: !feedback.trim() || pending === 'reject' ? 'not-allowed' : 'pointer',
                  opacity: !feedback.trim() || pending === 'reject' ? 0.5 : 1,
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                {pending === 'reject' ? 'Sending…' : 'Send back'}
              </button>
              <button
                type="button"
                onClick={() => { setFeedbackOpen(false); setFeedback(''); }}
                disabled={pending === 'reject'}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-panel-border)',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  fontSize: 11,
                  fontWeight: 400,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {laneId && !prOnlyMode ? (
              <button
                type="button"
                onClick={() => { void callLaneAction('merge'); }}
                disabled={pending !== null}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 8,
                  borderWidth: 0,
                  background: pending === 'merge' ? 'rgba(22, 163, 74, 0.6)' : '#16a34a',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 400,
                  cursor: pending !== null ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                  letterSpacing: '-0.1px',
                }}
              >
                {pending === 'merge' ? 'Merging…' : 'Approve & merge'}
              </button>
            ) : null}
            {laneId ? (
              <button
                type="button"
                onClick={() => { void callLaneAction('create_pr'); }}
                disabled={pending !== null}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 8,
                  borderWidth: prOnlyMode ? 0 : 1,
                  borderStyle: 'solid',
                  borderColor: prOnlyMode ? 'transparent' : tone.border,
                  background: prOnlyMode ? 'var(--t-accent)' : 'transparent',
                  color: prOnlyMode ? '#fff' : tone.color,
                  fontSize: 11,
                  fontWeight: 400,
                  cursor: pending !== null ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                  letterSpacing: prOnlyMode ? '-0.1px' : undefined,
                }}
              >
                {pending === 'create_pr' ? 'Creating PR…' : 'Create PR'}
              </button>
            ) : null}
            {packetId ? (
              <button
                type="button"
                onClick={() => setFeedbackOpen(true)}
                disabled={pending !== null}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: tone.border,
                  background: 'transparent',
                  color: tone.color,
                  fontSize: 11,
                  fontWeight: 400,
                  cursor: pending !== null ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Request changes
              </button>
            ) : null}
            {onOpenInActivity ? (
              <button
                type="button"
                onClick={onOpenInActivity}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 8,
                  borderWidth: 0,
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  fontSize: 11,
                  fontWeight: 400,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                }}
              >
                Open in Activity
              </button>
            ) : null}
          </div>
          {prOnlyMode ? (
            <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.4 }}>
              {prOnlyCaption}
            </div>
          ) : null}
          </>
        )
      ) : null}

      {actionNote ? (
        <div style={{ fontSize: 11, color: tone.color, lineHeight: 1.4 }}>
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
