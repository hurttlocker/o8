import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-workspace-real-path-'));
const dataDir = path.join(root, 'data');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
const priorOwnedCodexRoot = process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
const ownedCodexRoot = path.join(root, 'owned-codex');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedCodexRoot;

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
const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { measureWorkspaceStorage } = await import('@/lib/workspace/hibernator');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { listWorkspaceSnapshotTransitions } = await import('@/lib/worktree/snapshot-state');

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
  if (priorOwnedCodexRoot === undefined) delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  else process.env.CORTEX_IDE_OWNED_CODEX_ROOT = priorOwnedCodexRoot;
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
    const surfaceId = 'codex-owned:codex-owned-real-path-test';
    const worktreeId = 'packet-real-park';
    const branch = 'inline/packet-real-park';
    const registeredRepoPath = repo.localPath;
    const worktreePath = path.join(resolveWorktreeRootLayout(registeredRepoPath).primaryBase, worktreeId);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(registeredRepoPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
    writeFileSync(path.join(worktreePath, 'tracked.txt'), 'reviewed change\n');
    git(worktreePath, 'add', 'tracked.txt');
    git(worktreePath, 'commit', '-qm', 'packet change');
    mkdirSync(path.join(worktreePath, 'node_modules'));
    writeFileSync(
      path.join(worktreePath, 'node_modules', 'dogfood-payload.bin'),
      Buffer.alloc(8 * 1024 * 1024, 0x5a),
    );
    const reviewedHead = git(worktreePath, 'rev-parse', 'HEAD');
    const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
    const materializationParentIdentity = await captureWorktreeMaterializationIdentity(
      path.dirname(worktreePath),
    );
    writeFileSync(path.join(resolveWorktreeRootLayout(registeredRepoPath).primaryBase, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {
        [worktreeId]: {
          id: worktreeId,
          agentType: 'codex',
          sessionKey: surfaceId,
          baseBranch: 'main',
          createdAt: Date.now(),
          claudeManaged: false,
          taskName: worktreeId,
          branchName: branch,
          status: 'ready',
          isolationKind: 'git-worktree',
          materializationIdentity,
          materializationParentIdentity,
        },
      },
    }));

    const sessionDir = path.join(ownedCodexRoot, 'codex-owned-real-path-test');
    mkdirSync(sessionDir, { recursive: true });
    const session: OwnedSessionRecord = {
      surfaceId,
      packetId,
      sessionDir,
      cwd: worktreePath,
      repoPath: worktreePath,
      branch,
      head: reviewedHead,
      title: 'Workspace route owned-session fixture',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      latestPrompt: 'Review the packet change.',
      latestSummary: 'Packet change is ready for review.',
      workspaceBinding: {
        logicalWorkspaceId: `packet:${packetId}`,
        repositoryUuid: null,
        packetId,
        cwd: worktreePath,
        version: 1,
        verifiedAt: '2026-08-14T00:00:00.000Z',
      },
      recentRuns: [],
      runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    };
    const metadataPath = path.join(sessionDir, 'session.json');
    writeFileSync(metadataPath, JSON.stringify(session));
    const lifecycle = getOwnedSessionLifecycle(surfaceId);
    expect(lifecycle?.runtimeId).toBe('codex');
    expect(await lifecycle?.getWorkspaceBinding?.(surfaceId)).toMatchObject({
      binding: session.workspaceBinding,
      retainedRunsComplete: true,
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

    const parkStartedAt = performance.now();
    const parked = await POST(post('park', packetId, 'real-park-1'));
    const parkDurationMs = Math.round(performance.now() - parkStartedAt);
    const parkedBody = await parked.json();
    expect(parked.status, JSON.stringify(parkedBody)).toBe(200);
    expect(parkedBody).toMatchObject({
      ok: true,
      result: { status: 'parked', state: 'parked', reviewable: true },
    });
    expect(JSON.stringify(parkedBody)).not.toContain(worktreePath);
    expect(JSON.stringify(parkedBody)).not.toContain(surfaceId);
    expect(existsSync(worktreePath)).toBe(false);
    const replayedPark = await POST(post('park', packetId, 'real-park-1'));
    expect(replayedPark.status).toBe(200);
    expect((await replayedPark.json()).result).toMatchObject({ status: 'parked', state: 'parked' });
    const parkedTransition = listWorkspaceSnapshotTransitions(repo.id, packetId)
      .find((transition) => transition.transitionId === 'real-park-1:parked');
    const logicalBytesBefore = parkedTransition?.receipt?.logicalBytesBefore;
    const reclaimedAvailableBytes = parkedTransition?.receipt?.reclaimedAvailableBytes;
    expect(typeof logicalBytesBefore).toBe('number');
    expect(logicalBytesBefore).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(typeof reclaimedAvailableBytes).toBe('number');

    closeDb();
    const reboundLane = findLatestLaneByPacket(packetId)!;
    const parkedReview = await readLaneReviewDiff(reboundLane);
    expect(parkedReview).toMatchObject({
      headSha: reviewedHead,
      source: { kind: 'immutable_snapshot', mergeAvailable: false },
    });

    const restoreStartedAt = performance.now();
    const restored = await POST(post('restore', packetId, 'real-restore-1'));
    const restoreDurationMs = Math.round(performance.now() - restoreStartedAt);
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
    expect(await lifecycle?.getWorkspaceBinding?.(surfaceId)).toMatchObject({
      surfaceId,
      binding: {
        logicalWorkspaceId: `packet:${packetId}`,
        repositoryUuid: repo.id,
        cwd: worktreePath,
        version: 2,
      },
    });
    const restoredSession = JSON.parse(readFileSync(metadataPath, 'utf8')) as OwnedSessionRecord;
    expect(restoredSession.workspaceBinding).toMatchObject({
      logicalWorkspaceId: `packet:${packetId}`,
      repositoryUuid: repo.id,
      packetId,
      cwd: worktreePath,
      version: 2,
    });
    const wrongRebind = {
      logicalWorkspaceId: `packet:${packetId}`,
      repositoryUuid: repo.id,
      packetId,
      expectedCwd: worktreePath,
      nextCwd: path.join(root, 'unexpected-workspace'),
      expectedVersion: 1,
    };
    await expect(lifecycle?.rebindWorkspace?.(surfaceId, wrongRebind)).resolves.toMatchObject({ status: 'conflict' });
    await expect(lifecycle?.rebindWorkspace?.(surfaceId, {
      ...wrongRebind,
      logicalWorkspaceId: 'packet:another-owner',
      expectedVersion: 2,
    })).resolves.toMatchObject({ status: 'conflict' });
    expect(JSON.parse(readFileSync(metadataPath, 'utf8')).workspaceBinding).toEqual(restoredSession.workspaceBinding);
    const replayedRestore = await POST(post('restore', packetId, 'real-restore-1'));
    expect(replayedRestore.status).toBe(200);
    expect(JSON.parse(readFileSync(metadataPath, 'utf8')).workspaceBinding).toEqual(restoredSession.workspaceBinding);
    const restoredStorage = await measureWorkspaceStorage(worktreePath);
    if (process.env.O8_THIN_WORKSPACE_DOGFOOD === '1') {
      console.info('[thin-workspaces-dogfood]', JSON.stringify({
        logicalBytesBefore,
        parkedPathBytes: 0,
        restoredLogicalBytes: restoredStorage.logicalBytes,
        reclaimedAvailableBytes,
        parkDurationMs,
        restoreDurationMs,
        parkedReviewSource: parkedReview.source.kind,
        restoredReviewSource: 'materialized',
      }));
    }
  }, 60_000);
});
