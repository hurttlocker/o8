import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { OwnedWorkspaceBindingReceipt } from '@/lib/runtimes/shared/owned-session';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-workspace-real-path-'));
const dataDir = path.join(root, 'data');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipal: () => 'operator',
  resolveRequestPrincipalContext: () => ({ role: 'operator' }),
  workerPacketRefusal: () => null,
}));

const { POST } = await import('@/app/api/orchestrator/workspace/route');
const { closeDb } = await import('@/lib/db');
const { createLane, findLatestLaneByPacket, setLaneStatus } = await import('@/lib/lane/registry');
const { readLaneReviewDiff, resolveLaneReviewSource } = await import('@/lib/lane/review-source');
const { addRepo } = await import('@/lib/repos/registry');
const { registerOwnedSessionLifecycleHandler } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function post(action: 'park' | 'restore', packetId: string, clientMutationId: string) {
  return new NextRequest('http://localhost/api/orchestrator/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, packetId, clientMutationId }),
  });
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('workspace park production route', () => {
  it('parks, survives a DB reopen, serves immutable review, and restores the exact session binding', async () => {
    const repoPath = path.join(root, 'repo');
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, 'init', '-q', '-b', 'main');
    git(repoPath, 'config', 'user.email', 'o8-test@example.test');
    git(repoPath, 'config', 'user.name', 'o8 test');
    writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
    git(repoPath, 'add', '.gitignore', 'tracked.txt');
    git(repoPath, 'commit', '-qm', 'base');

    const repo = await addRepo(repoPath);
    const packetId = 'packet-real-park';
    const worktreeId = 'packet-real-park';
    const branch = 'inline/packet-real-park';
    const registeredRepoPath = repo.localPath;
    const worktreePath = path.join(resolveWorktreeRootLayout(registeredRepoPath).primaryBase, worktreeId);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(registeredRepoPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
    writeFileSync(path.join(worktreePath, 'tracked.txt'), 'reviewed change\n');
    git(worktreePath, 'add', 'tracked.txt');
    git(worktreePath, 'commit', '-qm', 'packet change');
    const reviewedHead = git(worktreePath, 'rev-parse', 'HEAD');
    writeFileSync(path.join(resolveWorktreeRootLayout(registeredRepoPath).primaryBase, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {
        [worktreeId]: {
          id: worktreeId,
          agentType: 'codex',
          sessionKey: 'workspace-real-owned:session',
          baseBranch: 'main',
          createdAt: Date.now(),
          claudeManaged: false,
          taskName: worktreeId,
          branchName: branch,
          status: 'ready',
          isolationKind: 'git-worktree',
        },
      },
    }));

    const surfaceId = 'workspace-real-owned:session';
    let binding: OwnedWorkspaceBindingReceipt = {
      surfaceId,
      runtimeId: 'codex',
      sessionState: 'active',
      binding: {
        logicalWorkspaceId: `packet:${packetId}`,
        repositoryUuid: null,
        packetId,
        cwd: worktreePath,
        version: 1,
        verifiedAt: '2026-08-14T00:00:00.000Z',
      },
      activeRun: null,
      retainedRuns: [],
      retainedRunsComplete: true,
      retainedRunTotal: 0,
    };
    registerOwnedSessionLifecycleHandler({
      runtimeId: 'codex',
      surfaceIdPrefix: 'workspace-real-owned:',
      commandLabel: 'real-path-test',
      resolveRoot: () => root,
      sessionState: async () => 'active',
      archiveSession: async () => ({ archived: false, note: 'unused' }),
      getWorkspaceBinding: async () => binding,
      rebindWorkspace: async (_surfaceId, input) => {
        if (input.expectedVersion !== binding.binding.version
          || input.logicalWorkspaceId !== binding.binding.logicalWorkspaceId) {
          return { status: 'conflict', receipt: binding, note: 'binding mismatch' };
        }
        binding = {
          ...binding,
          binding: {
            ...binding.binding,
            repositoryUuid: input.repositoryUuid,
            packetId: input.packetId,
            cwd: path.resolve(input.nextCwd),
            version: binding.binding.version + 1,
          },
        };
        return { status: 'rebound', receipt: binding };
      },
    });
    const lane = createLane({
      repoPath: registeredRepoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: surfaceId,
      ownership: 'managed',
    });
    setLaneStatus(lane.id, 'reviewing');

    const parked = await POST(post('park', packetId, 'real-park-1'));
    const parkedBody = await parked.json();
    expect(parked.status).toBe(200);
    expect(parkedBody).toMatchObject({
      ok: true,
      result: { status: 'parked', state: 'parked', reviewable: true },
    });
    expect(JSON.stringify(parkedBody)).not.toContain(worktreePath);
    expect(JSON.stringify(parkedBody)).not.toContain(surfaceId);
    expect(existsSync(worktreePath)).toBe(false);

    closeDb();
    const reboundLane = findLatestLaneByPacket(packetId)!;
    const parkedReview = await readLaneReviewDiff(reboundLane);
    expect(parkedReview).toMatchObject({
      headSha: reviewedHead,
      source: { kind: 'immutable_snapshot', mergeAvailable: false },
    });

    const restored = await POST(post('restore', packetId, 'real-restore-1'));
    const restoredBody = await restored.json();
    expect(restored.status).toBe(200);
    expect(restoredBody).toMatchObject({
      ok: true,
      result: { status: 'restored', state: 'materialized', reviewable: true },
    });
    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(reviewedHead);
    expect(await resolveLaneReviewSource(findLatestLaneByPacket(packetId)!)).toMatchObject({
      kind: 'materialized',
      mergeAvailable: true,
    });
    expect(binding).toMatchObject({
      surfaceId,
      binding: {
        logicalWorkspaceId: `packet:${packetId}`,
        repositoryUuid: repo.id,
        cwd: worktreePath,
        version: 2,
      },
    });
  }, 15_000);
});
