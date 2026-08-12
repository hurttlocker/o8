'use client';

import { useCallback, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { actionReceiptIsInProgress, correlatedActionIsUnsettled, fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { useCorrelatedActionLatch } from '@/components/desktop/use-correlated-action-latch';

interface RejectedFeedbackPanelProps {
  packet: OrchestratorPacket;
}

const MAX_FEEDBACK_LENGTH = 4000;
const SPINNER_ANIMATION = 'spin 0.9s linear infinite';

/**
 * #662 — One-click rerun-with-feedback.
 *
 * Surfaces on a rejected packet card body. Operator types feedback, hits the
 * button, the API resets+redispatches with the feedback prepended to the
 * original prompt. The rejected lane is archived (not deleted) so the diff
 * stays in lane history.
 */
export function RejectedFeedbackPanel({ packet }: RejectedFeedbackPanelProps) {
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { busy, begin: beginAction, settle: settleAction } = useCorrelatedActionLatch<'rerun'>();
  const submitting = busy === 'rerun';

  const trimmed = feedback.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_FEEDBACK_LENGTH && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !beginAction('rerun')) return;
    setError(null);
    setNote(null);
    let inProgress = false;
    try {
      const requestBody = JSON.stringify({
        packetId: packet.id,
        feedback: trimmed,
        idempotencyKey: crypto.randomUUID(),
      });
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        result?: { note?: string; inProgress?: boolean; status?: string };
        error?: { message?: string };
      }>('/api/orchestrator/rerun-with-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to rerun this packet.');
      }
      if (actionReceiptIsInProgress(response.status, payload.result)) {
        inProgress = true;
        setNote(payload.result?.note ?? 'This rerun is already in progress.');
        return;
      }
      setNote(payload.result?.note ?? `Packet ${packet.referenceLabel} relaunched with feedback.`);
      setFeedback('');
    } catch (caught) {
      if (correlatedActionIsUnsettled(caught)) {
        inProgress = true;
        setNote(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : 'Unable to rerun this packet.');
      }
    } finally {
      settleAction(inProgress);
    }
  }, [beginAction, canSubmit, packet.id, packet.referenceLabel, settleAction, trimmed]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleSubmit();
    }
  }, [handleSubmit]);

  const charCount = feedback.length;
  const overLimit = charCount > MAX_FEEDBACK_LENGTH;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 10,
        paddingRight: 11,
        paddingBottom: 10,
        paddingLeft: 11,
        borderRadius: 14,
        background: 'var(--t-panel)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--red-soft)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg
          width={14}
          height={14}
          viewBox="0 0 256 256"
          fill="var(--red)"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          {/* Phosphor: arrow-counter-clockwise */}
          <path d="M224,128a96,96,0,1,1-21.95-61.09,8,8,0,1,1-12.33,10.18A80,80,0,1,0,207.6,136H176a8,8,0,0,1,0-16h40a8,8,0,0,1,8,8Z" />
        </svg>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--red)',
          }}
        >
          Rejected
        </span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--t-text-secondary)',
            fontWeight: 600,
            letterSpacing: '-0.005em',
          }}
        >
          Try again with feedback
        </span>
      </div>

      <textarea
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`Tell ${packet.referenceLabel} what to fix. The original prompt is preserved; this gets appended.`}
        rows={3}
        disabled={submitting}
        style={{
          width: '100%',
          resize: 'vertical',
          minHeight: 64,
          maxHeight: 220,
          paddingTop: 8,
          paddingRight: 10,
          paddingBottom: 8,
          paddingLeft: 10,
          borderRadius: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: overLimit ? 'var(--red)' : 'var(--t-panel-border)',
          background: 'var(--t-input-bg)',
          color: 'var(--t-text)',
          fontSize: 12,
          lineHeight: 1.5,
          fontFamily: 'var(--font-sans-system)',
          letterSpacing: '-0.005em',
          outline: 'none',
          opacity: submitting ? 0.6 : 1,
          transition: 'border-color 200ms cubic-bezier(0.34, 1.36, 0.64, 1)',
        }}
        aria-label="Operator feedback for rerun"
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => { void handleSubmit(); }}
          disabled={!canSubmit}
          title="Reset this packet's worktree and redispatch with feedback (Cmd+Enter)"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            minWidth: 44,
            height: 44,
            paddingLeft: 14,
            paddingRight: 14,
            borderRadius: 14,
            borderWidth: 0,
            background: canSubmit ? 'var(--t-accent)' : 'var(--t-divider)',
            color: canSubmit ? 'var(--t-terminal-cursor-accent)' : 'var(--t-text-faint)',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            opacity: submitting ? 0.7 : 1,
            transition: 'background 200ms cubic-bezier(0.34, 1.36, 0.64, 1), transform 150ms cubic-bezier(0.34, 1.36, 0.64, 1)',
            fontFamily: 'var(--font-sans-system)',
          }}
          onMouseDown={(event) => {
            if (canSubmit) event.currentTarget.style.transform = 'scale(0.97)';
          }}
          onMouseUp={(event) => {
            event.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.transform = 'scale(1)';
          }}
        >
          {submitting ? (
            <>
              <svg
                width={14}
                height={14}
                viewBox="0 0 256 256"
                fill="currentColor"
                aria-hidden="true"
                style={{ animation: SPINNER_ANIMATION }}
              >
                {/* Phosphor: circle-notch */}
                <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z" />
              </svg>
              Relaunching…
            </>
          ) : (
            <>
              <svg
                width={14}
                height={14}
                viewBox="0 0 256 256"
                fill="currentColor"
                aria-hidden="true"
              >
                {/* Phosphor: arrow-clockwise */}
                <path d="M232,56v48a8,8,0,0,1-8,8H176a8,8,0,0,1,0-16h28.4L182.13,77.66a87.9,87.9,0,1,0,1.21,123.86,8,8,0,1,1,11.59,11A104,104,0,1,1,193,66.69L216,89.43V56a8,8,0,0,1,16,0Z" />
              </svg>
              Try again with feedback
            </>
          )}
        </button>
        <span
          style={{
            fontSize: 10,
            color: overLimit ? 'var(--red)' : 'var(--t-text-faint)',
            fontWeight: 600,
            fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
          }}
        >
          {charCount}/{MAX_FEEDBACK_LENGTH}
        </span>
        {!submitting && !error && trimmed.length === 0 ? (
          <span style={{ fontSize: 10.5, color: 'var(--t-text-faint)' }}>
            Cmd+Enter to submit
          </span>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--red)',
            paddingTop: 6,
            paddingRight: 9,
            paddingBottom: 6,
            paddingLeft: 9,
            borderRadius: 8,
            background: 'var(--red-soft)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--red-soft)',
          }}
        >
          {error}
        </div>
      ) : null}

      {!error && note ? (
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--green)',
            paddingTop: 6,
            paddingRight: 9,
            paddingBottom: 6,
            paddingLeft: 9,
            borderRadius: 8,
            background: 'var(--green-soft)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--green-soft)',
          }}
        >
          {note}
        </div>
      ) : null}

    </div>
  );
}
