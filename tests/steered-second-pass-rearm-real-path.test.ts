import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  perform: vi.fn(async () => ({ ok: true, status: 'sent', note: 'steered' })),
}));

vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return { ...actual, performRuntimeAction: h.perform };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-steered-second-pass-data-'));
const repoDirs: string[] = [];
const operatorToken = 'operator-steered-second-pass-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { markSecondPassAgreed } = await import('@/lib/approvals/store');
const {
  findPendingSecondPassApproval,
  rearmPendingSecondPassApproval,
} = await import('@/lib/lane/blind-second-pass-review');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');

function createRepo(): string {
  const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-steered-second-pass-repo-'));
  repoDirs.push(repoDir);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  commitFile(repoDir, 'README.md', 'fixture\n', 'base');
  return repoDir;
}

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

function steerRequest(packetId: string, idempotencyKey: string) {
  return new NextRequest('http://localhost:3001/api/orchestrator/steer-packet', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      packetId,
      message: 'Address the review feedback and commit the repair.',
      idempotencyKey,
    }),
  });
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  for (const repoDir of repoDirs) rmSync(repoDir, { recursive: true, force: true });
});

describe('steered packet second-pass scheduling through persisted paths', () => {
  it('re-arms blind review when submit_review approves the steered HEAD', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/steered-second-pass']);

    const packetId = 'pkt-steered-second-pass';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/steered-second-pass',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'steered second-pass fixture',
      packetId,
      sessionKey: 'test-runtime:steered-second-pass',
    });

    const oldHead = commitFile(repoDir, 'docs/first-pass.md', 'first review\n', 'first pass');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    await submitPacketReview({
      packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: oldHead,
    });
    expect(getSqlite().prepare(
      "SELECT id FROM review_queue WHERE lane_id = ? AND status IN ('pending', 'in_progress')",
    ).get(lane.id)).toBeUndefined();

    const steerResponse = await steerRoute.POST(steerRequest(packetId, 'steered-second-pass-rearm'));
    expect(steerResponse.status).toBe(200);
    expect(h.perform).toHaveBeenCalledOnce();
    expect(getLane(lane.id)?.status).toBe('running');

    const steeredHead = commitFile(
      repoDir,
      'src/lib/db/steered-second-pass-fixture.ts',
      'export const steeredSecondPassFixture = true;\n',
      'steered repair',
    );
    expect(steeredHead).not.toBe(oldHead);
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const firstReview = await submitPacketReview({
      packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: steeredHead,
    });
    expect(firstReview.reviewedHeadSha).toBe(steeredHead);

    const futureTimestamp = Date.now() + 60_000;
    getSqlite().prepare(
      'UPDATE approvals SET updated_at = ?, resolved_at = ? WHERE id = ?',
    ).run(futureTimestamp, futureTimestamp, firstReview.auditApprovalId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const latestReview = await submitPacketReview({
      packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: steeredHead,
    });
    const latestApprovalId = latestReview.auditApprovalId;
    if (!latestApprovalId) throw new Error('latest review did not persist an approval receipt');

    const refreshedLane = getLane(lane.id)!;
    const pendingSecondPass = await findPendingSecondPassApproval(refreshedLane);
    expect(pendingSecondPass?.approval.id).toBe(latestApprovalId);
    expect(pendingSecondPass?.reviewedHeadSha).toBe(steeredHead);
    expect(getSqlite().prepare(
      "SELECT status FROM review_queue WHERE lane_id = ? AND status IN ('pending', 'in_progress')",
    ).get(lane.id)).toEqual({ status: 'pending' });
    expect(getLaneEvents(lane.id).filter((event) => event.verb === 'second_pass_rearmed').at(-1)?.payload)
      .toMatchObject({ approvalId: latestApprovalId, reviewedHeadSha: steeredHead });
    expect(refreshedLane.status).toBe('reviewing');

    markSecondPassAgreed(latestApprovalId);
    expect((await assessDurableApprovedReview(refreshedLane)).approved).toBe(true);
  });

  it('does not blind-pass an approval superseded by a later rejection at the same HEAD', async () => {
    const repoDir = createRepo();
    git(repoDir, ['checkout', '-q', '-b', 'inline/rejected-second-pass']);
    const packetId = 'pkt-rejected-second-pass';
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch: 'inline/rejected-second-pass',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'rejected second-pass fixture',
      packetId,
      sessionKey: 'test-runtime:rejected-second-pass',
    });
    const reviewedHead = commitFile(
      repoDir,
      'src/lib/db/rejected-second-pass-fixture.ts',
      'export const rejectedSecondPassFixture = true;\n',
      'review fixture',
    );
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    await submitPacketReview({
      packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: reviewedHead,
    });
    getSqlite().prepare(
      "UPDATE review_queue SET status = 'completed', updated_at = datetime('now') WHERE lane_id = ? AND status IN ('pending', 'in_progress')",
    ).run(lane.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await submitPacketReview({
      packetId,
      approved: false,
      reviewedHeadSha: reviewedHead,
      findings: [{
        file: 'src/lib/db/rejected-second-pass-fixture.ts',
        line: 1,
        severity: 'bug',
        description: 'The latest review rejects this HEAD.',
        resolution: 'deferred',
      }],
    });

    const refreshedLane = getLane(lane.id)!;
    const rearmed = await rearmPendingSecondPassApproval(refreshedLane);
    expect(rearmed.scheduled).toBe(false);
    expect(await findPendingSecondPassApproval(refreshedLane)).toBeNull();
    expect(getSqlite().prepare(
      "SELECT id FROM review_queue WHERE lane_id = ? AND status IN ('pending', 'in_progress')",
    ).get(lane.id)).toBeUndefined();
    expect((await assessDurableApprovedReview(refreshedLane)).approved).toBe(false);
  });
});
