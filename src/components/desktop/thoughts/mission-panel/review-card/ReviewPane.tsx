'use client';

import { useCallback, useMemo, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  buildConcerns,
  Concern,
  deriveVerdict,
  FONT_FAMILY,
  paneLabelStyle,
  paneStyle,
  verdictTone,
} from './shared';

/**
 * #729 — REVIEW pane: verdict pill + concerns list + 3 action buttons.
 *
 * Buttons wire to existing endpoints:
 *   Merge          → /api/orchestrator/merge        (approveAndMergePacket)
 *   Re-spec        → /api/orchestrator/rerun-with-feedback
 *   Kill packet    → /api/orchestrator/reset-packet (clearWorktree=true)
 */
function ConcernRow({ concern }: { concern: Concern }) {
  const tone = concern.category === 'mechanical'
    ? { color: '#b91c1c', bg: 'rgba(239, 68, 68, 0.06)', border: 'rgba(239, 68, 68, 0.18)' }
    : concern.category === 'edge-cases'
      ? { color: '#b45309', bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.22)' }
      : concern.category === 'read-budget'
        ? { color: '#2563eb', bg: 'rgba(37, 99, 235, 0.06)', border: 'rgba(37, 99, 235, 0.18)' }
        : { color: 'var(--t-text-secondary)', bg: 'rgba(148, 163, 184, 0.06)', border: 'rgba(148, 163, 184, 0.16)' };
  return (
    <div style={{
      paddingTop: 5,
      paddingRight: 8,
      paddingBottom: 5,
      paddingLeft: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: tone.border,
      background: tone.bg,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: tone.color, fontFamily: FONT_FAMILY, letterSpacing: '-0.005em' }}>
        {concern.label}
      </span>
      <span style={{ fontSize: 10.5, color: 'var(--t-text-secondary)', fontFamily: FONT_FAMILY, lineHeight: 1.4 }}>
        {concern.detail}
      </span>
    </div>
  );
}

