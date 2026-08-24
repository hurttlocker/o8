/**
 * Real-path regressions for #1856 — the two silent-park review transitions.
 *
 * Both drive the PRODUCTION queue/drain path (`drainReviewQueue`) and the
 * production reconciler (`reconcileReviewStalls`) against persisted rows, not
 * the guards in isolation:
 *
 *   1. A second pass that agreed must leave a durable merge-attempt receipt,
 *      and a missed dispatch must be recovered on the way in.
 *   2. Cancelling one review must not suppress a successor review on the same
 *      lane, and every claimed queue row must end with a turn receipt or an
 *      explicit skip/failure receipt.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mergeResult: { ok: true, laneId: '', note: 'merged' } as {
    ok: boolean;
    laneId: string;
    note: string;
    approvalId?: string;
  },
  dispatch: vi.fn(),
  reviewerCalls: [] as Array<{ laneId: string; threadId: string; surface: string }>,
}));

vi.mock('@/lib/lane/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/commands')>();
  h.dispatch.mockImplementation(async (command: { laneId: string }) => ({
    ...h.mergeResult,
    laneId: command.laneId,
  }));
  return { ...actual, dispatch: h.dispatch };
});

vi.mock('@/lib/lane/review-quota-fallback', async () => {
  const { finishReviewTurn, startReviewTurn } = await import('@/lib/lane/review-turn-state');
  return {
    runReviewerTurnWithQuotaFallback: vi.fn(async (input: {
      laneId: string;
      threadId: string;
      surface: string;
      backend?: string;
    }) => {
      h.reviewerCalls.push({
        laneId: input.laneId,
        threadId: input.threadId,
        surface: input.surface,
      });
      const reviewTurnId = startReviewTurn({
        laneId: input.laneId,
        threadId: input.threadId,
        backend: 'claude',
        surface: input.surface,
      });
      finishReviewTurn({ laneId: input.laneId, reviewTurnId, outcome: 'completed' });
      return {
        ok: true,
        backend: 'claude' as const,
        text: 'Reviewed. No blocking findings.',
        errors: [] as string[],
        fallback: null,
        reviewTurnId,
      };
    }),
  };
});

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-review-stall-data-'));
const repoDirs: string[] = [];
writeFileSync(join(dataDir, 'ws-token'), 'review-stall-ws-token-0123456789ab\n', 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const { getApproval, markSecondPassAgreed } = await import('@/lib/approvals/store');
const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const { cancelAutoReviewForLane, isReviewAttemptCancelled } = await import('@/lib/lane/review-cancellation');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { enqueueLaneReview } = await import('@/lib/lane/review-queue');
const { reconcileReviewStalls } = await import('@/lib/lane/review-stall-reconcile');
const { rearmPendingSecondPassApproval } = await import('@/lib/lane/blind-second-pass-review');
const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service/review');

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  const absolutePath = join(repoDir, path);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
  git(repoDir, ['add', '--', path]);
  git(repoDir, ['commit', '-q', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function createRepo(): string {
  const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-review-stall-repo-'));
  repoDirs.push(repoDir);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  commitFile(repoDir, 'README.md', 'fixture\n', 'base');
  return repoDir;
}

/**
 * The high-risk classifier keys on `db` paths, so a review on this file is the
 * shape that requires a blind second pass — the state the defect parks in.
 */
function commitHighRiskChange(repoDir: string, slug: string): string {
  return commitFile(
    repoDir,
    `src/lib/db/${slug}-fixture.ts`,
    `export const ${slug.replace(/-/g, '')}Fixture = true;\n`,
    'high-risk change',
  );
}

function laneEventVerbs(laneId: string): string[] {
  return getLaneEvents(laneId, 200).map((event) => event.verb);
}

function eventsWithVerb(laneId: string, verb: string) {
  return getLaneEvents(laneId, 200).filter((event) => event.verb === verb);
}

/**
 * The drain claims the globally-oldest pending row per tick, so a test that
 * wants a specific row processed must tick until that row settles. Bounded,
 * and it is still the production drain doing the claiming.
 */
