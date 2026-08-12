'use client';

/**
 * LaneReviewSummaryHeader — the summary-first block above a packet's branch
 * diff (Q ruling 2026-07-18, Codex PR-view parity: "they would love to see
 * the summary first, not the files — but ours still needed"). Order:
 *
 *   SUMMARY            ← the agent's own prose (transcript tail), clamped
 *   N files · +X −Y    ← counts line
 *   <file rows>        ← per-file +/- rows, click jumps to the file's diff
 *
 * Renders nothing when there is neither prose nor files. Style stays ours:
 * uppercase 10px labels, theme tokens, Issues-density rows, flat hairline
 * separation from the diff below — no card chrome.
 */

import { useCallback, useState } from 'react';
import { ArtifactStrip } from '../../artifacts/ArtifactStrip';
import type { ArtifactRef } from '../../artifacts/types';
import type { ReviewChangedFile } from '@/lib/fleet/types';
import { actionReceiptIsInProgress, correlatedActionIsUnsettled, fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { UI_FONT } from './constants';

const MONO_FONT = 'var(--font-mono-system)';
const CLAMP_LINES = 7;

type MergePhase =
  | { step: 'idle' }
  | { step: 'merging' }
  | { step: 'confirm'; approvalId: string; note: string }
  | { step: 'merged' }
  | { step: 'error'; note: string };

interface MergeResponse {
  ok?: boolean;
  result?: { merged?: boolean; status?: string; note?: string; approvalId?: string | null; inProgress?: boolean } | null;
  error?: { message?: string } | null;
}

export function LaneReviewSummaryHeader({
  summary,
  files,
  totalAdditions,
  totalDeletions,
  onSelectFile,
  packetId,
  laneStatus,
  refreshStatus,
  artifacts,
  onMerged,
}: {
  summary: string | null;
  files: ReviewChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  onSelectFile: (path: string) => void;
  packetId?: string | null;
  laneStatus?: string | null;
  refreshStatus?: () => Promise<string | null>;
  artifacts: ArtifactRef[];
  onMerged?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [merge, setMerge] = useState<MergePhase>({ step: 'idle' });
  const longSummary = Boolean(summary && (summary.length > 620 || summary.split('\n').length > CLAMP_LINES));

  const alreadyMerged = laneStatus === 'merged' || laneStatus === 'released' || laneStatus === 'completed';
  const canMerge = Boolean(packetId) && !alreadyMerged;

  // The governed merge — same endpoint as the packet banner. If the approvals
  // policy raises a card, the CONFIRM step happens right here on the review
  // surface (Q ruling 2026-07-18: the merge lives where the review lives —
  // never bounce the operator to the inbox).
  const runMerge = useCallback(async () => {
    if (!packetId) return;
    setMerge({ step: 'merging' });
    try {
      const { response: res, payload } = await fetchCorrelatedActionReceipt<MergeResponse>('/api/orchestrator/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId, idempotencyKey: crypto.randomUUID() }),
      });
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to merge.');
      }
      const result = payload.result ?? null;
      if (actionReceiptIsInProgress(res.status, result)) {
        setMerge({ step: 'merging' });
      } else if (result?.merged) {
        setMerge({ step: 'merged' });
        onMerged?.();
      } else if (result?.approvalId) {
        // The governed merge raised (or found) a pending approval card — the
        // operator-path response carries approvalId + note without the
        // worker-branch's pending_operator_approval status, so key on the id.
        setMerge({ step: 'confirm', approvalId: result.approvalId, note: result.note ?? 'Approval required.' });
      } else {
        throw new Error(result?.note ?? 'Merge was blocked.');
      }
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) {
        setMerge({ step: 'merging' });
        return;
      }
      setMerge({ step: 'error', note: error instanceof Error ? error.message : 'Merge failed.' });
    }
  }, [onMerged, packetId]);

  const confirmMerge = useCallback(async (approvalId: string) => {
    setMerge({ step: 'merging' });
    try {
      const res = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: approvalId, action: 'approve' }),
      });
      if (!res.ok) throw new Error('Unable to approve the merge.');
      // The approval continuation performs the merge — poll the lane until it
      // reaches a terminal state so the button tells the truth.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const status = await refreshStatus?.();
        // 'archived' is post-merge cleanup's terminal state — in this poll it
        // can only be reached through the approved merge continuation, so it
        // counts as merged.
        if (status === 'merged' || status === 'released' || status === 'completed' || status === 'archived') {
          setMerge({ step: 'merged' });
          onMerged?.();
          return;
        }
        if (status === 'failed' || status === 'awaiting_orchestrator' || status === 'awaiting_human') {
          setMerge({ step: 'error', note: 'Merge did not complete — see the packet card for the escalation.' });
          return;
        }
      }
      setMerge({ step: 'error', note: 'Merge is taking longer than expected — check the packet card.' });
    } catch (error) {
      setMerge({ step: 'error', note: error instanceof Error ? error.message : 'Approval failed.' });
    }
  }, [onMerged, refreshStatus]);

  if (!summary && files.length === 0) return null;

  return (
    <div
      style={{
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontFamily: UI_FONT,
      }}
    >
      {canMerge || merge.step === 'merged' || alreadyMerged ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' as const }}>
          {merge.step === 'merged' || alreadyMerged ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 26,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 999,
                background: 'var(--t-glass-muted)',
                color: 'var(--t-terminal-ansi-bright-green, #16a34a)',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              Merged into main
            </span>
          ) : merge.step === 'confirm' ? (
            <>
              <button
                type="button"
                onClick={() => { void confirmMerge(merge.approvalId); }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 28,
                  paddingLeft: 12,
                  paddingRight: 12,
                  border: 'none',
                  borderRadius: 999,
                  background: 'var(--t-accent)',
                  color: 'var(--t-accent-contrast, #fff)',
                  fontSize: 11.5,
                  fontWeight: 600,
                  fontFamily: UI_FONT,
                  cursor: 'pointer',
                }}
              >
                Confirm merge
              </button>
              <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                Governance card raised — confirming merges into main.
              </span>
            </>
          ) : (
            <button
              type="button"
              onClick={() => { void runMerge(); }}
              disabled={merge.step === 'merging'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 28,
                paddingLeft: 12,
                paddingRight: 12,
                border: 'none',
                borderRadius: 999,
                background: 'var(--t-accent)',
                color: 'var(--t-accent-contrast, #fff)',
                fontSize: 11.5,
                fontWeight: 600,
                fontFamily: UI_FONT,
                cursor: merge.step === 'merging' ? 'default' : 'pointer',
                opacity: merge.step === 'merging' ? 0.6 : 1,
              }}
            >
              {merge.step === 'merging' ? 'Merging…' : 'Approve & merge'}
            </button>
          )}
          {merge.step === 'error' ? (
            <span style={{ fontSize: 11, color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>{merge.note}</span>
          ) : null}
        </div>
      ) : null}

      {summary ? (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              color: 'var(--t-text-faint)',
              marginBottom: 6,
            }}
          >
            Summary
          </div>
          <div
            style={{
              fontSize: 12.5,
              lineHeight: '18px',
              color: 'var(--t-text-secondary)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
              ...(expanded || !longSummary
                ? {}
                : {
                    display: '-webkit-box',
                    WebkitLineClamp: CLAMP_LINES,
                    WebkitBoxOrient: 'vertical' as const,
                    overflow: 'hidden',
                  }),
            } as React.CSSProperties}
          >
            {summary}
          </div>
          {longSummary ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              style={{
                marginTop: 4,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-faint)',
                fontSize: 11,
                fontWeight: 500,
                fontFamily: UI_FONT,
                cursor: 'pointer',
              }}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </>
      ) : null}

      {artifacts.length > 0 ? (
        <div style={{ marginTop: summary ? 14 : 0, marginBottom: files.length > 0 ? 14 : 0 }}>
          <ArtifactStrip artifacts={artifacts} />
        </div>
      ) : null}

      {files.length > 0 ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 7,
              marginTop: summary && artifacts.length === 0 ? 12 : 0,
              marginBottom: 3,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase' as const,
                color: 'var(--t-text-faint)',
              }}
            >
              {files.length === 1 ? '1 file' : `${files.length} files`}
            </span>
            <span style={{ fontSize: 11, fontFamily: MONO_FONT, color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>+{totalAdditions}</span>
            <span style={{ fontSize: 11, fontFamily: MONO_FONT, color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>−{totalDeletions}</span>
          </div>
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => onSelectFile(file.path)}
              title={file.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                height: 26,
                paddingLeft: 6,
                paddingRight: 6,
                paddingTop: 0,
                paddingBottom: 0,
                border: 'none',
                borderRadius: 6,
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left' as const,
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-glass-muted)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  direction: 'rtl',
                  fontSize: 11.5,
                  fontFamily: MONO_FONT,
                  color: 'var(--t-text)',
                }}
              >
                {file.path}
              </span>
              <span style={{ flexShrink: 0, fontSize: 11, fontFamily: MONO_FONT, color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>
                +{file.additions ?? 0}
              </span>
              <span style={{ flexShrink: 0, fontSize: 11, fontFamily: MONO_FONT, color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>
                −{file.deletions ?? 0}
              </span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}
