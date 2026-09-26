'use client';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

interface WorkerPaneSummaryProps {
  packet: OrchestratorPacket | null | undefined;
  onOpenReview?: () => void;
  onReply?: () => void;
}

function attentionFor(packet: OrchestratorPacket) {
  if (packet.status === 'awaiting_review') return { title: 'Review the finished work', action: 'review' as const };
  if (packet.status === 'blocked' && packet.blockedReason === 'Awaiting operator input') return { title: 'Review needs your decision', action: 'review' as const };
  if (packet.status === 'blocked' && packet.blockedReason === 'worker_question') return { title: 'Worker asked for direction', action: 'reply' as const };
  if (packet.status === 'blocked' && packet.blockedReason === 'huddle_ready') return { title: 'Plan ready for direction', action: 'reply' as const };
  return null;
}

/** Compact, evidence-backed next step beside the worker's live transcript. */
export function WorkerPaneSummary({ packet, onOpenReview, onReply }: WorkerPaneSummaryProps) {
  if (!packet) return null;
  const attention = attentionFor(packet);
  const summary = packet.completionSummary?.trim() || packet.review?.summary?.trim() || null;
  const fileCount = packet.explainer?.changedFileCount;
  const fileLabel = typeof fileCount === 'number' && Number.isFinite(fileCount)
    ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
    : null;
  if (!attention && !summary && !fileLabel) return null;
  const action = attention?.action === 'review' && onOpenReview
    ? { label: 'Open review', run: onOpenReview }
    : attention?.action === 'reply' && onReply
      ? { label: 'Reply', run: onReply }
      : summary && onOpenReview
        ? { label: 'Open review', run: onOpenReview }
        : null;

  return (
    <div data-worker-attention={attention ? 'true' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle, var(--t-border))', background: 'var(--t-bg-card)', color: 'var(--t-text)', flexShrink: 0 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        {attention ? <div style={{ fontSize: 11, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attention.title}</div> : null}
        {summary || fileLabel ? <div data-worker-outcome title={summary ?? undefined} style={{ color: 'var(--t-text-secondary)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[fileLabel, summary].filter(Boolean).join(' · ')}</div> : null}
      </div>
      {action ? <button type="button" data-worker-open-review={attention?.action === 'review' || !attention ? 'true' : undefined} onClick={action.run} style={{ border: 0, background: 'transparent', color: 'var(--t-accent)', fontSize: 10.5, fontWeight: 500, whiteSpace: 'nowrap', cursor: 'pointer' }}>{action.label}</button> : null}
    </div>
  );
}
