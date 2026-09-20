import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/operator/defaults', () => ({ resolveReviewContinuationSync: () => false }));
vi.mock('@/lib/orchestrator/wake-triage', () => ({ startWakeTriage: vi.fn() }));

const { routeReviewContinuation } = await import('./review-continuation');

describe('persistent lead review routing', () => {
  it('returns a bound worker to its lead even when generic review continuation is disabled', () => {
    const enqueue = vi.fn();
    const enqueuePersistentLead = vi.fn(() => true);
    routeReviewContinuation({
      id: 'lane-1',
      label: 'Worker',
      repoPath: '/repo',
      packetId: 'packet-1',
    }, enqueue, enqueuePersistentLead);
    expect(enqueuePersistentLead).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
