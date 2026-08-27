import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { createLane } from './registry';
import { assessDurableApprovedReview, hasDurableApprovedReview } from './durable-review-approval';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/push/notify', () => ({
  notifyApprovalCreated: vi.fn(async () => {}),
}));

const WORKER_TOKEN = 'local-worker-token-durable-review-0123456789';
writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');

const approvalsRoute = await import('@/app/api/panel/approvals/route');
const {
  createApproval,
  getApproval,
  listApprovalsForContext,
  markSecondPassAgreed,
  recordApprovalAudit,
  recordOrchestratorReview,
  resolveApproval,
} = await import('@/lib/approvals/store');

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
  it('refuses an approved-status record whose persisted review verdict rejects', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-rejected-verdict-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    recordOrchestratorReview(packetId, {
      approved: false,
      findings: [],
      reviewedHeadSha,
    });
    const review = listApprovalsForContext({ packetId, laneId: lane.id, sessionKey: lane.sessionKey ?? undefined })
      .find((candidate) => candidate.toolName === 'orchestrator_review')!;
    expect(review).toMatchObject({ status: 'pending', args: { approved: false } });

    resolveApproval(review.id, 'approve', 'test', 'Construct the persisted contradictory status through the production resolver.');
    expect(getApproval(review.id)).toMatchObject({
      status: 'approved',
      args: { approved: false, reviewTurnOutcome: 'completed' },
    });
    await expect(assessDurableApprovedReview(lane)).resolves.toMatchObject({
      approved: false,
      approvalId: null,
    });
  }, 20_000);

  it('keeps an approved verdict with a deferred finding pending and out of the merge gate', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-deferred-finding-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [{
        file: 'packet.txt',
        severity: 'bug',
        description: 'The finding still requires a fix.',
        resolution: 'deferred',
      }],
      reviewedHeadSha,
    });

    const review = listApprovalsForContext({ packetId, laneId: lane.id, sessionKey: lane.sessionKey ?? undefined })
      .find((candidate) => candidate.toolName === 'orchestrator_review');
    expect(review).toMatchObject({
      status: 'pending',
      args: { approved: true, findings: [{ resolution: 'deferred' }] },
    });
    expect(await hasDurableApprovedReview(lane)).toBe(false);
  }, 20_000);

  it('lets the latest rejected review override an older approved row for the same HEAD', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-latest-refusal-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewedHeadSha,
    });
    const olderApproval = listApprovalsForContext({ packetId, laneId: lane.id, sessionKey: lane.sessionKey ?? undefined })
      .find((candidate) => candidate.toolName === 'orchestrator_review')!;
    expect(olderApproval.status).toBe('approved');

    const latestRefusal = createApproval({
      source: 'runtime',
      runtime: 'codex',
      agent: 'reviewer',
      sessionKey: lane.sessionKey!,
      title: 'Orchestrator review',
      description: 'A later review requested changes.',
      summary: 'Later orchestrator review',
      toolName: 'orchestrator_review',
      args: {
        packetId,
        approved: false,
        findings: [],
        reviewedHeadSha,
        reviewTurnId: `review-turn-latest-refusal-${Date.now()}`,
        reviewTurnOutcome: 'completed',
      },
      risk: 'high',
      metadata: {
        Packet: packetId,
        Lane: lane.id,
        'Reviewed HEAD': reviewedHeadSha,
      },
    });
    recordApprovalAudit(latestRefusal.id, 'orchestrator_review', 'system', 'The later review requested changes.', {
      approved: false,
      reviewedHeadSha,
    });
    resolveApproval(latestRefusal.id, 'reject', 'system', 'The later review requested changes.');

    expect(getApproval(olderApproval.id)?.status).toBe('approved');
    expect(getApproval(latestRefusal.id)?.status).toBe('rejected');
    expect(await hasDurableApprovedReview(lane)).toBe(false);
  }, 20_000);

  it('authorizes a genuinely approved review whose findings are resolved', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-clean-approval-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [{
        file: 'packet.txt',
        severity: 'note',
        description: 'The review confirmed the final behavior.',
        resolution: 'fixed',
      }],
      reviewedHeadSha,
    });

    const review = listApprovalsForContext({ packetId, laneId: lane.id, sessionKey: lane.sessionKey ?? undefined })
      .find((candidate) => candidate.toolName === 'orchestrator_review')!;
    await expect(assessDurableApprovedReview(lane)).resolves.toMatchObject({
      approved: true,
      approvalId: review.id,
    });
  }, 20_000);

  it('demotes an approved record when a later review rejects it and records the transition', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-review-demotion-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewedHeadSha,
    });
    const approved = listApprovalsForContext({ packetId, laneId: lane.id, sessionKey: lane.sessionKey ?? undefined })
      .find((candidate) => candidate.toolName === 'orchestrator_review')!;
    expect(approved.status).toBe('approved');

    recordOrchestratorReview(packetId, {
      approved: false,
      findings: [{
        file: 'packet.txt',
        severity: 'bug',
        description: 'The later review found a blocking defect.',
        resolution: 'deferred',
      }],
      reviewedHeadSha,
    });

    const demoted = getApproval(approved.id);
    expect(demoted).toMatchObject({
      id: approved.id,
      status: 'pending',
      args: { approved: false, findings: [{ resolution: 'deferred' }] },
    });
    expect(demoted?.resolvedAt).toBeUndefined();
    expect(demoted?.resolution).toBeUndefined();
    expect(demoted?.audit.at(-1)).toMatchObject({
      type: 'updated',
      actor: 'orchestrator',
      note: 'Returned to pending because the review verdict requested changes.',
    });
    expect(await hasDurableApprovedReview(lane)).toBe(false);
  }, 20_000);

  it('demotes an approved record when a later approved verdict leaves a finding unresolved', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-durable-unresolved-demotion-${Date.now()}`;
    const lane = createReviewLane(repoPath, packetId);
    const reviewedHeadSha = git(repoPath, ['rev-parse', 'HEAD']);

    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewedHeadSha,
    });
    const approved = listApprovalsForContext({ packetId, laneId: lane.id, sessionKey: lane.sessionKey ?? undefined })
      .find((candidate) => candidate.toolName === 'orchestrator_review')!;

    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [{
        file: 'packet.txt',
        severity: 'bug',
        description: 'The finding is still unresolved.',
        resolution: 'deferred',
      }],
      reviewedHeadSha,
    });

    const demoted = getApproval(approved.id);
    expect(demoted).toMatchObject({
      status: 'pending',
      args: { approved: true, findings: [{ resolution: 'deferred' }] },
    });
    expect(demoted?.audit.at(-1)?.note).toBe('Returned to pending because unresolved findings remain.');
    expect(await hasDurableApprovedReview(lane)).toBe(false);
  }, 20_000);

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
