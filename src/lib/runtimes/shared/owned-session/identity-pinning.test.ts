import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-identity-pinning-'));
const dataDir = path.join(tempRoot, 'data');
const sessionsRoot = path.join(dataDir, 'sessions');
const repoPath = path.join(dataDir, 'repo');
const identityAHome = path.join(tempRoot, 'identity-a');
const identityBHome = path.join(tempRoot, 'identity-b');
const DEAD_PID = 9_999_999;

process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_TEST_IDENTITY_OWNED_ROOT = sessionsRoot;
process.env.O8_TEST_IDENTITY_BIN = process.execPath;

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

function childEnv(call: number): NodeJS.ProcessEnv {
  return spawnMock.mock.calls[call]?.[2]?.env as NodeJS.ProcessEnv;
}

beforeAll(() => {
  execFileSync('git', ['init', '-q', repoPath]);
  spawnMock.mockReturnValue({ pid: DEAD_PID, unref: vi.fn(), once: vi.fn() });
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

    const store = createOwnedSessionStore(adapter());
    const launchedA = await store.launch({ cwd: repoPath, prompt: 'launch under A', packetId: 'packet-a' });
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
    await store.launch({ cwd: repoPath, prompt: 'retry packet A', packetId: 'packet-a' });
    expect(childEnv(2).CODEX_HOME).toBe(identityAHome);

    const launchedB = await store.launch({ cwd: repoPath, prompt: 'new packet under B', packetId: 'packet-b' });
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
