/**
 * Review-ready notification coalescing (#2150).
 *
 * Two levels, deliberately:
 *
 *  1. The coalescer itself, on a manual clock — N flips inside the window
 *     produce ONE notification carrying the count; a flip after the window opens
 *     a new one.
 *  2. The REAL path — `publishLaneLifecycleEvent`, the chokepoint every dispatch
 *     route reaches on its way to `reviewing`. Testing only the coalescer would
 *     be the "green tests encode the premise" trap: the batching works, but
 *     nothing reaches it. The real-path case drives three lane flips through the
 *     actual lifecycle publisher and asserts one push went out.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-review-coalesce-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const notifyAllInBackground = vi.hoisted(() => vi.fn());
vi.mock('@/lib/push/notify', () => ({
  notifyAllInBackground,
  notifyReviewReady: vi.fn(),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/orchestrator/runtime-status', () => ({ recordLaneEvent: vi.fn() }));

const {
  composeReviewReadyNotification,
  createReviewReadyCoalescer,
  REVIEW_READY_COALESCE_WINDOW_MS,
} = await import('@/lib/push/review-ready-coalescer');
const { publishLaneLifecycleEvent } = await import('@/lib/lane/lifecycle');

/** A manual clock, so the test asserts the window rather than waiting it out. */
function manualScheduler() {
  const queue: Array<{ run: () => void; at: number }> = [];
  let clock = 0;
  return {
    schedule: (run: () => void, ms: number) => { queue.push({ run, at: clock + ms }); },
    advance(ms: number) {
      clock += ms;
      const due = queue.filter((entry) => entry.at <= clock);
      for (const entry of due) queue.splice(queue.indexOf(entry), 1);
      for (const entry of due) entry.run();
    },
  };
}

function lane(id: string, status: string) {
  return {
    id,
    packetId: `packet-${id}`,
    status: status as 'reviewing',
    sessionKey: `session-${id}`,
    branch: `issue/${id}`,
    repoPath: '/tmp/repo',
    runtime: 'codex' as const,
    label: `Lane ${id}`,
  };
}

describe('review-ready coalescing', () => {
  beforeEach(() => { notifyAllInBackground.mockClear(); });

  it('collapses every flip inside the window into one notification with the count', () => {
    const clock = manualScheduler();
    const delivered: Array<{ title: string; count: number }> = [];
    const coalescer = createReviewReadyCoalescer({
      schedule: clock.schedule,
      deliver: (notification) => { delivered.push(notification); },
      shouldDeliver: () => true,
    });

    coalescer.enqueue({ laneId: 'a', label: 'Fix the parser' });
    clock.advance(500);
    coalescer.enqueue({ laneId: 'b', label: 'Rename the column' });
    clock.advance(500);
    coalescer.enqueue({ laneId: 'c', label: 'Drop the dead route' });

    expect(delivered).toHaveLength(0);
    clock.advance(REVIEW_READY_COALESCE_WINDOW_MS);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ title: '3 packets ready for review', count: 3 });
  });

  it('opens a fresh notification for a flip that arrives after the window closed', () => {
    const clock = manualScheduler();
    const delivered: Array<{ title: string; count: number }> = [];
    const coalescer = createReviewReadyCoalescer({
      schedule: clock.schedule,
      deliver: (notification) => { delivered.push(notification); },
      shouldDeliver: () => true,
    });

    coalescer.enqueue({ laneId: 'a', label: 'Fix the parser' });
    clock.advance(REVIEW_READY_COALESCE_WINDOW_MS);
    coalescer.enqueue({ laneId: 'b', label: 'Rename the column' });
    clock.advance(REVIEW_READY_COALESCE_WINDOW_MS);

    expect(delivered).toHaveLength(2);
    // A lone packet keeps the exact wording the uncoalesced path used.
    expect(delivered[0]).toMatchObject({ title: 'Ready for review', count: 1 });
    expect(delivered[1]).toMatchObject({ title: 'Ready for review', count: 1 });
  });

  it('counts a lane once even if it re-enters reviewing inside the window', () => {
    const clock = manualScheduler();
    const delivered: Array<{ count: number }> = [];
    const coalescer = createReviewReadyCoalescer({
      schedule: clock.schedule,
      deliver: (notification) => { delivered.push(notification); },
      shouldDeliver: () => true,
    });

    coalescer.enqueue({ laneId: 'a', label: 'Fix the parser' });
    coalescer.enqueue({ laneId: 'a', label: 'Fix the parser' });
    clock.advance(REVIEW_READY_COALESCE_WINDOW_MS);

    expect(delivered).toEqual([expect.objectContaining({ count: 1 })]);
  });

  it('drops the batch when the gate is closed, and reads the gate at flush time', () => {
    const clock = manualScheduler();
    const delivered: unknown[] = [];
    let gateOpen = true;
    const coalescer = createReviewReadyCoalescer({
      schedule: clock.schedule,
      deliver: (notification) => { delivered.push(notification); },
      shouldDeliver: () => gateOpen,
    });

    coalescer.enqueue({ laneId: 'a', label: 'Fix the parser' });
    // The operator turns quiet mode on while the window is still open.
    gateOpen = false;
    clock.advance(REVIEW_READY_COALESCE_WINDOW_MS);
    expect(delivered).toHaveLength(0);

    gateOpen = true;
    coalescer.enqueue({ laneId: 'b', label: 'Rename the column' });
    clock.advance(REVIEW_READY_COALESCE_WINDOW_MS);
    expect(delivered).toHaveLength(1);
  });

  it('names the packets it batched', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ laneId: id, label: `Lane ${id}` }));
    expect(composeReviewReadyNotification(many)).toMatchObject({
      title: '5 packets ready for review',
      body: 'Lane a, Lane b, Lane c and 2 more',
      tag: 'review-ready-batch',
    });
    expect(composeReviewReadyNotification([])).toBeNull();
  });

  it('REAL PATH: three lanes flipping through publishLaneLifecycleEvent raise one push', async () => {
    vi.useFakeTimers();
    try {
      const at = new Date().toISOString();
      for (const id of ['x', 'y', 'z']) {
        publishLaneLifecycleEvent(lane(id, 'reviewing'), 'running', at);
      }
      expect(notifyAllInBackground).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(REVIEW_READY_COALESCE_WINDOW_MS + 10);

      expect(notifyAllInBackground).toHaveBeenCalledTimes(1);
      expect(notifyAllInBackground.mock.calls[0][0]).toMatchObject({
        title: '3 packets ready for review',
        tag: 'review-ready-batch',
        data: expect.objectContaining({ count: 3, laneIds: ['x', 'y', 'z'] }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('REAL PATH: a lane that does not reach reviewing never enqueues', async () => {
    vi.useFakeTimers();
    try {
      const at = new Date().toISOString();
      publishLaneLifecycleEvent(lane('w', 'running'), 'launching', at);
      await vi.advanceTimersByTimeAsync(REVIEW_READY_COALESCE_WINDOW_MS + 10);
      expect(notifyAllInBackground).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
