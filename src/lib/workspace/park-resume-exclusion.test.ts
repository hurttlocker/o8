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

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { Lane } from '@/lib/lane/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type {
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
  OwnedSessionStore,
  ParsedRunLog,
} from '@/lib/runtimes/shared/owned-session';
import type { OwnedWorkspaceSpawnGuard } from '@/lib/runtimes/shared/owned-session/workspace-spawn-guard';
import type { WorkspaceIsolationKind } from '@/lib/worktree/types';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: async () => ({
      ready: true,
      reason: 'http_200',
      waitedMs: 0,
      attempts: 1,
      lastCheck: {
        ready: true,
        reason: 'http_200',
        apiBase: 'http://o8.test',
        status: 200,
        portSource: 'file' as const,
        apiPortFilePresent: true,
      },
    }),
  };
});

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-park-resume-gate-db-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';

const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
const { registerOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { inspectOwnedWorkspaceMaterialization } = await import('./materialization-guard');
const { assertManagedWorkspaceMaterialization } = await import('./managed-materialization-identity');
const { parkWorkspace } = await import('./hibernator');
const { probeOwnedSessionProcessQuiescence } = await import('./process-probes');
const { scanWorkspaceStorageState } = await import('./storage-verifier');
const { parkExactWorktree } = await import('./worktree-exact');
const { closeDb } = await import('@/lib/db');

const roots: string[] = [];
const envKeys: string[] = [];
let sequence = 0;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function adapter(
  runtimeId: OwnedRuntimeAdapter['runtimeId'],
  prefix: string,
  rootEnvVar: string,
  binaryEnvOverride: string,
): OwnedRuntimeAdapter {
  return {
    runtimeId,
    surfaceIdPrefix: prefix,
    rootEnvVar,
    rootDefault: path.join(os.tmpdir(), runtimeId),
    binaryName: 'node',
    binaryEnvOverride,
    humanLabel: 'Owned workspace gate test',
    squadShortName: 'WorkspaceGate',
    launchArgs: () => ['-e', 'setInterval(() => {}, 1_000)'],
    resumeArgs: () => ['-e', 'setInterval(() => {}, 1_000)'],
    parseRunLog: (): ParsedRunLog => ({ entries: [], outcome: 'running', completedTurn: false }),
  };
}

function fixture(kind: WorkspaceIsolationKind, guard: OwnedWorkspaceSpawnGuard) {
  sequence += 1;
  const root = mkdtempSync(path.join(os.tmpdir(), `o8-park-resume-${kind}-`));
  roots.push(root);
  process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
  const repoPath = path.join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'o8-test@example.test');
  git(repoPath, 'config', 'user.name', 'o8 test');
  writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
  git(repoPath, 'add', '.gitignore', 'tracked.txt');
  git(repoPath, 'commit', '-qm', 'base');

  const repoId = `repo-park-resume-${sequence}`;
  const packetId = `packet-park-resume-${sequence}`;
  const worktreeId = `packet-${packetId}`;
  const worktreePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branch = `inline/${packetId}`;
  if (kind === 'git-worktree') {
    git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
  } else {
    git(repoPath, 'clone', '-q', '--local', '--no-checkout', repoPath, worktreePath);
    git(worktreePath, 'checkout', '-qb', branch, 'main');
  }
  writeFileSync(path.join(worktreePath, 'tracked.txt'), 'reviewed change\n');
  git(worktreePath, 'add', 'tracked.txt');
  git(worktreePath, 'commit', '-qm', 'packet work');

  const runtimeId = 'codex' as const;
  const surfacePrefix = `${runtimeId}-owned:`;
  const surfaceId = `${surfacePrefix}session`;
  const sessionRoot = path.join(root, 'sessions');
  const sessionDir = path.join(sessionRoot, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const rootEnvVar = `O8_TEST_PARK_RESUME_ROOT_${sequence}`;
  const binaryEnvOverride = `O8_TEST_PARK_RESUME_BIN_${sequence}`;
  process.env[rootEnvVar] = sessionRoot;
  process.env[binaryEnvOverride] = process.execPath;
  envKeys.push(rootEnvVar, binaryEnvOverride);
  const createdAt = new Date().toISOString();
  const session: OwnedSessionRecord = {
    surfaceId,
    packetId,
    sessionDir,
    cwd: worktreePath,
    repoPath: worktreePath,
    workspaceBinding: {
      logicalWorkspaceId: `packet:${packetId}`,
      repositoryUuid: repoId,
      packetId,
      cwd: worktreePath,
      version: 1,
      verifiedAt: createdAt,
    },
    title: 'workspace gate test',
    createdAt,
    updatedAt: createdAt,
    threadId: `thread-${sequence}`,
    latestPrompt: 'seed',
    latestSummary: 'seed',
    recentRuns: [],
    runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
  };
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
  writeFileSync(path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json'), JSON.stringify({
    version: 1,
    worktrees: {
      [worktreeId]: {
        id: worktreeId,
        agentType: runtimeId,
        sessionKey: surfaceId,
        baseBranch: 'main',
        createdAt: 1,
        claudeManaged: false,
        taskName: worktreeId,
        branchName: branch,
        status: 'ready',
        isolationKind: kind,
        materializationIdentity: {
          device: lstatSync(worktreePath).dev,
          inode: lstatSync(worktreePath).ino,
          canonicalPath: realpathSync(worktreePath),
        },
        materializationParentIdentity: {
          device: lstatSync(path.dirname(worktreePath)).dev,
          inode: lstatSync(path.dirname(worktreePath)).ino,
          canonicalPath: realpathSync(path.dirname(worktreePath)),
        },
      },
    },
  }));

  const repo: RepoRegistryEntry = {
    id: repoId,
    name: runtimeId,
    localPath: repoPath,
    remoteUrl: null,
    defaultBranch: 'main',
    addedAt: createdAt,
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy', envFiles: [], installCommand: null,
      installOnCreateWorkspace: false, buildCommand: null,
      runBuildOnCreateWorkspace: false, devCommand: null,
      defaultPort: null, workspaceIsolationPreference: kind,
    },
  };
  const lane: Lane = {
    id: `lane-${packetId}`,
    projectId: null,
    label: runtimeId,
    repoPath,
    worktreePath,
    branch,
    baseBranch: 'main',
    runtime: runtimeId,
    sessionKey: surfaceId,
    packetId,
    prNumber: null,
    status: 'reviewing',
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt,
    updatedAt: createdAt,
    lastEventAt: null,
    lastEventLabel: null,
  };
  const store = createOwnedSessionStore(
    adapter(runtimeId, surfacePrefix, rootEnvVar, binaryEnvOverride),
    { workspaceSpawnGuard: guard },
  );
  registerOwnedSessionLifecycle({
    runtimeId, surfaceIdPrefix: surfacePrefix, commandLabel: 'workspace-gate-test',
    rootEnvVar, rootDefault: sessionRoot, store,
  });
  return { repo, lane, worktreeId, worktreePath, packetId, surfaceId, store, sessionDir };
}

