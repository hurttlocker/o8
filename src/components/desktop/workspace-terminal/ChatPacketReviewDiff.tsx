'use client';

/**
 * #1293 FIX 2 — inline, collapsible diff for a dispatched packet sitting at
 * `awaiting_review` inside its workspace chat tab. "Ready for review" otherwise
 * says nothing about WHAT to review; this surfaces the change set inline without
 * bouncing to the Activity panel.
 *
 * Reuses the SAME lane diff endpoint + `DiffPane` component the
 * PacketReviewCard uses so review surfaces stay branch-vs-base aligned.
 */

import { useEffect, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { summarizeLaneReviewDiff } from '@/lib/review/lane-diff';
import { DiffPane } from '@/components/desktop/thoughts/mission-panel/review-card/DiffPane';
import type { DiffPayload } from '@/components/desktop/thoughts/mission-panel/review-card/shared';

export function ChatPacketReviewDiff({ packet }: { packet: OrchestratorPacket }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const laneId = packet.lane?.laneId ?? null;
  const baseBranchHint = packet.branchTarget && packet.branchTarget.trim() ? packet.branchTarget : null;

  // Load the diff lazily — only once the operator expands it (cheap "Ready for
  // review" until asked). Mirrors PacketReviewCard's diff effect.
  useEffect(() => {
    if (!open || !laneId) return undefined;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    (async () => {
      try {
        const response = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/diff?maxBytes=524288`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { ok?: boolean; note?: string; diff?: string; base?: string | null };
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
  }, [open, laneId, baseBranchHint, packet.id]);

  if (!laneId) return null;

  return (
    <div style={{ width: '100%', maxWidth: 440, marginLeft: 'auto', marginRight: 'auto' }}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 999,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-border)',
          background: 'var(--t-panel)',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 500,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {open ? 'Hide diff' : 'Review diff'}
      </button>
      {open ? (
        <div
          style={{
            marginTop: 8,
            borderRadius: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-panel-border)',
            background: 'var(--t-panel)',
            overflow: 'hidden',
          }}
        >
          <DiffPane packet={packet} reviewState={null} diff={diff} diffLoading={diffLoading} diffError={diffError} />
        </div>
      ) : null}
    </div>
  );
}
