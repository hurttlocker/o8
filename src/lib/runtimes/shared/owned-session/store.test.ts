import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchBackendWaitResult } from '@/lib/runtimes/shared/dispatch-readiness';
import type { OwnedRuntimeAdapter, ParsedRunLog } from './types';

const spawnMock = vi.hoisted(() => vi.fn());
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

describe('createOwnedSessionStore launch readiness gate', () => {
  let tempRoot: string;
  let repoPath: string;
  let priorRoot: string | undefined;
  let priorBin: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(process.cwd(), '.tmp-owned-store-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    priorRoot = process.env.O8_TEST_OWNED_ROOT;
    priorBin = process.env.O8_TEST_BIN;
    process.env.O8_TEST_OWNED_ROOT = path.join(tempRoot, 'sessions');
    process.env.O8_TEST_BIN = process.execPath;
    spawnMock.mockReturnValue({ pid: 42, unref: vi.fn(), once: vi.fn() });
    ensureDispatchBackendReadyMock.mockReset();
  });

  afterEach(() => {
    spawnMock.mockReset();
    if (priorRoot === undefined) delete process.env.O8_TEST_OWNED_ROOT;
    else process.env.O8_TEST_OWNED_ROOT = priorRoot;
    if (priorBin === undefined) delete process.env.O8_TEST_BIN;
    else process.env.O8_TEST_BIN = priorBin;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not spawn the worker until the readiness wait completes warm', { timeout: 20_000 }, async () => {
    const { createOwnedSessionStore } = await import('./store');
    let releaseReady: ((result: DispatchBackendWaitResult) => void) | undefined;
    ensureDispatchBackendReadyMock.mockReturnValue(new Promise((resolve) => {
      releaseReady = resolve;
    }));

    const store = createOwnedSessionStore(testAdapter());
    const launched = store.launch({ cwd: repoPath, prompt: 'do work' });

    await waitUntil(() => ensureDispatchBackendReadyMock.mock.calls.length === 1);
    expect(spawnMock).not.toHaveBeenCalled();

    releaseReady?.({
      ready: true,
      reason: 'http_200',
      waitedMs: 4_000,
      attempts: 3,
      lastCheck: {
        ready: true,
        reason: 'http_200',
        apiBase: 'http://o8.test',
        status: 200,
        portSource: 'file',
        apiPortFilePresent: true,
      },
    });

    await expect(launched).resolves.toMatchObject({ ok: true, runtime: 'test-runtime' });
    expect(ensureDispatchBackendReadyMock).toHaveBeenCalledWith('test-runtime', 'launch');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('returns a failed launch with an install hint when the worker CLI is missing', async () => {
    const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
    const { createOwnedSessionStore } = await import('./store');
    delete process.env.O8_TEST_BIN;
    invalidateCliCache('test-runtime');
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

    const store = createOwnedSessionStore(testAdapter('o8-definitely-missing-worker-cli'));
    const result = await store.launch({ cwd: repoPath, prompt: 'do work' });

    expect(result.ok).toBe(false);
    expect(result.note).toContain('[runtime] Owned Test is not installed');
    expect(result.note).toContain('o8-definitely-missing-worker-cli');
    expect(result.note).not.toContain('ENOENT');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

function testAdapter(binaryName = 'node'): OwnedRuntimeAdapter {
  return {
    runtimeId: 'test-runtime',
    surfaceIdPrefix: 'test-owned:',
    rootEnvVar: 'O8_TEST_OWNED_ROOT',
    rootDefault: path.join(os.tmpdir(), 'o8-test-owned-store'),
    binaryName,
    binaryEnvOverride: 'O8_TEST_BIN',
    humanLabel: 'Owned Test',
    squadShortName: 'Test',
    launchArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    resumeArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    parseRunLog: (): ParsedRunLog => ({
      entries: [],
      outcome: 'running',
      completedTurn: false,
    }),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 4000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for predicate');
}
