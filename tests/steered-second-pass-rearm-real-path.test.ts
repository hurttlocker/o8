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
const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-steered-second-pass-repo-'));
const operatorToken = 'operator-steered-second-pass-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { findPendingSecondPassApproval } = await import('@/lib/lane/blind-second-pass-review');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function commitFile(path: string, contents: string, message: string): string {
  const absolutePath = join(repoDir, path);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
  git(['add', '--', path]);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

function steerRequest(packetId: string) {
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
      idempotencyKey: 'steered-second-pass-rearm',
    }),
  });
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe('steered packet second-pass scheduling through persisted paths', () => {
  it('re-arms blind review when submit_review approves the steered HEAD', async () => {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    commitFile('README.md', 'fixture\n', 'base');
    git(['checkout', '-q', '-b', 'inline/steered-second-pass']);

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

    const oldHead = commitFile('docs/first-pass.md', 'first review\n', 'first pass');
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

    const steerResponse = await steerRoute.POST(steerRequest(packetId));
    expect(steerResponse.status).toBe(200);
    expect(h.perform).toHaveBeenCalledOnce();
    expect(getLane(lane.id)?.status).toBe('running');

    const steeredHead = commitFile(
      'src/lib/db/steered-second-pass-fixture.ts',
      'export const steeredSecondPassFixture = true;\n',
      'steered repair',
    );
    expect(steeredHead).not.toBe(oldHead);
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const review = await submitPacketReview({
      packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: steeredHead,
    });
    expect(review.reviewedHeadSha).toBe(steeredHead);

    const refreshedLane = getLane(lane.id)!;
    const pendingSecondPass = await findPendingSecondPassApproval(refreshedLane);
    expect(pendingSecondPass?.reviewedHeadSha).toBe(steeredHead);
    expect(getSqlite().prepare(
      "SELECT status FROM review_queue WHERE lane_id = ? AND status IN ('pending', 'in_progress')",
    ).get(lane.id)).toEqual({ status: 'pending' });
    expect(getLaneEvents(lane.id).find((event) => event.verb === 'second_pass_rearmed')?.payload)
      .toMatchObject({ reviewedHeadSha: steeredHead });
    expect(refreshedLane.status).toBe('reviewing');
  });
});
