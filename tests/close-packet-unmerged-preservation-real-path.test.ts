import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-close-preservation-'));
const operatorToken = 'operator-close-preservation-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');

const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

const roots: string[] = [dataDir];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo(name: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-`));
  roots.push(root);
  const repoPath = join(root, 'repo');
  git(root, ['init', '--initial-branch=main', repoPath]);
  git(repoPath, ['config', 'user.name', 'o8-test']);
  git(repoPath, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-m', 'base']);
  return { root, repoPath };
}

function persistPacket(input: {
  packetId: string;
  repoPath: string;
  worktreePath: string | null;
  branch: string;
}) {
  const lane = createLane({
    repoPath: input.repoPath,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    branch: input.branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: input.packetId,
    label: `Close ${input.branch}`,
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${input.packetId}`,
    repoPath: input.repoPath,
    runtime: 'codex',
    packets: [{
      id: input.packetId,
      referenceLabel: '#1814',
      title: 'Close stale packet',
      summary: 'Exercise close preservation through the supported handler.',
      workspaceTargetPath: input.repoPath,
      branchTarget: input.branch,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'awaiting_review',
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        runtime: 'codex',
        laneId: lane.id,
      },
      review: null,
    } as OrchestratorPacket],
    updatedAt: new Date().toISOString(),
  });
  return lane;
}

function operatorRequest(pathname: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function closeRequest(packetId: string) {
  return operatorRequest('/api/orchestrator/discard-packet', {
    packetId,
    clientMutationId: randomUUID(),
    disposition: 'wontfix',
  });
}

afterAll(() => {
  closeDb();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('close_packet_unmerged preservation classification — real route', () => {
  it('closes when the branch tip is already an ancestor of main and records already-merged', async () => {
    const packetId = 'pkt-close-already-merged';
    const branch = 'inline/close-already-merged';
    const { root, repoPath } = makeRepo('o8-close-already-merged');
    const worktreePath = join(root, 'worktree');
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath]);
    writeFileSync(join(worktreePath, 'feature.txt'), 'merged\n');
    git(worktreePath, ['add', 'feature.txt']);
    git(worktreePath, ['commit', '-m', 'merged feature']);
    git(repoPath, ['merge', '--ff-only', branch]);
    const lane = persistPacket({ packetId, repoPath, worktreePath, branch });

    const response = await closeRoute.POST(closeRequest(packetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      result: {
        closed: true,
        preservationReceipts: [{ branch, reason: 'already-merged', ref: null }],
        note: expect.stringContaining(`${branch}=already-merged`),
      },
    });
    expect(getLane(lane.id)?.status).toBe('archived');
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('closes when both the branch and worktree are absent and records branch-absent', async () => {
    const packetId = 'pkt-close-branch-absent';
    const branch = 'inline/close-branch-absent';
    const { root, repoPath } = makeRepo('o8-close-branch-absent');
    const worktreePath = join(root, 'already-gone');
    const lane = persistPacket({ packetId, repoPath, worktreePath, branch });

    const response = await closeRoute.POST(closeRequest(packetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      result: {
        closed: true,
        preservationReceipts: [{ branch, reason: 'branch-absent', ref: null }],
        note: expect.stringContaining(`${branch}=branch-absent`),
      },
    });
    expect(getLane(lane.id)?.status).toBe('archived');
  });

  it('refuses a branch with real unmerged commits and names its preserved ref', async () => {
    const packetId = 'pkt-close-real-unmerged';
    const branch = 'inline/close-real-unmerged';
    const { root, repoPath } = makeRepo('o8-close-real-unmerged');
    const worktreePath = join(root, 'worktree');
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath]);
    writeFileSync(join(worktreePath, 'unmerged.txt'), 'unmerged\n');
    git(worktreePath, ['add', 'unmerged.txt']);
    git(worktreePath, ['commit', '-m', 'unmerged feature']);
    const lane = persistPacket({ packetId, repoPath, worktreePath, branch });

    const response = await closeRoute.POST(closeRequest(packetId));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'unmerged_work_present',
        message: expect.stringContaining('work was banked at preserved/'),
      },
    });
    const preservedRef = git(repoPath, ['for-each-ref', '--format=%(refname:short)', `refs/heads/preserved/packet-${packetId}-*`]);
    expect(preservedRef).toMatch(/^preserved\//);
    expect(git(repoPath, ['show', `${preservedRef}:unmerged.txt`])).toBe('unmerged');
    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', worktreePath });
    expect(existsSync(worktreePath)).toBe(true);
  });
});

describe('reset_packet absent-worktree cleanup — real route', () => {
  it('treats an already-absent worktree as the successful cleanup postcondition', async () => {
    const packetId = 'pkt-reset-worktree-absent';
    const branch = 'inline/reset-worktree-absent';
    const { root, repoPath } = makeRepo('o8-reset-worktree-absent');
    const worktreePath = join(root, 'already-gone');
    const lane = createLane({
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      label: 'Reset absent worktree',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const response = await resetRoute.POST(operatorRequest('/api/orchestrator/reset-packet', {
      packetId,
      clearWorktree: true,
      idempotencyKey: randomUUID(),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      result: { reset: true, worktreePruned: true },
    });
    expect(getLane(lane.id)).toMatchObject({ status: 'archived', packetId: '', worktreePath: null });
  });
});
