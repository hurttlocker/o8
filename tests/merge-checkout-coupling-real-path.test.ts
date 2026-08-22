import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-merge-checkout-coupling-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { publishRealtimeMutation } = vi.hoisted(() => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const reviewStateRoute = await import('@/app/api/orchestrator/review-state/route');
const { recordOrchestratorReview } = await import('@/lib/approvals/store');
const { createLane } = await import('@/lib/lane/registry');
const { recordMission } = await import('@/lib/db/missions-store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');

const tempDirs: string[] = [dataDir];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit', '-m', message,
  ]);
}

async function createFixture(label: string, approved: boolean) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-merge-checkout-${label}-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const packetId = `pkt-merge-checkout-${label}-${Date.now()}`;
  const branch = `inline/merge-checkout-${label}-${Date.now()}`;
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);

  const worktree = await getWorktreeManager(repo).create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
  commitAll(worktree.path, 'worker change');
  const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);
  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Merge checkout ${label}`,
  });
  if (approved) {
    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewer: 'codex',
      reviewedHeadSha,
      requiresSecondPass: false,
    });
  }

  const packet = {
    id: packetId,
    referenceLabel: 'P1',
    title: `Merge checkout ${label}`,
    summary: `Merge checkout ${label}`,
    status: 'awaiting_review',
    queueState: 'held',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: approved ? {
      approved: true,
      findings: [],
      recordedAt: new Date().toISOString(),
      reviewedHeadSha,
      summary: 'Approved. No findings recorded.',
      auditApprovalId: null,
    } : null,
    workspaceTargetPath: repo,
    branchTarget: branch,
  } as OrchestratorPacket;
  const missionState = normalizeOrchestratorMissionState({
    version: 2,
    missionId: `mission-${packetId}`,
    prompt: packet.summary,
    summary: packet.summary,
    repoPath: repo,
    runtime: 'codex',
    constraints: '',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  });
  recordMission({
    id: missionState.missionId!,
    repoPath: repo,
    runtime: 'codex',
    prompt: missionState.prompt,
    summary: missionState.summary,
    constraints: '',
    packetMeta: [{ id: packetId, title: packet.title, referenceLabel: packet.referenceLabel }],
    missionState,
    totalWaves: 1,
  });
  writeOrchestratorControlPlaneState(missionState);
  return { lane, repo, origin, packetId, reviewedHeadSha };
}

function mergeRequest(packetId: string): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/merge', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${getOrCreateWsToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ packetId, idempotencyKey: randomUUID() }),
  });
}

function reviewStateRequest(packetId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(packetId)}&spoken=1`,
    {
      headers: {
        host: 'localhost:3001',
        authorization: `Bearer ${getOrCreateWsToken()}`,
      },
    },
  );
}

beforeAll(async () => {
  await updateOperatorDefaults({
    productTelemetryEnabled: false,
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
});

afterEach(() => {
  __resetIdempotencyStoreForTests();
  publishRealtimeMutation.mockClear();
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('merge checkout coupling through real handlers', () => {
  it('lands the base ref while leaving an unrelated dirty operator checkout untouched', async () => {
    const fixture = await createFixture('unrelated-dirty', true);
    git(fixture.repo, ['checkout', '-b', 'operator/wip']);
    writeFileSync(join(fixture.repo, 'file.txt'), 'base\noperator wip\n');
    writeFileSync(join(fixture.repo, 'operator-notes.txt'), 'do not touch\n');
    const branchBefore = git(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const headBefore = git(fixture.repo, ['rev-parse', 'HEAD']);
    const statusBefore = git(fixture.repo, ['status', '--porcelain']);
    const stashBefore = git(fixture.repo, ['stash', 'list']);

    const response = await mergeRoute.POST(mergeRequest(fixture.packetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { merged: true } });
    expect(git(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branchBefore);
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(fixture.repo, ['status', '--porcelain'])).toBe(statusBefore);
    expect(readFileSync(join(fixture.repo, 'file.txt'), 'utf8')).toBe('base\noperator wip\n');
    expect(readFileSync(join(fixture.repo, 'operator-notes.txt'), 'utf8')).toBe('do not touch\n');
    expect(git(fixture.repo, ['stash', 'list'])).toBe(stashBefore);
    expect(git(fixture.repo, ['show', 'refs/heads/main:file.txt'])).toBe('base\nworker');
    expect(git(fixture.repo, ['rev-parse', 'refs/heads/main'])).toBe(payload.result.mergeSha);
    expect(git(fixture.repo, ['ls-remote', '--heads', fixture.origin, 'main']).split(/\s+/)[0])
      .toBe(payload.result.mergeSha);
  }, 30_000);

  it('surfaces a conflicting dirty base checkout in the review state with both branch names', async () => {
    const fixture = await createFixture('base-dirty-review', false);
    writeFileSync(join(fixture.repo, 'file.txt'), 'base\noperator wip\n');

    const response = await reviewStateRoute.GET(reviewStateRequest(fixture.packetId));
    const payload = await response.json();
    const cleanCheck = payload.spokenReview?.mergeGate?.checks?.find((check: { name: string }) => (
      check.name === 'clean-worktree'
    ));

    expect(response.status).toBe(200);
    expect(payload.state).toBe('needs-revision');
    expect(payload.spokenReview.mergeGate.verdict).toBe('failing');
    expect(cleanCheck).toMatchObject({ name: 'clean-worktree', verdict: 'fail' });
    expect(cleanCheck.detail).toContain('found operator checkout branch "main"');
    expect(cleanCheck.detail).toContain('needs base branch "main"');
    expect(cleanCheck.detail).toContain('file.txt');
    expect(git(fixture.repo, ['stash', 'list'])).toBe('');
    expect(git(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(readFileSync(join(fixture.repo, 'file.txt'), 'utf8')).toBe('base\noperator wip\n');
  }, 30_000);
});
