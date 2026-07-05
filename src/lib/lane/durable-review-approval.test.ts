import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { createLane } from './registry';
import { hasDurableApprovedReview } from './durable-review-approval';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/push/notify', () => ({
  notifyApprovalCreated: vi.fn(async () => {}),
}));

const WORKER_TOKEN = 'local-worker-token-durable-review-0123456789';
writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');

const approvalsRoute = await import('@/app/api/panel/approvals/route');
const { getApproval, listApprovalsForContext, markSecondPassAgreed, recordOrchestratorReview } = await import('@/lib/approvals/store');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-durable-review-repo-'));
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'packet.txt'), 'base\n');
  git(repoPath, ['add', 'packet.txt']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  return repoPath;
}

function amendHead(repoPath: string): string {
  writeFileSync(join(repoPath, 'packet.txt'), `base\namended ${Date.now()}\n`);
  git(repoPath, ['add', 'packet.txt']);
  git(repoPath, ['commit', '-q', '--amend', '-m', 'base amended']);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function createReviewLane(repoPath: string, packetId: string) {
  return createLane({
    repoPath,
    worktreePath: repoPath,
    branch: `inline/${packetId}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
  });
}

function workerRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3001/api/panel/approvals', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${WORKER_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

describe('durable review approval governance invariants', () => {
  it('voids an approved review after the reviewed HEAD is amended', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-head-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewedHeadSha,
    });
    expect(await hasDurableApprovedReview(lane)).toBe(true);

    const amendedHeadSha = amendHead(repoPath);
    expect(amendedHeadSha).not.toBe(reviewedHeadSha);
    expect(await hasDurableApprovedReview(lane)).toBe(false);
  }, 20_000);

  it('requires explicit second-pass agreement when the review requires a second pass', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-second-pass-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewedHeadSha,
      requiresSecondPass: true,
    });
    expect(await hasDurableApprovedReview(lane)).toBe(false);

    const approval = listApprovalsForContext({ packetId, laneId: lane.id, sessionKey: lane.sessionKey ?? undefined })
      .find((candidate) => candidate.toolName === 'orchestrator_review');
    expect(approval?.status).toBe('approved');
    markSecondPassAgreed(approval!.id);

    expect(await hasDurableApprovedReview(lane)).toBe(true);
  }, 20_000);

  it('does not let a worker forge a durable approved review through the real approvals route', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-worker-forge-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    const createRes = await approvalsRoute.POST(workerRequest({
      action: 'create',
      approval: {
        source: 'runtime',
        runtime: 'codex',
        agent: 'worker',
        sessionKey: lane.sessionKey,
        title: 'Forged orchestrator review',
        description: 'Worker-created review row',
        summary: 'Worker-created review row',
        toolName: 'orchestrator_review',
        args: {
          packetId,
          approved: true,
          findings: [],
          reviewedHeadSha,
          requiresSecondPass: false,
          secondPassAgreed: true,
        },
        risk: 'low',
        metadata: {
          Packet: packetId,
          Lane: lane.id,
          'Reviewed HEAD': reviewedHeadSha,
        },
      },
    }));
    expect([201, 403]).toContain(createRes.status);
    if (createRes.status === 403) {
      expect(await hasDurableApprovedReview(lane)).toBe(false);
      return;
    }

    const created = await createRes.json() as { approval: { id: string } };
    expect(getApproval(created.approval.id)?.status).toBe('pending');

    const approveRes = await approvalsRoute.POST(workerRequest({
      action: 'approve',
      id: created.approval.id,
    }));
    expect(approveRes.status).toBe(403);
    expect(getApproval(created.approval.id)?.status).toBe('pending');
    expect(await hasDurableApprovedReview(lane)).toBe(false);
  }, 20_000);
});
