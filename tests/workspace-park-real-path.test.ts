import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-workspace-real-path-'));
const dataDir = path.join(root, 'data');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
const priorOwnedCodexRoot = process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
const ownedCodexRoot = path.join(root, 'owned-codex');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedCodexRoot;

const moduleResolution = vi.hoisted(() => ({ bundled: false, recovery: false, failSessionWrite: false,
  beforeSessionWrite: null as (() => void) | null }));
// New recovery fixtures own no process. Keep the production probe and binding
// checks while excluding unrelated host processes from their cwd inventory.
vi.mock('@/lib/runtime/process-cwd-snapshot', async original => {
  const actual = await original<typeof import('@/lib/runtime/process-cwd-snapshot')>();
  return { ...actual, readProcessCwdSnapshot: (...args: Parameters<typeof actual.readProcessCwdSnapshot>) => (
    moduleResolution.recovery ? Promise.resolve({ status: 'ready', rows: [], capturedAt: Date.now() })
      : actual.readProcessCwdSnapshot(...args)
  ) };
});
vi.mock('@/lib/fs/json', async original => {
  const actual = await original<typeof import('@/lib/fs/json')>();
  return { ...actual, writeJsonFile: async (...args: Parameters<typeof actual.writeJsonFile>) => {
    if (moduleResolution.beforeSessionWrite && args[0].endsWith('/session.json')) {
      const interrupt = moduleResolution.beforeSessionWrite;
      moduleResolution.beforeSessionWrite = null;
      interrupt();
    }
    if (moduleResolution.failSessionWrite && args[0].endsWith('/session.json')) {
      moduleResolution.failSessionWrite = false;
      throw new Error('injected session metadata failure');
    }
    return actual.writeJsonFile(...args);
  } };
});
const bundledSqliteId = '[externals]/better-sqlite3 [external] (better-sqlite3, cjs, [project]/node_modules/better-sqlite3)';

