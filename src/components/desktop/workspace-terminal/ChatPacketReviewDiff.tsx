'use client';

/**
 * #1293 FIX 2 — inline, collapsible diff for a dispatched packet sitting at
 * `awaiting_review` inside its workspace chat tab. "Ready for review" otherwise
 * says nothing about WHAT to review; this surfaces the change set inline without
 * bouncing to the Activity panel.
 *
 * Reuses the SAME `/api/worktrees/diff` endpoint + `DiffPane` component the
 * PacketReviewCard uses — no new diff primitives.
 */

import { useEffect, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { DiffPane } from '@/components/desktop/thoughts/mission-panel/review-card/DiffPane';
import type { DiffPayload } from '@/components/desktop/thoughts/mission-panel/review-card/shared';

export function ChatPacketReviewDiff({ packet }: { packet: OrchestratorPacket }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const worktreePath = packet.lane?.worktreePath ?? null;
  const baseBranchHint = packet.branchTarget && packet.branchTarget.trim() ? packet.branchTarget : null;

  // Load the diff lazily — only once the operator expands it (cheap "Ready for
  // review" until asked). Mirrors PacketReviewCard's diff effect.
  useEffect(() => {
    if (!open || !worktreePath) return undefined;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    (async () => {
      try {
        const params = new URLSearchParams({ worktreePath });
        if (baseBranchHint) params.set('baseBranch', baseBranchHint);
        const response = await fetch(`/api/worktrees/diff?${params.toString()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
  }, [open, worktreePath, baseBranchHint, packet.id]);

  if (!worktreePath) return null;

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
