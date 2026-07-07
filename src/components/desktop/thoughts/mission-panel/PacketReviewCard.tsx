'use client';

import { useEffect, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { summarizeLaneReviewDiff } from '@/lib/review/lane-diff';
import { DiffPane } from './review-card/DiffPane';
import { PacketExplainerPane } from './review-card/PacketExplainerPane';
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
  // #840 — Bumped on `o8:cortex-changes` so the directive list refetches
  // after a merge appends a trailer.
  const [directiveRefreshTick, setDirectiveRefreshTick] = useState(0);

  const laneId = packet.lane?.laneId ?? null;
  const baseBranchHint = packet.branchTarget && packet.branchTarget.trim() ? packet.branchTarget : null;
  const repoPath = packet.workspaceTargetPath ?? null;

  // #1491 — Explainer/Diff switcher for the middle pane. Default to the
  // explainer when it's ready; the raw diff stays one click away. When no
  // explainer exists the middle pane is just the diff (prior behavior).
  const hasExplainer = Boolean(packet.explainer);
  const [middleView, setMiddleView] = useState<'explainer' | 'diff'>(
    packet.explainer?.status === 'ready' ? 'explainer' : 'diff',
  );

  // Load directives once on mount, and again whenever the cortex-changes
  // bus signals a directive write.
  //
  // #899 dogfood follow-up — pass repoPath so the server applies the same
  // project / repo / global scope filter that dispatch uses. Without this,
  // project-scoped directives leaked to repos outside the project.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = repoPath
          ? `/api/cortex/directives?repoPath=${encodeURIComponent(repoPath)}`
          : '/api/cortex/directives';
        const response = await fetch(url, { cache: 'no-store' });
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
  }, [directiveRefreshTick, repoPath]);

  // #840 — Re-fetch directives when the server broadcasts a directive write.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        data?: { scope?: string };
      } | undefined;
      const scope = detail?.data?.scope;
      if (scope === 'directive' || !scope) {
        setDirectiveRefreshTick((tick) => tick + 1);
      }
    };
    window.addEventListener('o8:cortex-changes', handler);
    return () => window.removeEventListener('o8:cortex-changes', handler);
  }, []);

  // Load the same lane diff the merge gate / o8_packet_diff path uses: branch
  // work vs refreshed base. Do not show the unrelated local working tree here.
  useEffect(() => {
    if (!laneId) {
      setDiff(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    (async () => {
      try {
        const response = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/diff?maxBytes=524288`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json() as {
          ok?: boolean;
          note?: string;
          diff?: string;
          base?: string | null;
        };
        if (cancelled) return;
        if (!payload.ok) {
          throw new Error(payload.note ?? 'Unable to load lane diff.');
        }
        const diffText = payload.diff ?? '';
        const summary = summarizeLaneReviewDiff(diffText);
        setDiff({
          diff: diffText,
          additions: summary.additions,
          deletions: summary.deletions,
          fileCount: summary.files.length,
          baseBranch: payload.base ?? baseBranchHint,
          sourceLabel: payload.base ? `Branch diff vs ${payload.base}` : 'Branch diff vs base',
        });
      } catch (error) {
        if (cancelled) return;
        setDiffError(error instanceof Error ? error.message : 'Unable to load diff.');
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [laneId, baseBranchHint, packet.id]);

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
      <div style={{ flex: 1, minWidth: 0, borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: PANE_BORDER_COLOR, display: 'flex', flexDirection: 'column' }}>
        {hasExplainer ? (
          <div style={{ display: 'flex', gap: 4, padding: 8, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: PANE_BORDER_COLOR }}>
            {(['explainer', 'diff'] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setMiddleView(view)}
                style={{
                  paddingTop: 3,
                  paddingBottom: 3,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: middleView === view ? 'var(--t-accent)' : 'var(--t-divider)',
                  background: middleView === view ? 'var(--t-input-bg, var(--t-panel))' : 'transparent',
                  color: middleView === view ? 'var(--t-text)' : 'var(--t-text-muted)',
                  fontSize: 10.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {view === 'explainer' ? 'Explainer' : 'Diff'}
              </button>
            ))}
          </div>
        ) : null}
        {hasExplainer && middleView === 'explainer' ? (
          <PacketExplainerPane packet={packet} />
        ) : (
          <DiffPane packet={packet} reviewState={reviewState} diff={diff} diffLoading={diffLoading} diffError={diffError} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ReviewPane packet={packet} onActionComplete={onActionComplete} />
      </div>
    </div>
  );
}