// Bundlers rewrite the parent resolver; the spawned Node child has no module registry.
// Keep the real SQLite database, child process, claim CAS and Restore route.
vi.mock('node:module', async original => {
  const actual = await original<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (filename: string | URL) => {
      const nativeRequire = actual.createRequire(filename);
      return new Proxy(nativeRequire, {
        get(target, property, receiver) {
          if (property === 'resolve' && moduleResolution.bundled) {
            return Object.assign((id: string, options?: { paths?: string[] }) => (
              id === 'better-sqlite3' ? bundledSqliteId : target.resolve(id, options)
            ), { paths: target.resolve.paths });
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
});

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipal: () => 'operator',
  resolveRequestPrincipalContext: () => ({ role: 'operator' }),
  workerPacketRefusal: () => null,
}));

const { recordOrchestratorReview, listApprovalsForContext } = await import('@/lib/approvals/store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { POST } = await import('@/app/api/orchestrator/workspace/route');
const { closeDb } = await import('@/lib/db');
const { appendEvent, archiveLane, createLane, findLatestLaneByPacket, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { readLaneReviewDiff, resolveLaneReviewSource } = await import('@/lib/lane/review-source');
const { addRepo } = await import('@/lib/repos/registry');
const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { measureWorkspaceStorage } = await import('@/lib/workspace/hibernator');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import('@/lib/worktree/snapshot-state');

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
  it.each(['native', 'bundled', 'recovered', 'user-archive', 'changed-approval', 'session-conflict', 'metadata-failure', 'newer-intent'])('parks and restores the exact persisted session binding with %s module resolution', async mode => {
    moduleResolution.bundled = mode === 'bundled';
    moduleResolution.failSessionWrite = false;
    moduleResolution.beforeSessionWrite = null;
    if (moduleResolution.bundled) {
      expect(createRequire(import.meta.url).resolve('better-sqlite3')).toBe(bundledSqliteId);
    }
    const recovery = !['native', 'bundled'].includes(mode);
    moduleResolution.recovery = recovery;
    const repoPath = path.join(root, 'repo-' + mode);
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, 'init', '-q', '-b', 'main');
    git(repoPath, 'config', 'user.email', 'o8-test@example.test');
    git(repoPath, 'config', 'user.name', 'o8 test');
    writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
    git(repoPath, 'add', '.gitignore', 'tracked.txt');
    git(repoPath, 'commit', '-qm', 'base');

    const repo = await addRepo(repoPath);
    const packetId = 'packet-real-park-' + mode;
    const sessionId = 'codex-owned-real-path-test-' + mode;
    const surfaceId = 'codex-owned:' + sessionId;
    const worktreeId = packetId;
    const branch = 'inline/' + packetId;
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

    const sessionDir = path.join(ownedCodexRoot, sessionId);
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
    const transcriptPath = path.join(sessionDir, 'runs', 'original.jsonl');
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, '{"type":"assistant","text":"original completed work"}\n');
    session.recentRuns = [{ id: 'original-run', mode: 'launch', prompt: 'original',
      startedAt: session.createdAt, finishedAt: session.updatedAt, pid: 0, outcome: 'finished',
      stdoutPath: transcriptPath, stderrPath: path.join(sessionDir, 'original.stderr') }];
    session.runIdentityLedger = { version: 1, totalRuns: 1, complete: true };
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
    if (recovery) recordOrchestratorReview(packetId, { approved: true, findings: [], reviewedHeadSha: reviewedHead });
    const approvalsBefore = listApprovalsForContext({ packetId });

    const parkStartedAt = performance.now();
    const parked = await POST(post('park', packetId, mode + '-park-1'));
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
    const replayedPark = await POST(post('park', packetId, mode + '-park-1'));
    expect(replayedPark.status).toBe(200);
    expect((await replayedPark.json()).result).toMatchObject({ status: 'parked', state: 'parked' });
    const parkedTransition = listWorkspaceSnapshotTransitions(repo.id, packetId)
      .find((transition) => transition.transitionId === mode + '-park-1:parked');
    const logicalBytesBefore = parkedTransition?.receipt?.logicalBytesBefore;
    const reclaimedAvailableBytes = parkedTransition?.receipt?.reclaimedAvailableBytes;
    expect(typeof logicalBytesBefore).toBe('number');
    expect(logicalBytesBefore).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(typeof reclaimedAvailableBytes).toBe('number');

    if (recovery) {
      await new Promise(resolve => setTimeout(resolve, 3));
      archiveLane(lane.id, 'system');
      await new Promise(resolve => setTimeout(resolve, 3));
      updateLane(lane.id, { outcome: 'no_changes', outcomeNote: 'Agent finished without making changes', lastEventLabel: 'finished_no_changes' });
      await new Promise(resolve => setTimeout(resolve, 3));
      appendEvent(lane.id, 'status_change', 'system', {
        reason: 'branch_missing_reconciled', outcome: 'no_changes', branch,
        baseRef: 'main', baseSha: git(repoPath, 'rev-parse', 'main'), repoPath: registeredRepoPath,
      });
      await new Promise(resolve => setTimeout(resolve, 3));
      archiveLane(lane.id, 'system');
      const packet = {
        id: packetId, referenceLabel: packetId, title: packetId, summary: packetId,
        workspaceTargetPath: registeredRepoPath, branchTarget: branch, runtime: 'codex',
        dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending',
        status: 'archived', blockedReason: null, archivedAt: new Date().toISOString(),
        lastEventAt: new Date().toISOString(), lastEventLabel: 'finished_no_changes', review: null,
        lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, runtime: 'codex',
          repoPath: registeredRepoPath, worktreePath, sessionKey: surfaceId },
      } satisfies OrchestratorPacket;
      writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
        missionId: 'mission-' + packetId, repoPath: registeredRepoPath, packets: [packet] });
      expect(await lifecycle?.archiveSession(surfaceId)).toMatchObject({ archived: true });
      if (mode === 'user-archive') appendEvent(lane.id, 'status_change', 'user', { status: 'archived' });
      if (mode === 'changed-approval') recordOrchestratorReview(packetId, { approved: false, findings: [], reviewedHeadSha: reviewedHead });
      if (mode === 'session-conflict') mkdirSync(sessionDir);
      if (mode === 'metadata-failure') moduleResolution.failSessionWrite = true;
      if (mode === 'newer-intent') moduleResolution.beforeSessionWrite = () => {
        appendEvent(lane.id, 'status_change', 'user', { status: 'archived', reason: 'operator_keep_archived' });
      };
    }
    closeDb();
    const reboundLane = findLatestLaneByPacket(packetId)!;
    const parkedReview = await readLaneReviewDiff(reboundLane);
    expect(parkedReview).toMatchObject({
      headSha: reviewedHead,
      source: { kind: 'immutable_snapshot', mergeAvailable: false },
    });

    const restoreStartedAt = performance.now();
    const restored = await POST(post('restore', packetId, mode + '-restore-1'));
    const restoreDurationMs = Math.round(performance.now() - restoreStartedAt);
    const restoredBody = await restored.json();
    if (['user-archive', 'changed-approval', 'session-conflict', 'metadata-failure', 'newer-intent'].includes(mode)) {
      const partial = ['metadata-failure', 'newer-intent'].includes(mode);
      expect(restored.status, JSON.stringify(restoredBody)).toBe(409);
      expect(getWorkspaceSnapshot(repo.id, packetId)?.state, JSON.stringify(restoredBody)).toBe(partial ? 'restoring' : 'parked');
      expect(findLatestLaneByPacket(packetId)?.status).toBe('archived');
      expect((await POST(post('restore', packetId, mode + '-restore-1'))).status).toBe(409);
      if (partial) {
        expect((await POST(post('restore', packetId, mode + '-restore-2'))).status).toBe(409);
        expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('restoring');
        expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(reviewedHead);
        expect(readFileSync(transcriptPath, 'utf8')).toBe('{"type":"assistant","text":"original completed work"}\n');
        expect(readOrchestratorControlPlaneState().packets[0].status).toBe('archived');
        expect(listApprovalsForContext({ packetId })).toEqual(approvalsBefore);
      }
      return;
    }
    expect(restored.status, JSON.stringify(restoredBody)).toBe(200);
    if (recovery) {
      expect(findLatestLaneByPacket(packetId)).toMatchObject({ status: 'reviewing', worktreePath, sessionKey: surfaceId, outcome: null });
      expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ status: 'awaiting_review', archivedAt: null });
      expect(listApprovalsForContext({ packetId })).toEqual(approvalsBefore);
    }
    expect(restoredBody).toMatchObject({
      ok: true,
      result: { status: 'restored', state: 'materialized', reviewable: true },
    });
    closeDb();
    expect(getWorkspaceSnapshot(repo.id, packetId)).toMatchObject({
      state: 'materialized',
      headCommit: reviewedHead,
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
    expect(restoredSession.recentRuns).toEqual(session.recentRuns);
    expect(restoredSession.activeRun ?? null).toBeNull();
    expect(readFileSync(transcriptPath, 'utf8')).toBe('{"type":"assistant","text":"original completed work"}\n');
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
    const replayedRestore = await POST(post('restore', packetId, mode + '-restore-1'));
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
  }, 120_000);
});
