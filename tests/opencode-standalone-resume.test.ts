/**
 * OpenCode workers run with `--standalone` on both launch and resume
 * (commit c29e46457 added it to `launchArgs`/`resumeArgs` in
 * src/lib/opencode/owned.ts): no shared resident service holds the packet
 * worktree while a worker is dispatched. `owned.test.ts` already proves the
 * pure `launchArgs()`/`resumeArgs()` builders render `--standalone` — this
 * test proves the flag actually reaches the spawned process through the REAL
 * owned-session launch/resume path (createOwnedSessionStore + the real
 * `opencodeAdapter`), and that resume still works when the persisted thread
 * id was discovered from a genuine run log parsed by the real adapter.
 *
 * It also proves the resident-service surface is never touched: `spawn` is
 * mocked at the `node:child_process` boundary, so every process the launch
 * and resume turns start is captured. Architecturally, the resident-service
 * release path (`releaseOpenCodeWorkspace` in
 * src/lib/opencode/service-lifecycle.ts, which the fixture in
 * tests/helpers/opencode-service-fixture.ts drives for
 * tests/close-packet-unmerged.test.ts) is only ever imported from
 * src/lib/orchestrator/runtime-worktree-cleanup.ts — never from the
 * owned-session store or run-controller — so this test asserts the negative
 * directly against the captured spawn calls rather than needing that
 * fixture's `service status` / `/api/debug/location` stub surface.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
// launched run reads as exited and resume is allowed (same trick as
// store-cold-resume.test.ts).
const DEAD_PID = 9_999_999;
const REAL_THREAD_ID = 'ses_standalone_test';

function findLatestRunLog(sessionsRoot: string): string {
  const sessionDirs = readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sessionsRoot, entry.name));
  if (sessionDirs.length !== 1) {
    throw new Error(`Expected exactly one owned-opencode session dir, found ${sessionDirs.length}.`);
  }
  const runsDir = path.join(sessionDirs[0], 'runs');
  const runFiles = readdirSync(runsDir).filter((name) => name.endsWith('.jsonl'));
  if (runFiles.length !== 1) {
    throw new Error(`Expected exactly one run log, found ${runFiles.length}.`);
  }
  return path.join(runsDir, runFiles[0]);
}

describe('OpenCode 2 owned adapter — standalone resume (real path)', () => {
  let tempRoot: string;
  let repoPath: string;
  let sessionsRoot: string;
  let priorRoot: string | undefined;
  let priorBin: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(process.cwd(), '.tmp-opencode-standalone-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    sessionsRoot = path.join(tempRoot, 'sessions');
    priorRoot = process.env.O8_OWNED_OPENCODE_ROOT;
    priorBin = process.env.O8_OPENCODE_BIN;
    process.env.O8_OWNED_OPENCODE_ROOT = sessionsRoot;
    // A real, existing binary so cli-resolver's env-override probe succeeds
    // (it shells out `<bin> --version`, which real `node` answers fine) —
    // spawn itself is mocked, so this path is never actually executed.
    process.env.O8_OPENCODE_BIN = process.execPath;
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
    if (priorRoot === undefined) delete process.env.O8_OWNED_OPENCODE_ROOT;
    else process.env.O8_OWNED_OPENCODE_ROOT = priorRoot;
    if (priorBin === undefined) delete process.env.O8_OPENCODE_BIN;
    else process.env.O8_OPENCODE_BIN = priorBin;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it(
    'launches and resumes with --standalone on both turns, and never spawns the resident service',
    { timeout: 20_000 },
    async () => {
      const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
      const { opencodeAdapter } = await import('@/lib/opencode/owned');
      const store = createOwnedSessionStore(opencodeAdapter);

      const launched = await store.launch({ cwd: repoPath, prompt: 'fix the bug' });
      expect(launched.ok).toBe(true);
      const surfaceId = launched.surfaceId;

      const launchCall = spawnMock.mock.calls.at(-1);
      const launchArgs = launchCall?.[1] as string[];
      expect(launchArgs).toEqual(expect.arrayContaining(['--standalone', '--auto']));
      expect(launchArgs).toContain('run');

      // Seed the run log the way the real `opencode2 run --standalone` binary
      // would have — a genuine sessionID line the REAL (unmocked)
      // opencodeAdapter.parseRunLog extracts a thread id from, exactly like
      // production reads it off disk. Nothing here is faked at the adapter
      // boundary; only the OS process itself is mocked.
      const runLogPath = findLatestRunLog(sessionsRoot);
      writeFileSync(runLogPath, [
        JSON.stringify({ type: 'step_start', sessionID: REAL_THREAD_ID }),
        JSON.stringify({ type: 'text', part: { text: 'done' } }),
        JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }),
      ].join('\n'), 'utf8');

      // A refresh read discovers + persists the threadId from the run log.
      await store.getRuntimeTail(surfaceId);

      const resumed = await store.resume(surfaceId, 'continue the fix');
      expect(resumed.ok).toBe(true);

      const resumeCall = spawnMock.mock.calls.at(-1);
      const resumeArgs = resumeCall?.[1] as string[];
      expect(resumeArgs).toEqual(expect.arrayContaining(['--standalone', '--session', REAL_THREAD_ID]));
      expect(resumeArgs).toContain('run');

      // No spawn across either turn ever touched the resident-service
      // surface (`opencode2 service ...`, `/api/debug/location`,
      // `/api/session/...`) — `--standalone` means each run is fully
      // self-contained and the shared service is never consulted.
      expect(spawnMock.mock.calls.length).toBe(2);
      for (const call of spawnMock.mock.calls) {
        const args = (call[1] as string[]).join(' ');
        expect(args).not.toMatch(/\bservice\b/);
        expect(args).not.toMatch(/\/api\/debug\/location/);
        expect(args).not.toMatch(/\/api\/session/);
      }
    },
  );
});
