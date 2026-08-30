import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-close-preservation-'));
const operatorToken = 'operator-close-preservation-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');

const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const { closeDb, getDb } = await import('@/lib/db');
const { sessionOutcomes } = await import('@/lib/db/schema');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { listStoredPacketReceipts } = await import('@/lib/receipts/packet-receipt');

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

function closeRequest(
  packetId: string,
  disposition: 'adopted_elsewhere' | 'superseded' | 'spec_changed' | 'wontfix' = 'wontfix',
  acknowledgeMissingWorktree = false,
) {
  return operatorRequest('/api/orchestrator/discard-packet', {
    packetId,
    clientMutationId: randomUUID(),
    disposition,
    acknowledgeMissingWorktree,
  });
}

async function waitForPacketReceipt(packetId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const receipt = listStoredPacketReceipts(packetId).at(-1);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for packet receipt ${packetId}.`);
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
    const storedReceipt = await waitForPacketReceipt(packetId);
    expect(storedReceipt.receipt).toMatchObject({
      packetId,
      laneId: lane.id,
      disposition: {
        kind: 'discarded',
        disposition: 'wontfix',
        preservedBranches: [],
      },
    });
    expect(storedReceipt.artifact.kind).toBe('receipt');
    expect(isAbsolute(storedReceipt.artifact.relPath)).toBe(false);
  });

  it('closes when both the branch and worktree are absent and records branch-absent', async () => {
    const packetId = 'pkt-close-branch-absent';
    const branch = 'inline/close-branch-absent';
    const { root, repoPath } = makeRepo('o8-close-branch-absent');
    const worktreePath = join(root, 'already-gone');
    const lane = persistPacket({ packetId, repoPath, worktreePath, branch });

    const response = await closeRoute.POST(closeRequest(packetId, 'wontfix', true));
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

  it('banks an unmerged branch, closes with its disposition, and is idempotent', async () => {
    const packetId = 'pkt-close-real-unmerged';
    const branch = 'inline/close-real-unmerged';
    const { root, repoPath } = makeRepo('o8-close-real-unmerged');
    const worktreePath = join(root, 'worktree');
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath]);
    writeFileSync(join(worktreePath, 'unmerged.txt'), 'unmerged\n');
    git(worktreePath, ['add', 'unmerged.txt']);
    git(worktreePath, ['commit', '-m', 'unmerged feature']);
    const branchHead = git(worktreePath, ['rev-parse', 'HEAD']);
    const lane = persistPacket({ packetId, repoPath, worktreePath, branch });

    const response = await closeRoute.POST(closeRequest(packetId, 'adopted_elsewhere'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      result: {
        closed: true,
        disposition: 'adopted_elsewhere',
        preservationFailure: null,
        note: expect.stringContaining('Work preserved on branch preserved/'),
      },
    });
    const preservedRef = git(repoPath, ['for-each-ref', '--format=%(refname:short)', `refs/heads/preserved/packet-${packetId}-*`]);
    expect(preservedRef).toMatch(/^preserved\//);
    expect(git(repoPath, ['rev-parse', preservedRef])).toBe(branchHead);
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      outcome: 'closed_unmerged',
      outcomeNote: expect.stringContaining(preservedRef),
    });
    expect(existsSync(worktreePath)).toBe(false);

    const secondResponse = await closeRoute.POST(closeRequest(packetId, 'adopted_elsewhere'));
    const secondPayload = await secondResponse.json();
    expect(secondResponse.status).toBe(200);
    expect(secondPayload).toMatchObject({
      ok: true,
      result: {
        closed: true,
        alreadyClosed: true,
        packetId,
        laneId: lane.id,
        note: expect.stringContaining('already closed'),
      },
    });
    expect(getLane(lane.id)?.status).toBe('archived');

    const db = getDb();
    const outcomes = await db!
      .select({
        outcome: sessionOutcomes.outcome,
        summary: sessionOutcomes.summary,
        mergedClean: sessionOutcomes.mergedClean,
      })
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.packetId, packetId));
    expect(outcomes).toEqual([{
      outcome: 'adopted_elsewhere',
      summary: expect.stringContaining(preservedRef),
      mergedClean: false,
    }]);
  });

  it('refuses an unmerged branch when no preserved ref can be created', async () => {
    const packetId = 'pkt-close-preservation-failed';
    const branch = 'inline/close-preservation-failed';
    const { root, repoPath } = makeRepo('o8-close-preservation-failed');
    const worktreePath = join(root, 'worktree');
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath]);
    writeFileSync(join(worktreePath, 'unmerged.txt'), 'unmerged\n');
    git(worktreePath, ['add', 'unmerged.txt']);
    git(worktreePath, ['commit', '-m', 'unmerged feature']);
    writeFileSync(join(repoPath, '.git', 'refs', 'heads', 'preserved'), 'blocked\n');
    const lane = persistPacket({ packetId, repoPath, worktreePath, branch });

    const response = await closeRoute.POST(closeRequest(packetId, 'superseded'));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'branch_preservation_failed',
        message: expect.stringContaining(`work on ${branch} could not be preserved`),
      },
    });
    expect(git(repoPath, ['for-each-ref', '--format=%(refname:short)', `refs/heads/preserved/packet-${packetId}-*`])).toBe('');
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
