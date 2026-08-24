import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Lane } from '@/lib/lane/types';
import type { OwnedRuntimeAdapter, ParsedRunLog } from '@/lib/runtimes/shared/owned-session';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: async () => ({
      ready: true, reason: 'http_200', waitedMs: 0, attempts: 1,
      lastCheck: {
        ready: true, reason: 'http_200', apiBase: 'http://o8.test', status: 200,
        portSource: 'file' as const, apiPortFilePresent: true,
      },
    }),
  };
});

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-replacement-owned-launch-db-'));
const root = path.join(realpathSync(dataDir), 'workspace-root');
mkdirSync(root);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.O8_REPLACEMENT_TEST_NODE = process.execPath;
process.env.O8_REPLACEMENT_TEST_SESSIONS = path.join(root, 'sessions');
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';

const { closeDb } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const {
  createWorkspaceSnapshot,
  getWorkspaceSnapshot,
  transitionWorkspaceSnapshot,
} = await import('@/lib/worktree/snapshot-state');
const {
  ensureWorkspaceRecoveryRef,
  readImmutableWorkspaceTruth,
} = await import('./hibernator');
const { inspectOwnedWorkspaceMaterialization } = await import('./materialization-guard');
const {
  beginWorkspaceMaterializationRetirement,
  finishWorkspaceMaterializationRetirement,
} = await import('./workspace-materialization-retirement');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function transition(
  repositoryUuid: string,
  packetId: string,
  expectedState: 'materialized' | 'parkable' | 'hibernating',
  expectedVersion: number,
  toState: 'parkable' | 'hibernating' | 'parked',
) {
  const result = transitionWorkspaceSnapshot({
    repositoryUuid,
    packetId,
    transitionId: `replacement-owned-${toState}`,
    expectedState,
    expectedVersion,
    toState,
  });
  if (result.status !== 'applied') throw new Error(`Could not transition replacement fixture to ${toState}.`);
  return result.record;
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('parked replacement through the production owned launch guard', { timeout: 15_000 }, () => {
  it('durably materializes the exact replacement generation before a child starts', async () => {
    const repoPath = path.join(root, 'repo');
    mkdirSync(repoPath);
    git(repoPath, 'init', '-q', '-b', 'main');
    git(repoPath, 'config', 'user.email', 'o8-test@example.test');
    git(repoPath, 'config', 'user.name', 'o8 test');
    writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
    git(repoPath, 'add', 'tracked.txt');
    git(repoPath, 'commit', '-qm', 'base');
    const repo = await addRepo(repoPath);
    const packetId = 'replacement-owned-packet';
    const branch = 'inline/replacement-owned';
    const worktreeId = `packet-${packetId}`;
    const worktreePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
    writeFileSync(path.join(worktreePath, 'tracked.txt'), 'prior reviewed work\n');
    git(worktreePath, 'add', 'tracked.txt');
    git(worktreePath, 'commit', '-qm', 'prior reviewed work');
    const priorLane: Lane = {
      id: 'replacement-prior-lane', projectId: null, label: 'prior', repoPath,
      worktreePath, branch, baseBranch: 'main', runtime: 'codex',
      sessionKey: 'replacement-prior-session', packetId, prNumber: null,
      status: 'reviewing', ownership: 'managed', writerToken: null,
      lastHeartbeatAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      lastEventAt: null, lastEventLabel: null,
    };
    const priorTruth = await readImmutableWorkspaceTruth(repo, priorLane);
    await ensureWorkspaceRecoveryRef(repoPath, worktreePath, priorTruth);
    let snapshot = createWorkspaceSnapshot({
      repositoryUuid: repo.id, packetId, laneId: priorLane.id, originalPath: worktreePath,
      branch, baseCommit: priorTruth.baseCommit, headCommit: priorTruth.headCommit,
      treeSha: priorTruth.treeSha, recoveryRef: priorTruth.recoveryRef,
      diffFingerprint: priorTruth.diffFingerprint, sessionIdentities: [],
      creationId: 'replacement-owned-generation-one',
    }).record;
    snapshot = transition(repo.id, packetId, 'materialized', snapshot.version, 'parkable');
    snapshot = transition(repo.id, packetId, 'parkable', snapshot.version, 'hibernating');
    transition(repo.id, packetId, 'hibernating', snapshot.version, 'parked');
    git(repoPath, 'worktree', 'remove', worktreePath);
    git(repoPath, 'branch', '-D', branch);
    git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
    writeFileSync(path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {
        [worktreeId]: {
          id: worktreeId, agentType: 'codex', baseBranch: 'main', createdAt: 2,
          claudeManaged: false, taskName: worktreeId, branchName: branch,
          status: 'ready', isolationKind: 'git-worktree',
          materializationIdentity: {
            device: lstatSync(worktreePath).dev,
            inode: lstatSync(worktreePath).ino,
            canonicalPath: realpathSync(worktreePath),
          },
        },
      },
    }));
    const lane = createLane({
      repoPath, branch, baseBranch: 'main', runtime: 'codex', label: 'replacement',
      packetId, worktreePath, ownership: 'managed', actor: 'orchestrator',
    });
    setLaneStatus(lane.id, 'launching', 'orchestrator', 'replacement_prelaunch');
    const resumedProviderSentinel = path.join(root, 'resumed-provider-started');
    const adapter: OwnedRuntimeAdapter = {
      runtimeId: 'codex', surfaceIdPrefix: 'replacement-owned:',
      rootEnvVar: 'O8_REPLACEMENT_TEST_SESSIONS', rootDefault: path.join(root, 'sessions'),
      binaryName: 'node', binaryEnvOverride: 'O8_REPLACEMENT_TEST_NODE',
      humanLabel: 'Replacement launch test', squadShortName: 'Replacement',
      launchArgs: () => ['-e', 'setInterval(() => {}, 1000)'],
      resumeArgs: () => [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(resumedProviderSentinel)}, 'started');`,
      ],
      parseRunLog: (): ParsedRunLog => ({
        threadId: 'replacement-thread',
        entries: [],
        outcome: 'running',
        completedTurn: false,
      }),
    };
    const retained = path.join(root, 'manager-owned-replacement');
    let swapBeforeResumeSpawn = false;
    const store = createOwnedSessionStore(adapter, {
      workspaceSpawnGuard: async (input) => {
        const decision = await inspectOwnedWorkspaceMaterialization(input);
        if (swapBeforeResumeSpawn && input.mode === 'resume' && decision.status === 'available') {
          swapBeforeResumeSpawn = false;
          renameSync(worktreePath, retained);
          git(repoPath, 'clone', '-q', '--local', '--no-checkout', repoPath, worktreePath);
          git(worktreePath, 'checkout', '-q', '-B', branch, git(retained, 'rev-parse', 'HEAD'));
        }
        return decision;
      },
    });

    const result = await store.launch({
      cwd: worktreePath,
      prompt: 'replacement launch proof',
      laneId: lane.id,
      packetId,
    });
    expect(result.ok, result.note).toBe(true);
    expect(getWorkspaceSnapshot(repo.id, packetId)).toMatchObject({
      state: 'materialized', snapshotGeneration: 2, laneId: lane.id, originalPath: worktreePath,
    });
    await store.interrupt(result.surfaceId);
    swapBeforeResumeSpawn = true;
    const resumed = await store.resume(result.surfaceId, 'must not reach a replacement workspace');
    expect(resumed.ok).toBe(true);
    const telemetry = await store.getTelemetrySources(result.surfaceId);
    const resumedStdoutPath = telemetry?.stdoutPaths.at(-1);
    expect(resumedStdoutPath).toBeTruthy();
    const resumedStderrPath = resumedStdoutPath!.replace(/\.jsonl$/, '.stderr.log');
    let stderr = '';
    for (let attempt = 0; attempt < 100 && !stderr.includes('Managed workspace ownership changed'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stderr = existsSync(resumedStderrPath) ? readFileSync(resumedStderrPath, 'utf8') : '';
    }
    expect(stderr).toContain('Managed workspace ownership changed before process execution');
    expect(existsSync(resumedProviderSentinel)).toBe(false);
  });

  it('materializes a new-path replacement after confirmed cleanup retirement', async () => {
    const repoPath = path.join(root, 'repo-retired-replacement');
    mkdirSync(repoPath);
    git(repoPath, 'init', '-q', '-b', 'main');
    git(repoPath, 'config', 'user.email', 'o8-test@example.test');
    git(repoPath, 'config', 'user.name', 'o8 test');
    writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
    git(repoPath, 'add', 'tracked.txt');
    git(repoPath, 'commit', '-qm', 'base');
    const repo = await addRepo(repoPath);
    const packetId = 'retired-replacement-packet';
    const branch = 'inline/retired-replacement';
    const worktreeRoot = resolveWorktreeRootLayout(repoPath).primaryBase;
    const oldWorktreePath = path.join(worktreeRoot, `packet-${packetId}-old`);
    mkdirSync(path.dirname(oldWorktreePath), { recursive: true });
    git(repoPath, 'worktree', 'add', '-qb', branch, oldWorktreePath, 'main');
    const priorLane: Lane = {
      id: 'retired-replacement-prior-lane', projectId: null, label: 'prior', repoPath,
      worktreePath: oldWorktreePath, branch, baseBranch: 'main', runtime: 'codex',
      sessionKey: 'retired-replacement-prior-session', packetId, prNumber: null,
      status: 'reviewing', ownership: 'managed', writerToken: null,
      lastHeartbeatAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      lastEventAt: null, lastEventLabel: null,
    };
    const priorTruth = await readImmutableWorkspaceTruth(repo, priorLane);
    await ensureWorkspaceRecoveryRef(repoPath, oldWorktreePath, priorTruth);
    createWorkspaceSnapshot({
      repositoryUuid: repo.id, packetId, laneId: priorLane.id, originalPath: oldWorktreePath,
      branch, baseCommit: priorTruth.baseCommit, headCommit: priorTruth.headCommit,
      treeSha: priorTruth.treeSha, recoveryRef: priorTruth.recoveryRef,
      diffFingerprint: priorTruth.diffFingerprint, sessionIdentities: [],
      creationId: 'retired-replacement-generation-one',
    });
    beginWorkspaceMaterializationRetirement(oldWorktreePath, 'cleanup');
    git(repoPath, 'worktree', 'remove', oldWorktreePath);
    git(repoPath, 'branch', '-D', branch);
    await finishWorkspaceMaterializationRetirement(oldWorktreePath, 'cleanup');
    expect(getWorkspaceSnapshot(repo.id, packetId)).toMatchObject({ state: 'retired' });

    const replacementId = `packet-${packetId}-next`;
    const replacementPath = path.join(worktreeRoot, replacementId);
    git(repoPath, 'worktree', 'add', '-qb', branch, replacementPath, 'main');
    writeFileSync(path.join(worktreeRoot, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {
        [replacementId]: {
          id: replacementId, agentType: 'codex', baseBranch: 'main', createdAt: 2,
          claudeManaged: false, taskName: replacementId, branchName: branch,
          status: 'ready', isolationKind: 'git-worktree',
          materializationIdentity: {
            device: lstatSync(replacementPath).dev,
            inode: lstatSync(replacementPath).ino,
            canonicalPath: realpathSync(replacementPath),
          },
        },
      },
    }));
    const lane = createLane({
      repoPath, branch, baseBranch: 'main', runtime: 'codex', label: 'replacement',
      packetId, worktreePath: replacementPath, ownership: 'managed', actor: 'orchestrator',
    });
    setLaneStatus(lane.id, 'launching', 'orchestrator', 'replacement_prelaunch');
    const adapter: OwnedRuntimeAdapter = {
      runtimeId: 'codex', surfaceIdPrefix: 'retired-replacement:',
      rootEnvVar: 'O8_REPLACEMENT_TEST_SESSIONS', rootDefault: path.join(root, 'sessions'),
      binaryName: 'node', binaryEnvOverride: 'O8_REPLACEMENT_TEST_NODE',
      humanLabel: 'Retired replacement test', squadShortName: 'Replacement',
      launchArgs: () => ['-e', 'setInterval(() => {}, 1000)'],
      resumeArgs: () => ['-e', 'setInterval(() => {}, 1000)'],
      parseRunLog: (): ParsedRunLog => ({
        threadId: 'retired-replacement-thread', entries: [], outcome: 'running', completedTurn: false,
      }),
    } as OwnedRuntimeAdapter;
    const store = createOwnedSessionStore(adapter, {
      workspaceSpawnGuard: inspectOwnedWorkspaceMaterialization,
    });

    const result = await store.launch({
      cwd: replacementPath,
      prompt: 'retired replacement launch proof',
      laneId: lane.id,
      packetId,
    });

    expect(result.ok, result.note).toBe(true);
    expect(getWorkspaceSnapshot(repo.id, packetId)).toMatchObject({
      state: 'materialized', snapshotGeneration: 2,
      laneId: lane.id, originalPath: replacementPath,
    });
    await store.interrupt(result.surfaceId);
  });
});
