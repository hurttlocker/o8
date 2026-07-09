import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    process.env.O8_TEST_CHILD_EXIT_REPO = repoPath;
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());
  });

  afterEach(async () => {
    ensureDispatchBackendReadyMock.mockReset();
    if (priorRoot === undefined) delete process.env.O8_TEST_CHILD_EXIT_ROOT;
    else process.env.O8_TEST_CHILD_EXIT_ROOT = priorRoot;
    if (priorBin === undefined) delete process.env.O8_TEST_CHILD_EXIT_BIN;
    else process.env.O8_TEST_CHILD_EXIT_BIN = priorBin;
    delete process.env.O8_TEST_CHILD_EXIT_REPO;
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
  }, 20_000);

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
  }, 20_000);

  it('sweeps an old active owned session when no lane references its surface id', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter('exit-1'));
    const surfaceId = 'test-child-exit-1:orphan-active';
    await writeSession(surfaceId, 'orphan-active');

    await expect(store.sweepOrphanedSessions(new Set(), 120_000)).resolves.toBe(1);
    await expect(access(path.join(process.env.O8_TEST_CHILD_EXIT_ROOT!, 'orphan-active'))).rejects.toThrow();
    await expect(access(path.join(`${process.env.O8_TEST_CHILD_EXIT_ROOT!}-archive`, 'orphan-active', 'session.json'))).resolves.toBeUndefined();
  });

  it('keeps an old active owned session when a lane references its surface id', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter('exit-1'));
    const surfaceId = 'test-child-exit-1:lane-bound-active';
    await writeSession(surfaceId, 'lane-bound-active');

    await expect(store.sweepOrphanedSessions(new Set([surfaceId]), 120_000)).resolves.toBe(0);
    await expect(access(path.join(process.env.O8_TEST_CHILD_EXIT_ROOT!, 'lane-bound-active', 'session.json'))).resolves.toBeUndefined();
  });
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

async function writeSession(surfaceId: string, dirName: string): Promise<void> {
  const root = process.env.O8_TEST_CHILD_EXIT_ROOT;
  if (!root) throw new Error('missing O8_TEST_CHILD_EXIT_ROOT');
  const sessionDir = path.join(root, dirName);
  const runsDir = path.join(sessionDir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const old = new Date(Date.now() - 180_000).toISOString();
  const run = {
    id: 'old-run',
    mode: 'launch' as const,
    prompt: 'old prompt',
    startedAt: old,
    pid: 2_147_483_647,
    stdoutPath: path.join(runsDir, 'old-run.jsonl'),
    stderrPath: path.join(runsDir, 'old-run.stderr.log'),
    outcome: 'running' as const,
  };
  await writeFile(run.stdoutPath, 'estimated cost $0.23\n', 'utf8');
  await writeFile(run.stderrPath, '', 'utf8');
  const session: OwnedSessionRecord = {
    surfaceId,
    sessionDir,
    cwd: repoPathForTest(),
    repoPath: repoPathForTest(),
    title: 'orphan test',
    createdAt: old,
    updatedAt: old,
    latestPrompt: 'old prompt',
    latestSummary: 'old prompt',
    recentRuns: [run],
    activeRun: run,
  };
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
}

function repoPathForTest(): string {
  return process.env.O8_TEST_CHILD_EXIT_REPO ?? process.cwd();
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
