/**
 * #1524 — cold resume: an ARCHIVED owned session with a persisted threadId
 * must be resumable, not "session was not found".
 *
 * The incident: steer_packet (escalation layer 3) 409'd steer_unavailable
 * after a long pause / silent exit had archived the session dir — dead in
 * exactly the scenarios that produce escalations. The runtime's own rollout
 * lives outside our tree, so the thread is fully resumable: resume restores
 * the archived dir and resumes the saved thread, marked cold in the note.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// A pid above macOS/Linux pid_max — isPidAlive is guaranteed false, so the
// launched run reads as exited and resume is allowed.
const DEAD_PID = 9_999_999;

function coldAdapter(): OwnedRuntimeAdapter {
  return {
    runtimeId: 'test-runtime',
    surfaceIdPrefix: 'test-owned:',
    rootEnvVar: 'O8_TEST_OWNED_ROOT',
    rootDefault: path.join(os.tmpdir(), 'o8-test-owned-cold'),
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_BIN',
    humanLabel: 'Owned Test',
    squadShortName: 'Test',
    launchArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    resumeArgs: ({ threadId, prompt }) => ['resume', threadId, '-e', `console.log(${JSON.stringify(prompt)})`],
    parseRunLog: (): ParsedRunLog => ({
      entries: [],
      outcome: 'finished',
      completedTurn: true,
      threadId: 'thread-cold-1',
    }),
  };
}

describe('owned-session store cold resume (#1524)', () => {
  let tempRoot: string;
  let repoPath: string;
  let sessionsRoot: string;
  let priorRoot: string | undefined;
  let priorBin: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(process.cwd(), '.tmp-owned-cold-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    sessionsRoot = path.join(tempRoot, 'sessions');
    priorRoot = process.env.O8_TEST_OWNED_ROOT;
    priorBin = process.env.O8_TEST_BIN;
    process.env.O8_TEST_OWNED_ROOT = sessionsRoot;
    process.env.O8_TEST_BIN = process.execPath;
    spawnMock.mockReturnValue({ pid: DEAD_PID, unref: vi.fn(), once: vi.fn() });
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

  afterEach(() => {
    spawnMock.mockReset();
    ensureDispatchBackendReadyMock.mockReset();
    if (priorRoot === undefined) delete process.env.O8_TEST_OWNED_ROOT;
    else process.env.O8_TEST_OWNED_ROOT = priorRoot;
    if (priorBin === undefined) delete process.env.O8_TEST_BIN;
    else process.env.O8_TEST_BIN = priorBin;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resumes an archived session with a persisted threadId, restoring it and marking the resume cold', { timeout: 20_000 }, async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(coldAdapter());

    const launched = await store.launch({ cwd: repoPath, prompt: 'initial work' });
    expect(launched.ok).toBe(true);
    const surfaceId = launched.surfaceId!;

    // A refresh read discovers + persists the threadId from the run log
    // (exactly how real sessions learn theirs before dying).
    await store.getRuntimeTail(surfaceId);

    // The incident state: the run exited and cleanup archived the session dir.
    const archived = await store.archiveSession(surfaceId);
    expect(archived.archived).toBe(true);
    const activeDirs = existsSync(sessionsRoot)
      ? execFileSync('ls', [sessionsRoot]).toString().trim()
      : '';
    expect(activeDirs).toBe('');

    // Old behavior: throws "Owned Test session was not found."
    const resumed = await store.resume(surfaceId, 'one-line follow-up fix');
    expect(resumed.ok).toBe(true);
    expect(resumed.note).toContain('Cold resume');

    // The dir is back in the active tree and the runtime was invoked with the
    // persisted thread id.
    expect(execFileSync('ls', [sessionsRoot]).toString().trim()).not.toBe('');
    const resumeCall = spawnMock.mock.calls.at(-1);
    expect(resumeCall?.[1]).toContain('thread-cold-1');
  });

  it('still reports not-found when nothing exists in the archive either', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(coldAdapter());
    await expect(store.resume('test-owned:ghost-session', 'hello')).rejects.toThrow(/was not found/);
  });
});
