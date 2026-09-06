import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-review-state-released-'));
const operatorToken = 'operator-review-state-released-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');

const reviewStateRoute = await import('@/app/api/orchestrator/review-state/route');
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

const roots: string[] = [dataDir];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterAll(() => {
  closeDb();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('review state for released but unmerged packets through the real route', () => {
  it('reports needs-revision for the persisted rejected review instead of merged', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'o8-review-state-route-'));
    roots.push(root);
    const repoPath = join(root, 'repo');
    const worktreePath = join(root, 'worktree');
    const branch = 'fix/review-state-released';
    const packetId = 'pkt-review-state-released';

    git(root, ['init', '--initial-branch=main', repoPath]);
    git(repoPath, ['config', 'user.name', 'o8-test']);
    git(repoPath, ['config', 'user.email', 'o8@example.test']);
    writeFileSync(join(repoPath, 'base.txt'), 'base\n');
    git(repoPath, ['add', 'base.txt']);
    git(repoPath, ['commit', '-m', 'base']);
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath]);
    writeFileSync(join(worktreePath, 'feature.txt'), 'reviewed change\n');
    git(worktreePath, ['add', 'feature.txt']);
    git(worktreePath, ['commit', '-m', 'test fixture change']);
    writeFileSync(join(worktreePath, 'dirty.txt'), 'merge gate must fail\n');

    const lane = createLane({
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      label: 'Released review state',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-review-state-released',
      repoPath,
      runtime: 'codex',
      packets: [{
        id: packetId,
        referenceLabel: '#2083',
        title: 'Released review state',
        summary: 'Keep released distinct from merged.',
        workspaceTargetPath: repoPath,
        branchTarget: branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'held',
        releaseState: 'released',
        releaseStatePayload: {
          source: 'headless_released',
          evidenceKind: 'headless_loop',
          mergeCommit: null,
          releasedAt: '2026-09-06T12:00:00.000Z',
        },
        status: 'released',
        blockedReason: null,
        lane: null,
        review: {
          approved: false,
          findings: [],
          summary: 'Changes requested',
          recordedAt: '2026-09-06T12:01:00.000Z',
        },
      } as OrchestratorPacket],
      updatedAt: '2026-09-06T12:01:00.000Z',
    });

    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', outcome: null });

    const response = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${packetId}`,
      { headers: { host: 'localhost:3001', authorization: `Bearer ${operatorToken}` } },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      packetId,
      state: 'needs-revision',
      orchestratorReview: { verdict: 'rejected' },
      mergeGate: { verdict: 'failing' },
      lane: lane.id,
      outcome: null,
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      id: packetId,
      releaseState: 'released',
      releaseStatePayload: { mergeCommit: null },
    });
  });
});
