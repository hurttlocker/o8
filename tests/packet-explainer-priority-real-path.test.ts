import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-explainer-priority-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { enqueueLaneReview } = await import('@/lib/lane/review-queue');
const { claimNextReview } = await import('@/lib/lane/review-drain-recovery');
const { markReviewCompleted } = await import('@/lib/lane/review-queue-settlement');
const {
  drainPacketExplainerQueue,
  enqueuePacketExplainer,
} = await import('@/lib/lane/packet-explainer-queue');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');

beforeAll(async () => {
  await updateOperatorDefaults({ packetExplainerEnabled: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('packet explainer correctness priority', () => {
  it('preempts a long explainer so a successor review can claim and settle', async () => {
    const lane = createLane({
      label: 'Explainer priority fixture',
      repoPath: dataDir,
      branch: 'inline/explainer-priority',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'packet-explainer-priority',
    });
    const explainerId = await enqueuePacketExplainer({
      lane,
      packetId: lane.packetId!,
      packetTitle: lane.label,
      packetSummary: 'fixture',
      diffSummary: 'fixture diff',
      changedFileCount: 1,
      deviationsRaw: null,
      reviewContext: '',
    });
    expect(explainerId).toBeTruthy();

    let abortObserved = false;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const longExplainer = drainPacketExplainerQueue(async (params) => {
      signalStarted();
      await new Promise<void>((resolve) => params.signal?.addEventListener('abort', () => {
        abortObserved = true;
        resolve();
      }, { once: true }));
      return {
        outcome: 'deferred',
        backend: 'codex',
        durationMs: 250,
        approximateCost: 0.02,
        reason: 'correctness review took priority',
      };
    });
    await started;

    const review = enqueueLaneReview(lane, { headSha: 'a'.repeat(40) });
    expect(review.queued).toBe(true);
    await longExplainer;
    expect(abortObserved).toBe(true);

    const deferred = getSqlite().prepare(
      'SELECT status, attempts, contention_count, outcome FROM explainer_queue WHERE id = ?',
    ).get(explainerId) as Record<string, unknown>;
    expect(deferred).toMatchObject({
      status: 'pending',
      attempts: 0,
      contention_count: 1,
      outcome: 'deferred',
    });

    const claimedReview = claimNextReview();
    expect(claimedReview?.id).toBe(review.reviewId);
    expect(markReviewCompleted({
      reviewId: claimedReview!.id,
      claimOwner: claimedReview!.claim_owner,
    })).toBe(true);
    expect(getSqlite().prepare(
      'SELECT status, attempts FROM review_queue WHERE id = ?',
    ).get(review.reviewId)).toMatchObject({ status: 'completed', attempts: 0 });

    await drainPacketExplainerQueue(async () => ({
      outcome: 'ready',
      backend: 'codex',
      durationMs: 100,
      approximateCost: 0.01,
    }));
    expect(getSqlite().prepare(
      'SELECT status, outcome, contention_count FROM explainer_queue WHERE id = ?',
    ).get(explainerId)).toMatchObject({
      status: 'completed',
      outcome: 'ready',
      contention_count: 1,
    });
  });

  it('releases a thrown explainer claim for a bounded retry', async () => {
    const lane = createLane({
      label: 'Explainer crash fixture',
      repoPath: dataDir,
      branch: 'inline/explainer-crash',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'packet-explainer-crash',
    });
    const laneStatusBefore = getLane(lane.id)?.status;
    await enqueuePacketExplainer({
      lane,
      packetId: lane.packetId!,
      packetTitle: lane.label,
      packetSummary: 'fixture',
      diffSummary: 'fixture diff',
      changedFileCount: 1,
      deviationsRaw: null,
      reviewContext: '',
    });

    await drainPacketExplainerQueue(async () => {
      throw new Error('synthetic explainer crash');
    });

    expect(getSqlite().prepare(
      'SELECT status, attempts, outcome, last_error FROM explainer_queue WHERE packet_id = ?',
    ).get(lane.packetId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      outcome: 'retrying',
      last_error: 'synthetic explainer crash',
    });
    expect(getLane(lane.id)?.status).toBe(laneStatusBefore);
  });
});
