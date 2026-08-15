'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  DEFAULT_QUIZ_FILE_THRESHOLD,
  isQuizGateBlocking,
  quizPassed,
  type QuizAnswers,
} from '@/lib/orchestrator/quiz-gate';
import { actionReceiptIsInProgress, correlatedActionIsUnsettled, fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { useCorrelatedActionLatch } from '@/components/desktop/use-correlated-action-latch';
import { WorkspaceParkControl } from '@/components/desktop/workspace-terminal/WorkspaceParkControl';
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
  const laneId = packet.lane?.laneId ?? null;
  const prOnlyMode = packet.lane?.mergeMode === 'pr_only';
  const prOnlyCaption = packet.lane?.mergeModeNote ?? 'PR-only mode is active. Create a PR for human merge.';

  const { busy, begin: beginAction, settle: settleAction } = useCorrelatedActionLatch<
    'merge' | 'create_pr' | 'respec' | 'kill'
  >();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  // #1491 — quiz-gated human merge. Fetch the per-operator gate setting; the
  // gate only blocks when ON, the packet is over the file threshold, and a quiz
  // exists (explainer generation off/failed degrades to ungated).
  const [quizGateEnabled, setQuizGateEnabled] = useState(false);
  const [answers, setAnswers] = useState<QuizAnswers>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/panel/operator-defaults', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json() as { values?: { quizGateEnabled?: boolean } };
        if (!cancelled) setQuizGateEnabled(Boolean(payload.values?.quizGateEnabled));
      } catch {
        // Leave the gate off on a fetch failure — never block on our own error.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const quiz = packet.explainer?.status === 'ready' ? packet.explainer.quiz ?? null : null;
  const changedFileCount = packet.explainer?.changedFileCount ?? 0;
  const quizGateEngaged = quizGateEnabled
    && changedFileCount > DEFAULT_QUIZ_FILE_THRESHOLD
    && Boolean(quiz && quiz.questions.length > 0);
  const gateBlocking = isQuizGateBlocking({ enabled: quizGateEnabled, changedFileCount, quiz, answers });
  const quizIsPassed = quizGateEngaged && quizPassed(quiz, answers);

  const reviewSummary = packet.review?.summary?.trim() ?? '';
  const directivesApplied = packet.review?.directivesApplied ?? [];
  const directivesViolated = packet.review?.directivesViolated ?? [];
  const hasDirectiveSurfacing = directivesApplied.length > 0 || directivesViolated.length > 0;

  const callAction = useCallback(async (
    kind: 'merge' | 'respec' | 'kill',
    body: Record<string, unknown>,
    endpoint: string,
  ) => {
    if (!beginAction(kind)) return false;
    setActionError(null);
    setActionNote(null);
    let inProgress = false;
    try {
      const correlatedBody = endpoint === '/api/orchestrator/reset-packet'
        || endpoint === '/api/orchestrator/rerun-with-feedback'
        || endpoint === '/api/orchestrator/merge'
        ? { ...body, idempotencyKey: crypto.randomUUID() }
        : body;
      const requestBody = JSON.stringify(correlatedBody);
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        result?: { note?: string; merged?: boolean; inProgress?: boolean; status?: string };
        error?: { message?: string };
      }>(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? `Unable to ${kind} packet.`);
      }
      if (actionReceiptIsInProgress(response.status, payload.result)) {
        inProgress = true;
        setActionNote(payload.result?.note ?? `${kind === 'merge' ? 'Merge' : 'Packet action'} is already in progress.`);
        return false;
      }
      if (kind === 'merge' && payload.result?.merged === false) {
        throw new Error(payload.result.note ?? 'Merge was refused.');
      }
      setActionNote(payload.result?.note ?? null);
      onActionComplete?.();
      return true;
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) {
        inProgress = true;
        setActionNote(error.message);
      } else {
        setActionError(error instanceof Error ? error.message : `Unable to ${kind} packet.`);
      }
      return false;
    } finally {
      settleAction(inProgress);
    }
  }, [beginAction, onActionComplete, settleAction]);

  const onMerge = useCallback(() => {
    void callAction('merge', { packetId: packet.id }, '/api/orchestrator/merge');
  }, [callAction, packet.id]);

  const onCreatePr = useCallback(async () => {
    if (!laneId) {
      setActionError('No lane is bound to this packet yet.');
      return;
    }
    if (!beginAction('create_pr')) return;
    setActionError(null);
    setActionNote(null);
    try {
      const response = await fetch('/api/lanes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verb: 'create_pr',
          laneId,
          commitMessage: 'Auto-commit from lane',
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; note?: string } | null;
      const note = payload?.note ?? 'Unable to create PR.';
      if (!response.ok || !payload?.ok) {
        throw new Error(note);
      }
      setActionNote(note);
      onActionComplete?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to create PR.');
    } finally {
      settleAction(false);
    }
  }, [beginAction, laneId, onActionComplete, settleAction]);

  const onKill = useCallback(() => {
    void callAction('kill', { packetId: packet.id, clearWorktree: true, reason: 'Killed via review card.' }, '/api/orchestrator/reset-packet');
  }, [callAction, packet.id]);

  const onSubmitFeedback = useCallback(() => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    void callAction('respec', { packetId: packet.id, feedback: trimmed }, '/api/orchestrator/rerun-with-feedback')
      .then((completed) => {
        if (!completed) return;
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

      {hasDirectiveSurfacing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--t-text-faint)',
            fontFamily: FONT_FAMILY,
            textTransform: 'uppercase',
          }}>
            Directives
          </div>
          {directivesApplied.map((directive) => (
            <div
              key={`applied:${directive}`}
              style={{
                paddingTop: 4,
                paddingRight: 8,
                paddingBottom: 4,
                paddingLeft: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-tone-success-border)',
                background: 'var(--t-tone-success-bg)',
                color: 'var(--t-tone-success)',
                fontSize: 10.5,
                fontFamily: FONT_FAMILY,
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
              }}
            >
              <span aria-hidden="true" style={{ fontWeight: 800 }}>✓</span>
              <span style={{ fontWeight: 700 }}>APPLIED</span>
              <span style={{ color: 'var(--t-text-secondary)' }}>{directive}</span>
            </div>
          ))}
          {directivesViolated.map((violation, idx) => {
            const locator = violation.file
              ? typeof violation.line === 'number'
                ? `${violation.file}:${violation.line}`
                : violation.file
              : null;
            return (
              <div
                key={`violated:${violation.directive}:${idx}`}
                style={{
                  paddingTop: 4,
                  paddingRight: 8,
                  paddingBottom: 4,
                  paddingLeft: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-tone-fail-border)',
                  background: 'var(--t-tone-fail-bg)',
                  color: 'var(--t-tone-fail)',
                  fontSize: 10.5,
                  fontFamily: FONT_FAMILY,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span aria-hidden="true" style={{ fontWeight: 800 }}>⚠</span>
                  <span style={{ fontWeight: 700 }}>VIOLATED</span>
                  <span style={{ color: 'var(--t-text-secondary)' }}>{violation.directive}</span>
                  {locator ? (
                    <span style={{
                      marginLeft: 'auto',
                      color: 'var(--t-text-muted)',
                      fontSize: 10,
                      fontFamily: FONT_FAMILY,
                    }}>
                      {locator}
                    </span>
                  ) : null}
                </div>
                {violation.snippet ? (
                  <code style={{
                    fontSize: 10,
                    color: 'var(--t-text-muted)',
                    fontFamily: 'SF Mono, Menlo, Monaco, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    {violation.snippet}
                  </code>
                ) : null}
              </div>
            );
          })}
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

      {quizGateEngaged ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          paddingTop: 8,
          paddingRight: 8,
          paddingBottom: 8,
          paddingLeft: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: quizIsPassed ? 'var(--t-tone-success-border)' : 'rgba(245, 158, 11, 0.28)',
          background: quizIsPassed ? 'var(--t-tone-success-bg)' : 'rgba(245, 158, 11, 0.06)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: quizIsPassed ? 'var(--t-tone-success)' : '#b45309', fontFamily: FONT_FAMILY }}>
            {quizIsPassed ? 'Quiz passed — merge unlocked' : `Answer to unlock merge (${changedFileCount} files changed)`}
          </div>
          {(quiz?.questions ?? []).map((question) => (
            <div key={question.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--t-text)', fontFamily: FONT_FAMILY, lineHeight: 1.4 }}>
                {question.prompt}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {question.options.map((option, optionIndex) => {
                  const selected = answers[question.id] === optionIndex;
                  return (
                    <button
                      key={optionIndex}
                      type="button"
                      onClick={() => setAnswers((current) => ({ ...current, [question.id]: optionIndex }))}
                      style={{
                        paddingTop: 4,
                        paddingRight: 8,
                        paddingBottom: 4,
                        paddingLeft: 8,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: selected ? 'var(--t-accent)' : 'var(--t-divider)',
                        background: selected ? 'var(--t-input-bg, var(--t-panel))' : 'transparent',
                        color: 'var(--t-text-secondary)',
                        fontSize: 10.5,
                        fontFamily: FONT_FAMILY,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
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
        <>
        {prOnlyMode ? (
          <div style={{
            fontSize: 10.5,
            color: 'var(--t-text-secondary)',
            fontFamily: FONT_FAMILY,
            lineHeight: 1.4,
          }}>
            {prOnlyCaption}
          </div>
        ) : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 }}>
          {prOnlyMode ? (
            <button
              type="button"
              onClick={onCreatePr}
              disabled={busy !== null || !laneId || gateBlocking}
              title={gateBlocking ? 'Pass the explainer quiz to unlock.' : undefined}
              style={{
                paddingTop: 6,
                paddingRight: 12,
                paddingBottom: 6,
                paddingLeft: 12,
                borderRadius: 10,
                borderWidth: 0,
                background: 'var(--t-accent)',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                cursor: busy !== null || !laneId || gateBlocking ? 'not-allowed' : 'pointer',
                opacity: busy !== null || !laneId || gateBlocking ? 0.5 : 1,
                fontFamily: FONT_FAMILY,
              }}
            >
              {busy === 'create_pr' ? 'Creating PR…' : 'Create PR'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onMerge}
              disabled={busy !== null || gateBlocking}
              title={gateBlocking ? 'Pass the explainer quiz to unlock.' : undefined}
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
                cursor: busy !== null || gateBlocking ? 'not-allowed' : 'pointer',
                opacity: busy !== null || gateBlocking ? 0.5 : 1,
                fontFamily: FONT_FAMILY,
              }}
            >
              {busy === 'merge' ? 'Merging…' : 'Merge'}
            </button>
          )}
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
        </>
      )}
      <WorkspaceParkControl packetId={packet.id} />
    </div>
  );
}