async function drainUntilSettled(reviewId: string, maxTicks = 8): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const row = getSqlite().prepare(
      'SELECT status FROM review_queue WHERE id = ?',
    ).get(reviewId) as { status: string } | undefined;
    if (row && row.status !== 'pending' && row.status !== 'in_progress') return;
    await drainReviewQueue();
  }
}

function queueRows(laneId: string) {
  return getSqlite().prepare(
    'SELECT id, status, attempts, last_error FROM review_queue WHERE lane_id = ? ORDER BY created_at ASC',
  ).all(laneId) as Array<{ id: string; status: string; attempts: number; last_error: string | null }>;
}

/**
 * The ledger invariant from the root-cause addendum: a claimed row may never
 * reach `completed` with attempts=0 / last_error=NULL and no event behind it.
 * A turn receipt is linked by the review id embedded in the turn thread id.
 */
function assertEveryTerminalRowCarriesAReceipt(laneId: string): void {
  const turnThreadIds = eventsWithVerb(laneId, 'review_turn_started')
    .map((event) => String(event.payload.threadId ?? ''));
  const skipReviewIds = new Set(
    eventsWithVerb(laneId, 'review_skipped').map((event) => String(event.payload.reviewId ?? '')),
  );

  for (const row of queueRows(laneId)) {
    if (row.status !== 'completed' && row.status !== 'failed') continue;
    const hasTurn = turnThreadIds.some((threadId) => threadId.includes(row.id));
    const hasExplicitReceipt = skipReviewIds.has(row.id) || Boolean(row.last_error);
    expect(
      hasTurn || hasExplicitReceipt,
      `review_queue row ${row.id} ended '${row.status}' with no turn receipt and no skip/failure receipt`,
    ).toBe(true);
  }
}

async function approveHighRiskHead(input: {
  packetId: string;
  laneId: string;
  headSha: string;
}): Promise<string> {
  const review = await submitPacketReview({
    packetId: input.packetId,
    findings: [],
    approved: true,
    reviewedHeadSha: input.headSha,
  });
  const approvalId = review.auditApprovalId;
  if (!approvalId) throw new Error('review did not persist an approval receipt');
  expect(getApproval(approvalId)?.args?.requiresSecondPass).toBe(true);
  return approvalId;
}

beforeEach(() => {
  h.reviewerCalls.length = 0;
  h.mergeResult = { ok: true, laneId: '', note: 'merged' };
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  for (const repoDir of repoDirs) rmSync(repoDir, { recursive: true, force: true });
});

describe('missed merge dispatch after second-pass agreement (#1856)', () => {
  it('recovers an authorized current HEAD whose merge was never dispatched, through the drain', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/missed-merge']);
    const packetId = 'pkt-missed-merge';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/missed-merge',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'missed merge fixture',
      packetId,
      sessionKey: 'test-runtime:missed-merge',
    });
    const headSha = commitHighRiskChange(repoDir, 'missed-merge');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });

    // The exact observed state: agreement persisted, the dispatch on the next
    // line left no trace at all.
    markSecondPassAgreed(approvalId);
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'completed', updated_at = datetime('now') WHERE lane_id = ?",
    ).run(lane.id);

    const authorized = await assessDurableApprovedReview(getLane(lane.id)!);
    expect(authorized.approved).toBe(true);
    expect(authorized.approvalId).toBe(approvalId);
    expect(laneEventVerbs(lane.id)).not.toContain('merge');
    expect(laneEventVerbs(lane.id)).not.toContain('merge_dispatch_attempted');

    // Production drain tick — reconciliation runs on the way in.
    await drainReviewQueue();

    const attempts = eventsWithVerb(lane.id, 'merge_dispatch_attempted');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.payload).toMatchObject({
      approvalId,
      reviewedHeadSha: headSha,
      trigger: 'stall_reconcile',
    });
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'merge', laneId: lane.id }),
    );
    expect(eventsWithVerb(lane.id, 'merge_dispatch_failed')).toHaveLength(0);

    // Idempotent: the recorded attempt is the guard, so a second reconcile
    // must not re-dispatch the same authorization.
    h.dispatch.mockClear();
    await reconcileReviewStalls();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
  });

  it('leaves a durable failure receipt when the recovered dispatch does not merge', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/failed-merge']);
    const packetId = 'pkt-failed-merge';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/failed-merge',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'failed merge fixture',
      packetId,
      sessionKey: 'test-runtime:failed-merge',
    });
    const headSha = commitHighRiskChange(repoDir, 'failed-merge');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    markSecondPassAgreed(approvalId);
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'completed', updated_at = datetime('now') WHERE lane_id = ?",
    ).run(lane.id);

    h.mergeResult = { ok: false, laneId: lane.id, note: 'rebase conflict on main' };
    await reconcileReviewStalls();

    expect(eventsWithVerb(lane.id, 'merge_dispatch_attempted')).toHaveLength(1);
    const failures = eventsWithVerb(lane.id, 'merge_dispatch_failed');
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.payload.reason)).toContain('rebase conflict on main');
    // Nothing parks silently: the lane leaves the live-looking reviewing state
    // and carries an operator-actionable blocker.
    expect(eventsWithVerb(lane.id, 'review_queue_blocked')).toHaveLength(1);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
  });
});

