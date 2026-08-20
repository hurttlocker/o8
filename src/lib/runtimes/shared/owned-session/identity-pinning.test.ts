import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { OwnedWorkspaceSpawnGuard } from './workspace-spawn-guard';
import type { OwnedRuntimeAdapter, ParsedRunLog } from './types';

const spawnMock = vi.hoisted(() => vi.fn());
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn());
const bridgeSpawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return { ...actual, ensureDispatchBackendReady: ensureDispatchBackendReadyMock };
});

vi.mock('@/lib/runtime/pty-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/pty-bridge')>();
  return { ...actual, spawnBridgeTerminalSession: bridgeSpawnMock };
});

// Canonical from the start: the worktree root layout keys a repository by its
// realpath, so a /var vs /private/var temp dir would key the fixture two
// different ways either side of `mkdir`.
const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-identity-pinning-')));
const dataDir = path.join(tempRoot, 'data');
const sessionsRoot = path.join(dataDir, 'sessions');
const repoPath = path.join(dataDir, 'repo');
const identityAHome = path.join(tempRoot, 'identity-a');
const identityBHome = path.join(tempRoot, 'identity-b');
const DEAD_PID = 9_999_999;
const REPO_ID = 'repo-identity-pinning';
const WORKTREE_ID = 'packet-identity-pinning';

process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_TEST_IDENTITY_OWNED_ROOT = sessionsRoot;
process.env.O8_TEST_IDENTITY_BIN = process.execPath;

const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');

const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { inspectOwnedWorkspaceMaterialization } = await import('@/lib/workspace/materialization-guard');
const {
  assertManagedWorkspaceMaterialization,
} = await import('@/lib/workspace/managed-materialization-identity');

const workspacePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, WORKTREE_ID);

/**
 * The spawn guard consults the repo registry, which is empty under this
 * suite's isolated data dir. Inject the fixture repository the way production
 * registers one so the guard can prove managed ownership of the workspace and
 * the run reaches spawn — otherwise identity pinning is never exercised.
 */
const repo: RepoRegistryEntry = {
  id: REPO_ID,
  name: 'identity-pinning',
  localPath: repoPath,
  remoteUrl: null,
  defaultBranch: 'main',
  addedAt: new Date(0).toISOString(),
  lastOpenedAt: null,
  storagePressureParkingDisabled: false,
  setup: {
    envMode: 'copy',
    envFiles: [],
    installCommand: null,
    installOnCreateWorkspace: false,
    buildCommand: null,
    runBuildOnCreateWorkspace: false,
    devCommand: null,
    defaultPort: null,
    workspaceIsolationPreference: 'git-worktree',
  },
};

const workspaceSpawnGuard: OwnedWorkspaceSpawnGuard = (input) => (
  inspectOwnedWorkspaceMaterialization(input, {
    listRepos: async () => [repo],
    assertManagedWorkspaceMaterialization,
  })
);

function adapter(): OwnedRuntimeAdapter {
  return {
    runtimeId: 'test-identity',
    surfaceIdPrefix: 'test-identity-owned:',
    rootEnvVar: 'O8_TEST_IDENTITY_OWNED_ROOT',
    rootDefault: sessionsRoot,
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_IDENTITY_BIN',
    isolatedConfigHomeEnv: 'CODEX_HOME',
    defaultConfigHome: () => identityAHome,
    humanLabel: 'Owned Identity Test',
    squadShortName: 'Identity test',
    launchArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    resumeArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    parseRunLog: (): ParsedRunLog => ({
      entries: [],
      outcome: 'finished',
      completedTurn: true,
      threadId: 'thread-identity-test',
    }),
  };
}

/**
 * Only the owned runtime turn is stubbed. Everything else that spawns through
 * this suite — the materialization and worktree-metadata helper children — has
 * to reach the real `spawn`, so the owned turns are picked out by the run
 * marker rather than by call position.
 */