function dependencies(f: ReturnType<typeof fixture>) {
  return {
    listRepos: async () => [f.repo],
    findLaneByPacket: () => f.lane,
    processProbe: probeOwnedSessionProcessQuiescence,
    measureStorage: async (target: string) => ({
      availableBytes: existsSync(target) ? 1_000_000 : 2_000_000,
      logicalBytes: existsSync(target) ? 100_000 : null,
      measuredAt: '2026-08-15T00:00:00.000Z',
    }),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for concurrent workspace state.');
}

async function stopRun(store: OwnedSessionStore, surfaceId: string): Promise<void> {
  await store.interrupt(surfaceId).catch(() => null);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const binding = await store.getWorkspaceBinding?.(surfaceId);
    if (!binding?.activeRun) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const key of envKeys.splice(0)) delete process.env[key];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  delete process.env.O8_CRASH_SURVIVABLE_WORKERS;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('owned run and workspace parking exclusion', () => {
  it('refuses a normal pre-park resume after a same-HEAD path replacement', async () => {
    const guard: OwnedWorkspaceSpawnGuard = (input) => inspectOwnedWorkspaceMaterialization(input, {
      listRepos: async () => [f.repo],
      assertManagedWorkspaceMaterialization,
    });
    const f = fixture('apfs-cow-clone', guard);
    const retained = `${f.worktreePath}.retained`;
    renameSync(f.worktreePath, retained);
    git(path.dirname(f.worktreePath), 'clone', '-q', '--local', f.repo.localPath, f.worktreePath);
    writeFileSync(path.join(f.worktreePath, 'tracked.txt'), 'unrelated same-head occupant\n');

    await expect(f.store.resume(f.surfaceId, 'resume ordinary managed workspace')).resolves.toMatchObject({
      ok: false,
      sideEffect: 'none',
      note: expect.stringContaining('materialization ownership changed'),
    });
    const session = JSON.parse(
      readFileSync(path.join(f.sessionDir, 'session.json'), 'utf8'),
    ) as OwnedSessionRecord;
    expect(session.activeRun).toBeUndefined();
    expect(readFileSync(path.join(f.worktreePath, 'tracked.txt'), 'utf8'))
      .toBe('unrelated same-head occupant\n');
    expect(readFileSync(path.join(retained, 'tracked.txt'), 'utf8')).toBe('reviewed change\n');
  }, 30_000);

  it.each(['git-worktree', 'apfs-cow-clone'] as const)(
    'refuses a %s resume after the hibernating gate and removes the exact path',
    async (kind) => {
      const finalProof = deferred();
      const releaseRemoval = deferred();
      const f = fixture(kind, inspectOwnedWorkspaceMaterialization);
      let paused = false;
      const parkedPromise = parkWorkspace({
        repositoryUuid: f.repo.id,
        packetId: f.packetId,
        operationId: `gate-first-${kind}`,
      }, {
        ...dependencies(f),
        parkExact: (input) => parkExactWorktree({
          ...input,
          probeProcessQuiescence: async (sessionKey, workspacePath) => {
            const receipt = await input.probeProcessQuiescence(sessionKey, workspacePath);
            if (!paused) {
              paused = true;
              finalProof.resolve();
              await releaseRemoval.promise;
            }
            return receipt;
          },
        }),
      });

      await finalProof.promise;
      expect(getWorkspaceSnapshot(f.repo.id, f.packetId)).toMatchObject({ state: 'hibernating' });
      await expect(f.store.resume(f.surfaceId, 'resume after park gate')).resolves.toMatchObject({
        ok: false,
        sideEffect: 'none',
        note: expect.stringContaining('hibernating'),
      });
      const session = JSON.parse(readFileSync(path.join(f.sessionDir, 'session.json'), 'utf8')) as OwnedSessionRecord;
      expect(session.activeRun).toBeUndefined();
      expect(session.runIdentityLedger).toEqual({ version: 1, totalRuns: 0, complete: true });
      releaseRemoval.resolve();
      await expect(parkedPromise).resolves.toMatchObject({ status: 'parked', snapshot: { state: 'parked' } });
      expect(existsSync(f.worktreePath)).toBe(false);
    },
    30_000,
  );

  it.each(['git-worktree', 'apfs-cow-clone'] as const)(
    'retains the %s path when resume passes the materialized gate first',
    async (kind) => {
      const resumeGuardPassed = deferred();
      const releaseResume = deferred();
      const secondScanEntered = deferred();
      const releaseSecondScan = deferred();
      const finalProbeAttempted = deferred();
      let finalProbeCompleted = false;
      let processProbeCalls = 0;
      let pauseGuard = true;
      const guard: OwnedWorkspaceSpawnGuard = async (input) => {
        const decision = await inspectOwnedWorkspaceMaterialization(input, {
          listRepos: async () => [f.repo],
          assertManagedWorkspaceMaterialization,
        });
        if (pauseGuard && decision.status === 'available' && decision.source === 'materialized') {
          pauseGuard = false;
          resumeGuardPassed.resolve();
          await releaseResume.promise;
        }
        return decision;
      };
      const f = fixture(kind, guard);
      let secondScanCalls = 0;
      const parkedPromise = parkWorkspace({
        repositoryUuid: f.repo.id,
        packetId: f.packetId,
        operationId: `resume-first-${kind}`,
      }, {
        ...dependencies(f),
        processProbe: async (...args) => {
          processProbeCalls += 1;
          if (processProbeCalls === 2) finalProbeAttempted.resolve();
          const receipt = await probeOwnedSessionProcessQuiescence(...args);
          if (processProbeCalls === 2) finalProbeCompleted = true;
          return receipt;
        },
        secondScan: async (...args) => {
          const receipt = await scanWorkspaceStorageState(...args);
          secondScanCalls += 1;
          if (secondScanCalls === 1) {
            secondScanEntered.resolve();
            await releaseSecondScan.promise;
          }
          return receipt;
        },
      });

      await secondScanEntered.promise;
      const resumedPromise = f.store.resume(f.surfaceId, 'resume before park gate');
      await resumeGuardPassed.promise;
      releaseSecondScan.resolve();
      await waitUntil(() => getWorkspaceSnapshot(f.repo.id, f.packetId)?.state === 'hibernating');
      await finalProbeAttempted.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(finalProbeCompleted).toBe(false);
      releaseResume.resolve();
      await expect(resumedPromise).resolves.toMatchObject({ ok: true });
      await expect(parkedPromise).resolves.toMatchObject({ status: 'refused' });
      expect(existsSync(f.worktreePath)).toBe(true);
      expect(getWorkspaceSnapshot(f.repo.id, f.packetId)).toMatchObject({ state: 'materialized' });
      await stopRun(f.store, f.surfaceId);
    },
    60_000,
  );
});
