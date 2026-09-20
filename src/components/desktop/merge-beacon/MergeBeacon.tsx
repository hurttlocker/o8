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
 *   • Review merge — opens one exact approved lane in the review surface. The
 *             review surface owns the explicit governed merge action, so this
 *             status-bar control never mutates a worktree.
 *
 * Pure signal: returns null when nothing is parked, so it only appears when
 * there's genuinely something waiting.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { useQuietMode } from '@/lib/presentation/quiet-mode-client';
import { noticeIsVisible } from '@/lib/presentation/quiet-mode-policy';
import { ComposerPopover } from '../thoughts/chat-panel/ComposerPopover';
import type { ParkedLane } from './derive';

function laneDescription(lane: ParkedLane) {
  return `${lane.label?.trim() || 'Untitled lane'} from ${lane.branch?.trim() || 'unknown branch'}`;
}

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
  const [chooserOpen, setChooserOpen] = useState(false);
  const reviewButtonRef = useRef<HTMLButtonElement | null>(null);
  const chooserItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const escalated = parked.filter((lane) => lane.reviewState === 'escalated');
  const rejected = parked.filter((lane) => lane.reviewState === 'rejected');
  const needsReview = parked.filter((lane) => lane.reviewState === 'needs-review');
  const awaitingMerge = parked.filter((lane) => lane.reviewState === 'awaiting-merge');
  // #2147 — the whole cluster is a count pill plus its action. It is the
  // "N escalated" badge the issue names, so quiet mode takes it down; the merge
  // it fronts is still reachable from the Inbox and the review surface.
  const quietMode = useQuietMode();

  const escalatedCount = escalated.length;
  const rejectedCount = rejected.length;
  const needsReviewCount = needsReview.length;
  const awaitingMergeCount = awaitingMerge.length;
  const urgent = escalatedCount > 0 || rejectedCount > 0 || needsReviewCount > 0;
  const selectedMergeLane = awaitingMerge[0] ?? null;
  const chooserVisible = chooserOpen && awaitingMergeCount > 1;
  const chooserMenuId = 'merge-beacon-approved-lanes';
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

  const openReview = (lane: ParkedLane) => {
    focusLane(lane);
    onOpenNeedsReviewLane?.(lane);
    setChooserOpen(false);
  };

  const closeChooser = () => {
    setChooserOpen(false);
    reviewButtonRef.current?.focus();
  };

  useEffect(() => {
    if (!chooserVisible) return;
    const frame = requestAnimationFrame(() => chooserItemRefs.current[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [chooserVisible]);

  const handleChooserKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = chooserItemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeChooser();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const lastIndex = awaitingMerge.length - 1;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? lastIndex
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + awaitingMerge.length) % awaitingMerge.length
          : (currentIndex - 1 + awaitingMerge.length) % awaitingMerge.length;
    chooserItemRefs.current[nextIndex]?.focus();
  };

  const handleView = () => {
    const lane = escalated[0] ?? rejected[0] ?? needsReview[0];
    if (lane) {
      openReview(lane);
      return;
    }
    if (selectedMergeLane) {
      openReview(selectedMergeLane);
      return;
    }
    onOpenAwaitingMerge?.();
  };

  const handleReviewMerge = () => {
    if (!selectedMergeLane) return;
    if (awaitingMergeCount > 1) {
      setChooserOpen(true);
      return;
    }
    openReview(selectedMergeLane);
  };

  if (!noticeIsVisible('status-pill', quietMode) || compact || parked.length === 0 || segments.length === 0) return null;

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
        ref={reviewButtonRef}
        type="button"
        onClick={handleReviewMerge}
        onKeyDown={(event) => {
          if (awaitingMergeCount > 1 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            if (chooserVisible) chooserItemRefs.current[0]?.focus();
            else setChooserOpen(true);
          }
        }}
        disabled={!selectedMergeLane}
        aria-label={selectedMergeLane ? awaitingMergeCount > 1 ? `Review merge: choose from ${awaitingMergeCount} approved lanes` : `Review merge: ${laneDescription(selectedMergeLane)}` : 'No approved work to review'}
        aria-haspopup={awaitingMergeCount > 1 ? 'menu' : undefined}
        aria-expanded={awaitingMergeCount > 1 ? chooserVisible : undefined}
        aria-controls={awaitingMergeCount > 1 ? chooserMenuId : undefined}
        title={selectedMergeLane ? awaitingMergeCount > 1 ? `Choose one of ${awaitingMergeCount} approved lanes to review. Merging is a separate action in review.` : `Review merge for ${laneDescription(selectedMergeLane)}. Opens its exact diff; merging is a separate action in review.` : 'Merge review is available once a lane is approved'}
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
          borderColor: selectedMergeLane ? 'var(--t-tone-success-border)' : 'var(--t-divider-subtle)',
          background: selectedMergeLane ? 'var(--t-tone-success-bg)' : 'var(--t-input-bg)',
          color: selectedMergeLane ? 'var(--t-tone-success)' : 'var(--t-text-faint)',
          cursor: selectedMergeLane ? 'pointer' : 'default',
          opacity: awaitingMergeCount > 0 ? 1 : 0.55,
          fontFamily: 'var(--font-sans-system)',
          fontSize: 11.5,
          fontWeight: 600,
          letterSpacing: '-0.1px',
          whiteSpace: 'nowrap',
        }}
      >
        <span>Review merge</span>
      </button>

      <ComposerPopover anchorRef={reviewButtonRef} open={chooserVisible} onClose={closeChooser} align="end">
        <div
          id={chooserMenuId}
          role="menu"
          aria-label="Approved lanes"
          onKeyDown={handleChooserKeyDown}
          style={{
            width: 'min(300px, calc(100vw * var(--zoom-inverse, 1) - 24px))',
            maxHeight: 'min(320px, calc(100vh * var(--zoom-inverse, 1) - 72px))',
            paddingTop: 6,
            paddingRight: 6,
            paddingBottom: 6,
            paddingLeft: 6,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-input-border)',
            borderRadius: 8,
            background: 'var(--t-panel)',
            boxShadow: 'var(--t-shadow-popover)',
            overflowY: 'auto',
            overflowX: 'hidden',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
              <div style={{ paddingTop: 2, paddingRight: 6, paddingBottom: 6, paddingLeft: 6, color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 600 }}>
                {awaitingMergeCount} approved lanes
              </div>
              {awaitingMerge.map((lane, index) => (
                <button
                  key={lane.packetId}
                  ref={(node) => { chooserItemRefs.current[index] = node; }}
                  type="button"
                  role="menuitem"
                  onClick={() => openReview(lane)}
                  aria-label={`Review ${lane.label?.trim() || 'untitled lane'}`}
                  title={`Review ${laneDescription(lane)}. This does not merge the lane.`}
                  style={{
                    display: 'block',
                    width: '100%',
                    paddingTop: 6,
                    paddingRight: 8,
                    paddingBottom: 6,
                    paddingLeft: 8,
                    borderWidth: 0,
                    borderRadius: 5,
                    background: 'transparent',
                    color: 'var(--t-text)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans-system)',
                    fontSize: 11.5,
                    textAlign: 'left',
                  }}
                >
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lane.label?.trim() || 'Untitled lane'}</span>
                  <span style={{ display: 'block', marginTop: 2, color: 'var(--t-text-faint)', fontFamily: 'var(--font-mono-system)', fontSize: 10 }}>{lane.branch?.trim() || 'unknown branch'}</span>
                </button>
              ))}
        </div>
      </ComposerPopover>
    </div>
  );
}

export const MergeBeacon = memo(MergeBeaconBase);
