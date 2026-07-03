import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLane, getLane, getLaneEvents, setLaneStatus } from '@/lib/lane/registry';
import { invalidateReviewingLaneForWorkerActivity } from './review-invalidation';

let tempWorktree: string | null = null;

afterEach(() => {
  if (tempWorktree) rmSync(tempWorktree, { recursive: true, force: true });
  tempWorktree = null;
});

describe('review invalidation on resumed worker activity', () => {
  it('moves a reviewing Codex lane back to running when transcript progress arrives', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'o8-review-invalidated-'));
    tempWorktree = worktreePath;
    const surfaceId = 'codex-owned:review-invalidated';
    const lane = createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/review-invalidated',
      runtime: 'codex',
      sessionKey: surfaceId,
      packetId: 'pkt-review-invalidated',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'silent_exit_work_present');

    const changed = await invalidateReviewingLaneForWorkerActivity({
      surfaceId,
      source: 'transcript_progress',
      lastMessage: 'still working',
    });

    expect(changed).toBe(true);
    const after = getLane(lane.id);
    expect(after?.status).toBe('running');
    expect(after?.lastEventLabel).toBe('review_invalidated');
    const event = getLaneEvents(lane.id).find((candidate) => candidate.verb === 'review_invalidated');
    expect(event?.payload.reason).toBe('worker_activity_after_review');
    expect(event?.payload.source).toBe('transcript_progress');
    expect(event?.payload.lastMessageLength).toBe('still working'.length);
  });
});
