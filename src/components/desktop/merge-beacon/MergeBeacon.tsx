'use client';

/**
 * MergeBeacon — a fleet-wide review gate pill in the bottom status bar,
 * sitting just left of MergeActionCluster (which it never touches). It splits
 * reviewing lanes into work that still needs operator review vs work already
 * approved and waiting on merge.
 *
 * Pure signal: returns null when nothing is parked, so it only appears when
 * there's genuinely something waiting. Click → the first needs-review lane's
 * review surface, or the Inbox tab when everything left is awaiting merge.
 */

import { memo } from 'react';
import type { ParkedLane } from './derive';

function MergeBeaconBase({
  parked,
  compact,
  onOpenNeedsReviewLane,
  onOpenAwaitingMerge,
}: {
  parked: ParkedLane[];
  compact?: boolean;
  onOpenNeedsReviewLane?: (lane: ParkedLane) => void;
  onOpenAwaitingMerge?: () => void;
}) {
  const escalated = parked.filter((lane) => lane.reviewState === 'escalated');
  const needsReview = parked.filter((lane) => lane.reviewState === 'needs-review');
  const awaitingMerge = parked.filter((lane) => lane.reviewState === 'awaiting-merge');
  if (compact || parked.length === 0) return null;

  const escalatedCount = escalated.length;
  const needsReviewCount = needsReview.length;
  const awaitingMergeCount = awaitingMerge.length;
  const urgent = escalatedCount > 0 || needsReviewCount > 0;
  const title = `Escalated: ${escalatedCount}. Needs review: ${needsReviewCount}. Approved awaiting merge: ${awaitingMergeCount}.`;

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

  const handleClick = () => {
    const lane = escalated[0] ?? needsReview[0];
    if (lane) {
      focusLane(lane);
      onOpenNeedsReviewLane?.(lane);
      return;
    }
    onOpenAwaitingMerge?.();
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={handleClick}
        aria-label={title}
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
        {escalatedCount > 0 ? (
          <>
            <span>{escalatedCount} escalated</span>
            <span style={{ color: 'var(--t-text-faint)' }}>·</span>
          </>
        ) : null}
        <span>{needsReviewCount} review</span>
        {awaitingMergeCount > 0 ? (
          <>
            <span style={{ color: 'var(--t-text-faint)' }}>·</span>
            <span style={{ color: urgent ? 'var(--t-text-muted)' : 'var(--t-text-faint)' }}>{awaitingMergeCount} merge</span>
          </>
        ) : null}
      </button>
    </div>
  );
}

export const MergeBeacon = memo(MergeBeaconBase);