function childEnv(call: number): NodeJS.ProcessEnv {
  const ownedCalls = spawnMock.mock.calls.filter((entry) => (
    Boolean((entry[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env?.O8_OWNED_RUN_MARKER)
  ));
  return (ownedCalls[call]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env as NodeJS.ProcessEnv;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd });
}

beforeAll(() => {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'o8-test@example.test');
  git(repoPath, 'config', 'user.name', 'o8 test');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
  git(repoPath, 'add', 'tracked.txt');
  git(repoPath, 'commit', '-qm', 'base');

  mkdirSync(path.dirname(workspacePath), { recursive: true });
  git(repoPath, 'worktree', 'add', '-qb', 'inline/identity-pinning', workspacePath, 'main');
  writeFileSync(
    path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json'),
    JSON.stringify({
      version: 1,
      worktrees: {
        [WORKTREE_ID]: {
          id: WORKTREE_ID,
          agentType: 'test-identity',
          baseBranch: 'main',
          createdAt: 1,
          claudeManaged: false,
          taskName: WORKTREE_ID,
          branchName: 'inline/identity-pinning',
          status: 'ready',
          isolationKind: 'git-worktree',
          materializationIdentity: {
            device: lstatSync(workspacePath).dev,
            inode: lstatSync(workspacePath).ino,
            canonicalPath: realpathSync(workspacePath),
          },
          materializationParentIdentity: {
            device: lstatSync(path.dirname(workspacePath)).dev,
            inode: lstatSync(path.dirname(workspacePath)).ino,
            canonicalPath: realpathSync(path.dirname(workspacePath)),
          },
        },
      },
    }),
  );

  spawnMock.mockImplementation((command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => (
    options?.env?.O8_OWNED_RUN_MARKER
      ? { pid: DEAD_PID, unref: vi.fn(), once: vi.fn() }
      : realSpawn(command, args, options as Parameters<typeof realSpawn>[2])
  ));
  bridgeSpawnMock.mockRejectedValue(new Error('bridge intentionally unavailable'));
  ensureDispatchBackendReadyMock.mockResolvedValue({
    ready: true,
    reason: 'http_200',
    waitedMs: 0,
    attempts: 1,
    lastCheck: {
      ready: true,
      reason: 'http_200',
      apiBase: 'http://o8.test',
      status: 200,
      portSource: 'file',
      apiPortFilePresent: true,
    },
  });
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('owned-session identity pinning', () => {
  it('keeps A on resume after selecting B and uses B only for a new launch', async () => {
    const {
      registerRuntimeIdentity,
      resetRuntimeIdentityCatalogForTests,
      selectRuntimeIdentity,
    } = await import('@/lib/runtime/identity-catalog');
    const { createOwnedSessionStore } = await import('./store');
    resetRuntimeIdentityCatalogForTests();

    const identityA = await registerRuntimeIdentity({
      runtime: 'test-identity',
      label: 'Identity A',
      configHomeRef: identityAHome,
    });
    await selectRuntimeIdentity('test-identity', identityA.id);

    const store = createOwnedSessionStore(adapter(), { workspaceSpawnGuard });
    const launchedA = await store.launch({ cwd: workspacePath, prompt: 'launch under A', packetId: 'packet-a' });
    expect(launchedA).toMatchObject({ ok: true });
    expect(childEnv(0).CODEX_HOME).toBe(identityAHome);
    await store.getRuntimeTail(launchedA.surfaceId);

    const sessionDir = readdirSync(sessionsRoot).map((entry) => path.join(sessionsRoot, entry))[0];
    const persisted = JSON.parse(readFileSync(path.join(sessionDir, 'session.json'), 'utf8')) as {
      identity?: { id: string; configHomeRef: string };
    };
    expect(persisted.identity).toEqual(expect.objectContaining({
      id: identityA.id,
      configHomeRef: identityAHome,
    }));

    const identityB = await registerRuntimeIdentity({
      runtime: 'test-identity',
      label: 'Identity B',
      configHomeRef: identityBHome,
    });
    await selectRuntimeIdentity('test-identity', identityB.id);

    const catalogPath = path.join(dataDir, 'runtime-identities.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      identities: unknown[];
      packetBindings: Record<string, unknown>;
    };
    catalog.identities.reverse();
    catalog.packetBindings = {};
    writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');

    await store.resume(launchedA.surfaceId, 'resume A after selecting B');
    expect(childEnv(1).CODEX_HOME).toBe(identityAHome);

    await store.getRuntimeTail(launchedA.surfaceId);
    await store.launch({ cwd: workspacePath, prompt: 'retry packet A', packetId: 'packet-a' });
    expect(childEnv(2).CODEX_HOME).toBe(identityAHome);

    const launchedB = await store.launch({ cwd: workspacePath, prompt: 'new packet under B', packetId: 'packet-b' });
    expect(childEnv(3).CODEX_HOME).toBe(identityBHome);

    const publicFleet = JSON.stringify(await store.getFleetAdditions({ fresh: true }));
    expect(publicFleet).toContain(identityA.id);
    expect(publicFleet).not.toContain(identityAHome);
    expect(publicFleet).not.toContain(identityBHome);
    expect(publicFleet).not.toContain('Identity A');
    expect(publicFleet).not.toContain('Identity B');
    expect(launchedB.surfaceId).not.toBe(launchedA.surfaceId);
  });
});
