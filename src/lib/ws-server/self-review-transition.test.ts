import { describe, expect, it } from 'vitest';

import { createLane, getLane, getLaneEvents, updateLane } from '@/lib/lane/registry';
import { recordSelfReviewInterruptFailure } from './self-review-transition';

describe('self-review transition interrupt truth', () => {
  it('records the failed stop without changing the live lane or its session binding', () => {
    const lane = createLane({
      repoPath: '/tmp/self-review-interrupt',
      branch: 'packet/self-review-interrupt',
      runtime: 'codex',
      sessionKey: 'codex-owned:self-review-interrupt',
    });
    updateLane(lane.id, { status: 'running' }, 'system');

    expect(recordSelfReviewInterruptFailure({
      laneId: lane.id,
      surfaceId: 'codex-owned:self-review-interrupt',
      error: new Error('kill was not confirmed'),
    })).toBe('kill was not confirmed');

    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      sessionKey: 'codex-owned:self-review-interrupt',
    });
    expect(getLaneEvents(lane.id)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        event: 'self_review_stall_interrupt_failed',
        reason: 'kill was not confirmed',
      }),
    }));
  });
});