describe('stale review cancellation must not suppress a successor (#1856)', () => {
  it('runs a successor review on a lane whose earlier review was cancelled', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/cancelled-successor']);
    const packetId = 'pkt-cancelled-successor';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/cancelled-successor',
      baseBranch: 'main',
      runtime: 'claude-code',
      label: 'cancelled successor fixture',
      packetId,
      sessionKey: 'test-runtime:cancelled-successor',
    });
    commitHighRiskChange(repoDir, 'cancelled-successor');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    // Attempt 1 is claimed, then cancelled mid-flight.
    const first = enqueueLaneReview(getLane(lane.id)!);
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'in_progress' WHERE id = ?",
    ).run(first.reviewId);
    cancelAutoReviewForLane(lane.id, 'merged_by_ancestry');
    expect(isReviewAttemptCancelled(first.reviewId)).toBe(true);

    // A later current-HEAD approval re-arms a successor on the SAME lane.
    const headSha = git(repoDir, ['rev-parse', 'HEAD']);
    const approvalId = await approveHighRiskHead({ packetId, laneId: lane.id, headSha });
    const rearmed = await rearmPendingSecondPassApproval(getLane(lane.id)!, {
      approvalId,
      reviewedHeadSha: headSha,
    });
    expect(rearmed.scheduled).toBe(true);

    const successor = queueRows(lane.id).find((row) => row.status === 'pending');
    expect(successor, 'the successor review row should be pending').toBeDefined();
    expect(isReviewAttemptCancelled(successor!.id)).toBe(false);

    // Production drain — the successor must actually start.
    await drainUntilSettled(successor!.id);

    expect(h.reviewerCalls.some((call) => call.threadId.includes(successor!.id))).toBe(true);
    const started = eventsWithVerb(lane.id, 'review_turn_started');
    expect(started.length).toBeGreaterThan(0);
    expect(started.some((event) => String(event.payload.threadId ?? '').includes(successor!.id))).toBe(true);

    // And no row anywhere on this lane ended terminal without a receipt.
    assertEveryTerminalRowCarriesAReceipt(lane.id);
  });

  it('persists an explicit skip receipt when a claimed review never runs its turn', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/skipped-receipt']);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/skipped-receipt',
      baseBranch: 'main',
      runtime: 'claude-code',
      label: 'skipped receipt fixture',
      packetId: 'pkt-skipped-receipt',
      sessionKey: 'test-runtime:skipped-receipt',
    });
    commitHighRiskChange(repoDir, 'skipped-receipt');
    // Not reviewing — performAutoReview cannot run a turn for this row.
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'approval_required');
    const queued = enqueueLaneReview(getLane(lane.id)!);

    await drainUntilSettled(queued.reviewId);

    const row = queueRows(lane.id).find((candidate) => candidate.id === queued.reviewId);
    expect(row?.status).toBe('completed');
    expect(row?.last_error).toContain('Skipped:');
    const skips = eventsWithVerb(lane.id, 'review_skipped');
    expect(skips).toHaveLength(1);
    expect(String(skips[0]!.payload.reason)).toContain('no longer reviewing');
    expect(h.reviewerCalls).toHaveLength(0);
    assertEveryTerminalRowCarriesAReceipt(lane.id);
  });
});
