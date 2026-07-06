import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchBackendWaitResult } from '@/lib/runtimes/shared/dispatch-readiness';
import type { OwnedRuntimeAdapter, OwnedSessionRecord, ParsedRunLog } from './types';

const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

describe('createOwnedSessionStore child exit recording', () => {
  let tempRoot: string;
  let repoPath: string;
  let priorRoot: string | undefined;
  let priorBin: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(process.cwd(), '.tmp-owned-child-exit-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    priorRoot = process.env.O8_TEST_CHILD_EXIT_ROOT;
    priorBin = process.env.O8_TEST_CHILD_EXIT_BIN;
    process.env.O8_TEST_CHILD_EXIT_ROOT = path.join(tempRoot, 'sessions');
    process.env.O8_TEST_CHILD_EXIT_BIN = process.execPath;
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());
  });

  afterEach(async () => {
    ensureDispatchBackendReadyMock.mockReset();
    if (priorRoot === undefined) delete process.env.O8_TEST_CHILD_EXIT_ROOT;
    else process.env.O8_TEST_CHILD_EXIT_ROOT = priorRoot;
    if (priorBin === undefined) delete process.env.O8_TEST_CHILD_EXIT_BIN;
    else process.env.O8_TEST_CHILD_EXIT_BIN = priorBin;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('records nonzero exit code and stderr tail from the real runner child', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter('exit-1'));

    const launched = await store.launch({ cwd: repoPath, prompt: 'exit 1' });
    const session = await waitForRecordedExit(launched.surfaceId);
    const run = session.recentRuns[0];

    expect(run.childExit).toMatchObject({
      code: 1,
      signal: null,
      classification: 'nonzero-exit',
    });
    expect(run.childExit?.stderrTail).toContain('rmcp session-delete 404');
  }, 15_000);

  it('records SIGKILL signal and stderr tail from the real runner child', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter('sigkill'));

    const launched = await store.launch({ cwd: repoPath, prompt: 'sigkill' });
    const session = await waitForRecordedExit(launched.surfaceId);
    const run = session.recentRuns[0];

    expect(run.childExit).toMatchObject({
      code: null,
      signal: 'SIGKILL',
      classification: 'signal-kill',
    });
    expect(run.childExit?.stderrTail).toContain('rmcp session-delete 404');
  }, 15_000);
});

function testAdapter(kind: 'exit-1' | 'sigkill'): OwnedRuntimeAdapter {
  return {
    runtimeId: `test-child-${kind}`,
    surfaceIdPrefix: `test-child-${kind}:`,
    rootEnvVar: 'O8_TEST_CHILD_EXIT_ROOT',
    rootDefault: path.join(os.tmpdir(), 'o8-test-child-exit'),
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_CHILD_EXIT_BIN',
    humanLabel: 'Owned Child Exit Test',
    squadShortName: 'ChildExit',
    launchArgs: () => ['-e', childScript(kind)],
    resumeArgs: () => ['-e', childScript(kind)],
    parseRunLog: (): ParsedRunLog => ({
      entries: [],
      outcome: 'running',
      completedTurn: false,
    }),
  };
}

function childScript(kind: 'exit-1' | 'sigkill') {
  const stderrLine = 'rmcp session-delete 404 from fake child\\n';
  if (kind === 'exit-1') {
    return `process.stderr.write(${JSON.stringify(stderrLine)}); process.exit(1);`;
  }
  return `process.stderr.write(${JSON.stringify(stderrLine)}); process.stderr.write('', () => process.kill(process.pid, 'SIGKILL'));`;
}

async function waitForRecordedExit(surfaceId: string): Promise<OwnedSessionRecord> {
  const root = process.env.O8_TEST_CHILD_EXIT_ROOT;
  if (!root) throw new Error('missing O8_TEST_CHILD_EXIT_ROOT');

  for (let i = 0; i < 400; i += 1) {
    const sessionId = surfaceId.split(':')[1];
    const sessionPath = sessionId ? path.join(root, sessionId, 'session.json') : '';
    const raw = sessionPath ? await readFile(sessionPath, 'utf8').catch(() => '') : '';
    if (raw) {
      const parsed = JSON.parse(raw) as OwnedSessionRecord;
      if (parsed.recentRuns[0]?.childExit) return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for child exit payload on ${surfaceId}`);
}

function readyResult(): DispatchBackendWaitResult {
  return {
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
  };
}
