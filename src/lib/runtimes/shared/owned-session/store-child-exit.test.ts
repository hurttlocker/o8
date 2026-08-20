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
  let priorSandbox: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(process.cwd(), '.tmp-owned-child-exit-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    priorRoot = process.env.O8_TEST_CHILD_EXIT_ROOT;
    priorBin = process.env.O8_TEST_CHILD_EXIT_BIN;
    priorSandbox = process.env.O8_WORKER_SANDBOX;
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
    if (priorSandbox === undefined) delete process.env.O8_WORKER_SANDBOX;
    else process.env.O8_WORKER_SANDBOX = priorSandbox;
    delete process.env.O8_TEST_CHILD_EXIT_REPO;
    delete process.env.O8_TEST_SANDBOX_DENIED_PATH;
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

  it.skipIf(process.platform !== 'darwin')('persists a readable lane event from a real sandbox-exec denial', async () => {
    const deniedPath = path.join(tempRoot, 'outside-packet.txt');
    await writeFile(deniedPath, 'must stay outside the packet\n', 'utf8');
    process.env.O8_WORKER_SANDBOX = '1';
    process.env.O8_TEST_CHILD_EXIT_BIN = '/bin/cat';
    process.env.O8_TEST_SANDBOX_DENIED_PATH = deniedPath;

    const [{ createLane, getLaneEvents }, { createOwnedSessionStore }] = await Promise.all([
      import('@/lib/lane/registry'),
      import('./store'),
    ]);
    const packetId = `pkt-sandbox-denial-${Date.now()}`;
    execFileSync('git', [
      '-c', 'user.email=test@o8.test',
      '-c', 'user.name=o8-test',
      'commit', '--allow-empty', '-m', 'seed',
    ], { cwd: repoPath });
    const worktreeBase = path.join(repoPath, '.cortex-worktrees');
    const worktreePath = path.join(worktreeBase, packetId);
    const branch = `agent/${packetId}`;
    await mkdir(worktreeBase, { recursive: true });
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: repoPath });
    const [{ addRepo }, { captureWorktreeMaterializationIdentity }, { withWorktreeMetaTransaction }] = await Promise.all([
      import('@/lib/repos/registry'),
      import('@/lib/worktree/materialization-identity'),
      import('@/lib/worktree/metadata-store'),
    ]);
    await addRepo(repoPath);
    const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
    const materializationParentIdentity = await captureWorktreeMaterializationIdentity(worktreeBase);
    await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(packetId, {
      id: packetId,
      agentType: 'codex',
      baseBranch: 'main',
      createdAt: Date.now(),
      claudeManaged: false,
      taskName: 'sandbox denial real path',
      branchName: branch,
      status: 'ready',
      isolationKind: 'git-worktree',
      materializationIdentity,
      materializationParentIdentity,
    }));
    const lane = createLane({
      label: 'sandbox denial real path',
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    const store = createOwnedSessionStore(testAdapter('sandbox-denial'));

    const launched = await store.launch({
      cwd: worktreePath,
      prompt: 'attempt denied read',
      laneId: lane.id,
      packetId,
    });
    const session = await waitForRecordedExit(launched.surfaceId);
    const denialEvent = await waitForLaneEvent(lane.id, 'sandbox_denied', getLaneEvents);

    expect(session.recentRuns[0]).toMatchObject({
      sandboxed: true,
      sandboxDenial: { operation: 'file-read', resource: deniedPath },
    });
    expect(session.latestSummary).toContain(`blocked file-read access to ${deniedPath}`);
    expect(denialEvent.payload).toMatchObject({ operation: 'file-read', resource: deniedPath });
    expect(denialEvent.payload.message).toContain(`blocked file-read access to ${deniedPath}`);
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

function testAdapter(kind: 'exit-1' | 'sigkill' | 'sandbox-denial'): OwnedRuntimeAdapter {
  return {
    runtimeId: `test-child-${kind}`,
    surfaceIdPrefix: `test-child-${kind}:`,
    rootEnvVar: 'O8_TEST_CHILD_EXIT_ROOT',
    rootDefault: path.join(os.tmpdir(), 'o8-test-child-exit'),
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_CHILD_EXIT_BIN',
    humanLabel: 'Owned Child Exit Test',
    squadShortName: 'ChildExit',
    launchArgs: () => kind === 'sandbox-denial'
      ? [process.env.O8_TEST_SANDBOX_DENIED_PATH ?? '/missing-denial-path']
      : ['-e', childScript(kind)],
    resumeArgs: () => kind === 'sandbox-denial'
      ? [process.env.O8_TEST_SANDBOX_DENIED_PATH ?? '/missing-denial-path']
      : ['-e', childScript(kind)],
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

async function waitForLaneEvent(
  laneId: string,
  verb: string,
  getLaneEvents: (id: string, limit?: number) => Array<{ verb: string; payload: Record<string, unknown> }>,
) {
  for (let i = 0; i < 400; i += 1) {
    const event = getLaneEvents(laneId, 20).find((candidate) => candidate.verb === verb);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${verb} lane event on ${laneId}`);
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
