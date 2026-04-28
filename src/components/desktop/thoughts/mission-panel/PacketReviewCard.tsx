'use client';

import { useEffect, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { DiffPane } from './review-card/DiffPane';
import { ReviewPane } from './review-card/ReviewPane';
import { SpecPane } from './review-card/SpecPane';
import {
  DiffPayload,
  DirectiveSummary,
  PANE_BORDER_COLOR,
} from './review-card/shared';
import type { ReviewPanelState } from './types';

/**
 * #729 — Packet Review Card.
 *
 * The hero feature: 3-pane review surface that replaces the lighter-weight
 * PacketReviewPanel for packets in `awaiting_review`.
 *
 * Layout:
 *   ┌─────────────┬─────────────┬─────────────┐
 *   │ SPEC +      │ DIFF        │ REVIEW      │
 *   │ Directives  │ (file tree, │ (verdict,   │
 *   │             │  unified)   │  concerns,  │
 *   │             │             │  actions)   │
 *   └─────────────┴─────────────┴─────────────┘
 *
 * All endpoints are existing. We add no new visual primitives — just rgba+
 * palette tokens already in the design system.
 */
interface PacketReviewCardProps {
  packet: OrchestratorPacket;
  reviewState: ReviewPanelState | null;
  onActionComplete?: () => void;
}

export function PacketReviewCard({ packet, reviewState, onActionComplete }: PacketReviewCardProps) {
  const [directives, setDirectives] = useState<DirectiveSummary[] | null>(null);
  const [directivesError, setDirectivesError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const worktreePath = reviewState?.worktreePath ?? packet.lane?.worktreePath ?? null;
  const baseBranchHint = packet.branchTarget && packet.branchTarget.trim() ? packet.branchTarget : null;

  // Load directives once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/cortex/directives', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json() as { directives?: DirectiveSummary[] };
        if (cancelled) return;
        setDirectives(payload.directives ?? []);
      } catch (error) {
        if (cancelled) return;
        setDirectivesError(error instanceof Error ? error.message : 'Unable to load directives.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load diff when worktreePath becomes known.
  useEffect(() => {
    if (!worktreePath) {
      setDiff(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    (async () => {
      try {
        const params = new URLSearchParams({ worktreePath });
        if (baseBranchHint) params.set('baseBranch', baseBranchHint);
        const response = await fetch(`/api/worktrees/diff?${params.toString()}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json() as DiffPayload & { error?: string };
        if (cancelled) return;
        if (payload.error) {
          setDiffError(payload.error);
          setDiff(null);
        } else {
          setDiff(payload);
        }
      } catch (error) {
        if (cancelled) return;
        setDiffError(error instanceof Error ? error.message : 'Unable to load diff.');
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [worktreePath, baseBranchHint, packet.id]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      gap: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      borderTopWidth: 1,
      borderTopStyle: 'solid',
      borderTopColor: PANE_BORDER_COLOR,
      background: 'var(--t-panel)',
    }}>
      <div style={{ flex: 1, minWidth: 0, borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: PANE_BORDER_COLOR }}>
        <SpecPane packet={packet} directives={directives} directivesError={directivesError} />
      </div>
      <div style={{ flex: 1, minWidth: 0, borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: PANE_BORDER_COLOR }}>
        <DiffPane packet={packet} reviewState={reviewState} diff={diff} diffLoading={diffLoading} diffError={diffError} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ReviewPane packet={packet} onActionComplete={onActionComplete} />
      </div>
    </div>
  );
}