export function ReviewPane({ packet, onActionComplete }: {
  packet: OrchestratorPacket;
  onActionComplete?: () => void;
}) {
  const verdict = deriveVerdict(packet);
  const tone = verdictTone(verdict);
  const concerns = useMemo(() => buildConcerns(packet), [packet]);

  const [busy, setBusy] = useState<'merge' | 'respec' | 'kill' | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const reviewSummary = packet.review?.summary?.trim() ?? '';

  const callAction = useCallback(async (
    kind: 'merge' | 'respec' | 'kill',
    body: Record<string, unknown>,
    endpoint: string,
  ) => {
    setBusy(kind);
    setActionError(null);
    setActionNote(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        result?: { note?: string };
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? `Unable to ${kind} packet.`);
      }
      setActionNote(payload.result?.note ?? null);
      onActionComplete?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Unable to ${kind} packet.`);
    } finally {
      setBusy(null);
    }
  }, [onActionComplete]);

  const onMerge = useCallback(() => {
    void callAction('merge', { packetId: packet.id }, '/api/orchestrator/merge');
  }, [callAction, packet.id]);

  const onKill = useCallback(() => {
    void callAction('kill', { packetId: packet.id, clearWorktree: true, reason: 'Killed via review card.' }, '/api/orchestrator/reset-packet');
  }, [callAction, packet.id]);

  const onSubmitFeedback = useCallback(() => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    void callAction('respec', { packetId: packet.id, feedback: trimmed }, '/api/orchestrator/rerun-with-feedback')
      .then(() => {
        setFeedback('');
        setFeedbackOpen(false);
      });
  }, [callAction, feedback, packet.id]);

  return (
    <div style={paneStyle()}>
      <div style={paneLabelStyle()}>REVIEW</div>

      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 6,
        paddingTop: 4,
        paddingRight: 10,
        paddingBottom: 4,
        paddingLeft: 10,
        borderRadius: 999,
        background: tone.background,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: tone.border,
        color: tone.color,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '0.06em',
        fontFamily: FONT_FAMILY,
      }}>
        {tone.label}
      </div>

      {reviewSummary ? (
        <div style={{
          fontSize: 11,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          fontFamily: FONT_FAMILY,
        }}>
          {reviewSummary}
        </div>
      ) : null}

      {concerns.length === 0 ? (
        <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
          No concerns surfaced.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {concerns.map((concern, idx) => (
            <ConcernRow key={`${concern.category}:${idx}`} concern={concern} />
          ))}
        </div>
      )}

      {actionError ? (
        <div style={{
          fontSize: 10.5,
          color: '#b91c1c',
          paddingTop: 5,
          paddingRight: 8,
          paddingBottom: 5,
          paddingLeft: 8,
          borderRadius: 6,
          background: 'rgba(239, 68, 68, 0.06)',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'rgba(239, 68, 68, 0.18)',
          fontFamily: FONT_FAMILY,
        }}>
          {actionError}
        </div>
      ) : null}

      {actionNote ? (
        <div style={{
          fontSize: 10.5,
          color: 'var(--t-text-secondary)',
          fontFamily: FONT_FAMILY,
        }}>
          {actionNote}
        </div>
      ) : null}

      {feedbackOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What needs to change? Be specific — this prepends to the original prompt."
            disabled={busy === 'respec'}
            style={{
              width: '100%',
              minHeight: 70,
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
              fontFamily: FONT_FAMILY,
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={onSubmitFeedback}
              disabled={!feedback.trim() || busy === 'respec'}
              style={{
                paddingTop: 5,
                paddingRight: 10,
                paddingBottom: 5,
                paddingLeft: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(245, 158, 11, 0.36)',
                background: 'rgba(245, 158, 11, 0.14)',
                color: '#b45309',
                fontSize: 10.5,
                fontWeight: 700,
                cursor: !feedback.trim() || busy === 'respec' ? 'not-allowed' : 'pointer',
                opacity: !feedback.trim() || busy === 'respec' ? 0.5 : 1,
                fontFamily: FONT_FAMILY,
              }}
            >
              {busy === 'respec' ? 'Submitting…' : 'Submit feedback'}
            </button>
            <button
              type="button"
              onClick={() => { setFeedbackOpen(false); setFeedback(''); }}
              disabled={busy === 'respec'}
              style={{
                paddingTop: 5,
                paddingRight: 10,
                paddingBottom: 5,
                paddingLeft: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-panel-border)',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontSize: 10.5,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: FONT_FAMILY,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 }}>
          <button
            type="button"
            onClick={onMerge}
            disabled={busy !== null}
            style={{
              paddingTop: 6,
              paddingRight: 12,
              paddingBottom: 6,
              paddingLeft: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(34, 197, 94, 0.36)',
              background: 'rgba(34, 197, 94, 0.14)',
              color: '#15803d',
              fontSize: 11,
              fontWeight: 700,
              cursor: busy !== null ? 'not-allowed' : 'pointer',
              opacity: busy !== null ? 0.5 : 1,
              fontFamily: FONT_FAMILY,
            }}
          >
            {busy === 'merge' ? 'Merging…' : 'Merge'}
          </button>
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            disabled={busy !== null}
            style={{
              paddingTop: 6,
              paddingRight: 12,
              paddingBottom: 6,
              paddingLeft: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(245, 158, 11, 0.36)',
              background: 'rgba(245, 158, 11, 0.10)',
              color: '#b45309',
              fontSize: 11,
              fontWeight: 700,
              cursor: busy !== null ? 'not-allowed' : 'pointer',
              opacity: busy !== null ? 0.5 : 1,
              fontFamily: FONT_FAMILY,
            }}
          >
            Re-spec with fixes
          </button>
          <button
            type="button"
            onClick={onKill}
            disabled={busy !== null}
            style={{
              paddingTop: 6,
              paddingRight: 12,
              paddingBottom: 6,
              paddingLeft: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(239, 68, 68, 0.32)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#b91c1c',
              fontSize: 11,
              fontWeight: 700,
              cursor: busy !== null ? 'not-allowed' : 'pointer',
              opacity: busy !== null ? 0.5 : 1,
              fontFamily: FONT_FAMILY,
            }}
          >
            {busy === 'kill' ? 'Killing…' : 'Kill packet'}
          </button>
        </div>
      )}
    </div>
  );
}
