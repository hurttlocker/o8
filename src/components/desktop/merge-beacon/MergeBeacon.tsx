'use client';

/**
 * MergeBeacon — a fleet-wide review gate cluster in the bottom status bar,
 * sitting just left of MergeActionCluster (which it never touches). It splits
 * reviewing lanes into work that still needs operator review vs work already
 * approved and waiting on merge.
 *
 * Two controls (Q ruling 2026-07-11):
 *   • View  — the counts pill. Click → the first needs-review lane's review
 *             surface, or the Inbox tab when everything left is awaiting merge.
 *   • Merge — the o8-native worktree merge. Enabled only when a lane is already
 *             approved and parked in `awaiting-merge`. Runs the governed
 *             approve_and_merge path (POST /api/orchestrator/merge → operator
 *             context merges directly; a worker-token context raises an
 *             approval card instead). No GitHub PR is required for o8-dispatched
 *             work — this is the daily merge, so it belongs on the bottom bar.
 *
 * Pure signal: returns null when nothing is parked, so it only appears when
 * there's genuinely something waiting.
 */

import { memo, useEffect, useState } from 'react';
import { actionReceiptIsInProgress, correlatedActionIsUnsettled, fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { useCorrelatedActionLatch } from '@/components/desktop/use-correlated-action-latch';
import type { ParkedLane } from './derive';

function MergeGlyph({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="4" cy="3" r="1.4" />
      <circle cx="11.5" cy="11.5" r="2.4" />
      <path d="M4 4.4 V8.5 A2.6 2.6 0 0 0 6.6 11.1 H8.6" />
    </svg>
  );
}

function SpinnerGlyph({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" style={{ animation: 'spin 0.9s linear infinite' }} aria-hidden>
      <path d="M8 1.6 A6.4 6.4 0 1 1 1.6 8" />
    </svg>
  );
}

function MergeBeaconBase({
  parked,
  compact,
  onOpenNeedsReviewLane,
  onOpenAwaitingMerge,
  onMerged,
}: {
  parked: ParkedLane[];
  compact?: boolean;
  onOpenNeedsReviewLane?: (lane: ParkedLane) => void;
  onOpenAwaitingMerge?: () => void;
  /** Fired after a merge attempt resolves so the parent can refresh if needed
   *  (the route already fires a realtime refresh; this is an extra hook). */
  onMerged?: (lane: ParkedLane, ok: boolean) => void;
}) {
  const [toast, setToast] = useState<{ tone: 'success' | 'fail'; message: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(handle);
  }, [toast]);

  const escalated = parked.filter((lane) => lane.reviewState === 'escalated');
  const rejected = parked.filter((lane) => lane.reviewState === 'rejected');
  const needsReview = parked.filter((lane) => lane.reviewState === 'needs-review');
  const awaitingMerge = parked.filter((lane) => lane.reviewState === 'awaiting-merge');
  const { busy, begin: beginMerge, settle: settleMerge } = useCorrelatedActionLatch<'merge'>();
  const merging = busy === 'merge';
  if (compact || parked.length === 0) return null;

  const escalatedCount = escalated.length;
  const rejectedCount = rejected.length;
  const needsReviewCount = needsReview.length;
  const awaitingMergeCount = awaitingMerge.length;
  const urgent = escalatedCount > 0 || rejectedCount > 0 || needsReviewCount > 0;
  const canMerge = awaitingMergeCount > 0 && !merging;
  const title = `Escalated: ${escalatedCount}. Rejected: ${rejectedCount}. Needs review: ${needsReviewCount}. Approved awaiting merge: ${awaitingMergeCount}.`;

  // Non-zero attention segments only — a rejected packet reads as "rejected"
  // (a review happened and came back bad), distinct from a fresh "review". The
  // awaiting-merge count trails as a faint informational tail; the Merge button
  // is the action for it.
  const segments: Array<{ key: string; text: string; faint?: boolean }> = [];
  if (escalatedCount > 0) segments.push({ key: 'escalated', text: `${escalatedCount} escalated` });
  if (rejectedCount > 0) segments.push({ key: 'rejected', text: `${rejectedCount} rejected` });
  if (needsReviewCount > 0) segments.push({ key: 'review', text: `${needsReviewCount} review` });
  if (awaitingMergeCount > 0) segments.push({ key: 'merge', text: `${awaitingMergeCount} merge`, faint: true });
  if (segments.length === 0) return null;

  const focusLane = (lane: ParkedLane) => {
    if (typeof window === 'undefined') return;
    if (lane.branch) {
      window.dispatchEvent(new CustomEvent('o8:orchestrator-worktree-selection', {
        detail: {
          tabId: 'merge-beacon',
          repoPath: lane.repoPath ?? null,
          branch: lane.branch,
          worktreeMode: 'new-worktree',
        },
      }));
    }
  };

  const handleView = () => {
    const lane = escalated[0] ?? rejected[0] ?? needsReview[0];
    if (lane) {
      focusLane(lane);
      onOpenNeedsReviewLane?.(lane);
      return;
    }
    onOpenAwaitingMerge?.();
  };

  const runMerge = async () => {
    const lane = awaitingMerge[0];
    if (!lane || !beginMerge('merge')) return;
    let inProgress = false;
    try {
      const { response: res, payload: body } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        result?: { merged?: boolean; status?: string; note?: string; inProgress?: boolean } | null;
        error?: { message?: string } | null;
      }>('/api/orchestrator/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId: lane.packetId, idempotencyKey: crypto.randomUUID() }),
      });

      if (!res.ok || !body?.ok) {
        setToast({ tone: 'fail', message: body?.error?.message || 'Merge failed' });
        onMerged?.(lane, false);
        return;
      }
      const result = body.result ?? null;
      if (actionReceiptIsInProgress(res.status, result)) {
        inProgress = true;
        setToast({ tone: 'success', message: result?.note || 'Merge is already in progress' });
        return;
      }
      if (result?.status === 'pending_operator_approval') {
        setToast({ tone: 'success', message: 'Approval raised' });
        onMerged?.(lane, true);
        return;
      }
      if (result?.merged) {
        setToast({ tone: 'success', message: 'Merged' });
        onMerged?.(lane, true);
        return;
      }
      setToast({ tone: 'fail', message: result?.note || 'Merge blocked' });
      onMerged?.(lane, false);
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) {
        inProgress = true;
        setToast({ tone: 'success', message: error.message });
      } else {
        setToast({ tone: 'fail', message: error instanceof Error ? error.message : 'Merge failed' });
        onMerged?.(awaitingMerge[0], false);
      }
    } finally {
      settleMerge(inProgress);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        onClick={handleView}
        aria-label={`View — ${title}`}
        title={title}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
          paddingLeft: 8,
          paddingRight: 9,
          borderRadius: 7,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: urgent ? 'color-mix(in srgb, var(--t-brand-orange) 30%, var(--t-divider-subtle))' : 'var(--t-divider-subtle)',
          background: urgent ? 'color-mix(in srgb, var(--t-brand-orange) 12%, transparent)' : 'var(--t-input-bg)',
          color: urgent ? 'var(--t-brand-orange)' : 'var(--t-text-muted)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 11.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: urgent ? 'var(--t-brand-orange)' : 'var(--t-text-faint)', flexShrink: 0 }} />
        {segments.map((segment, index) => (
          <span key={segment.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {index > 0 ? <span style={{ color: 'var(--t-text-faint)' }}>·</span> : null}
            <span style={segment.faint ? { color: urgent ? 'var(--t-text-muted)' : 'var(--t-text-faint)' } : undefined}>
              {segment.text}
            </span>
          </span>
        ))}
      </button>

      <button
        type="button"
        onClick={runMerge}
        disabled={!canMerge}
        aria-label={awaitingMergeCount > 0 ? `Merge ${awaitingMergeCount} approved` : 'No approved work to merge'}
        title={awaitingMergeCount > 0 ? `Merge ${awaitingMergeCount} approved lane${awaitingMergeCount === 1 ? '' : 's'} into main` : 'Merge is available once a lane is approved'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 22,
          paddingLeft: 8,
          paddingRight: 9,
          borderRadius: 7,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: canMerge ? 'var(--t-tone-success-border)' : 'var(--t-divider-subtle)',
          background: canMerge ? 'var(--t-tone-success-bg)' : 'var(--t-input-bg)',
          color: canMerge ? 'var(--t-tone-success)' : 'var(--t-text-faint)',
          cursor: canMerge ? 'pointer' : 'default',
          opacity: awaitingMergeCount > 0 ? 1 : 0.55,
          fontFamily: 'var(--font-sans-system)',
          fontSize: 11.5,
          fontWeight: 600,
          letterSpacing: '-0.1px',
          whiteSpace: 'nowrap',
        }}
      >
        {merging ? (
          <SpinnerGlyph size={12} color="var(--t-tone-success)" />
        ) : (
          <MergeGlyph size={12} color={canMerge ? 'var(--t-tone-success)' : 'var(--t-text-faint)'} />
        )}
        <span>Merge</span>
      </button>

      {toast ? (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: toast.tone === 'success' ? 'var(--t-tone-success)' : 'var(--t-tone-fail)',
            letterSpacing: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {toast.message}
        </span>
      ) : null}
    </div>
  );
}

export const MergeBeacon = memo(MergeBeaconBase);
