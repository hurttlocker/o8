'use client';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export function hasWorkerReviewAction(packet: Pick<OrchestratorPacket, 'status' | 'blockedReason'> | null | undefined) {
  return packet?.status === 'awaiting_review'
    || (packet?.status === 'blocked' && packet.blockedReason === 'Awaiting operator input');
}

export function WorkerReviewAction({ packet, onOpenReview }: {
  packet: Pick<OrchestratorPacket, 'status' | 'blockedReason' | 'title'> | null | undefined;
  onOpenReview?: () => void;
}) {
  if (!hasWorkerReviewAction(packet) || !onOpenReview) return null;
  return (
    <button
      type="button"
      data-worker-open-review
      aria-label={`Review merge for ${packet?.title || 'this chat'}`}
      title="Review changes and merge checks"
      onClick={(event) => { event.stopPropagation(); onOpenReview(); }}
      style={{ width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: 0, borderRadius: 8, background: 'var(--t-hover)', color: 'var(--t-accent)', cursor: 'pointer' }}
    >
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" />
        <path d="M6 7v10M18 7v2a6 6 0 0 1-6 6H6" />
      </svg>
    </button>
  );
}
