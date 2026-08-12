import { appendEvent } from '@/lib/lane/registry';

export function recordSelfReviewInterruptFailure(input: {
  laneId: string;
  surfaceId: string;
  error: unknown;
}): string {
  const reason = input.error instanceof Error ? input.error.message : String(input.error);
  appendEvent(input.laneId, 'update', 'system', {
    event: 'self_review_stall_interrupt_failed',
    surfaceId: input.surfaceId,
    reason,
  });
  return reason;
}
