import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnedRuntimeAdapter, ParsedRunLog } from './types';

/**
 * #1585 real-path guard: the owned-session orphan sweep must NEVER SIGINT a
 * foreign process when running in an isolated test context. A packet worker
 * that runs `npm test` imports these modules; without the guard its sweep
 * (measured against an EMPTY isolated lane ledger) treated every live
 * production worker as orphaned and killed it — the fleet-wipe root cause.
 *
 * This drives the REAL `sweepOrphanedSessions` against a seeded session whose
 * activeRun points at a genuinely live child process, and asserts the process
 * survives because `O8_TEST_DATA_DIR_PINNED` (set by the vitest global setup)
 * short-circuits the interrupt.
 */
describe('owned-session orphan sweep — test-context interrupt guard (#1585)', () => {
  let tempRoot: string;
  let sessionsRoot: string;
  let priorRoot: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-orphan-guard-'));
    sessionsRoot = path.join(tempRoot, 'sessions');
    mkdirSync(sessionsRoot, { recursive: true });
    priorRoot = process.env.O8_TEST_OWNED_ROOT;
    process.env.O8_TEST_OWNED_ROOT = sessionsRoot;
  });

  afterEach(() => {
    try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    if (priorRoot === undefined) delete process.env.O8_TEST_OWNED_ROOT;
    else process.env.O8_TEST_OWNED_ROOT = priorRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function testAdapter(): OwnedRuntimeAdapter {
    return {
      runtimeId: 'test-runtime',
      surfaceIdPrefix: 'test-owned:',
      rootEnvVar: 'O8_TEST_OWNED_ROOT',
      rootDefault: path.join(os.tmpdir(), 'o8-test-owned-orphan'),
      binaryName: 'node',
      binaryEnvOverride: 'O8_TEST_BIN',
      humanLabel: 'Owned Test',
      squadShortName: 'Test',
      launchArgs: () => [],
      resumeArgs: () => [],
      parseRunLog: (): ParsedRunLog => ({ entries: [], outcome: 'running', completedTurn: false }),
    };
  }

  const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it('spares a live foreign process while O8_TEST_DATA_DIR_PINNED is set', async () => {
    // A genuinely live child whose command line contains the adapter binary
    // name ("node") — exactly what the unguarded interrupt path would SIGINT.
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true });
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    // Seed an owned session on disk whose activeRun references the live pid,
    // with an old startedAt so it is well past the 120s orphan grace window,
    // and NO matching active lane (activeSurfaceIds is empty) → the sweep
    // classifies it orphaned and, without the guard, would interrupt the pid.
    const surfaceId = 'test-owned:test-owned-orphan-guard-1';
    const sessionDir = path.join(sessionsRoot, 'test-owned-orphan-guard-1');
    mkdirSync(path.join(sessionDir, 'runs'), { recursive: true });
    const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      sessionDir,
      runtimeId: 'test-runtime',
      repoPath: tempRoot,
      createdAt: staleIso,
      updatedAt: staleIso,
      recentRuns: [],
      activeRun: {
        id: 'run-orphan-guard-1',
        startedAt: staleIso,
        pid,
        stdoutPath: path.join(sessionDir, 'runs', 'r.out'),
        stderrPath: path.join(sessionDir, 'runs', 'r.err'),
      },
    }));
    writeFileSync(path.join(sessionDir, 'runs', 'r.out'), '');
    writeFileSync(path.join(sessionDir, 'runs', 'r.err'), '');

    expect(process.env.O8_TEST_DATA_DIR_PINNED).toBeTruthy();

    // Spy on process.kill and record only DELIVERED signals (signal 0 is the
    // liveness probe, not a kill) targeting our pid or its group. This is
    // deterministic — unlike observing async process death, which races the
    // SIGINT delivery and can read "still alive" even when the signal WAS sent
    // (that false-pass is exactly why this test spies instead).
    const realKill = process.kill.bind(process);
    const deliveredSignals: Array<{ target: number; signal: string | number }> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target: number, signal?: string | number) => {
      if (signal !== 0 && signal !== undefined && (target === pid || target === -pid)) {
        deliveredSignals.push({ target, signal });
        return true; // swallow — never actually signal our live child in the spy
      }
      return realKill(target, signal as NodeJS.Signals);
    });

    try {
      const { createOwnedSessionStore } = await import('./store');
      const store = createOwnedSessionStore(testAdapter());
      // No active lanes → this session is an orphan candidate; the sweep will
      // reach markActiveRunOrphaned for the seeded live pid.
      const archived = await store.sweepOrphanedSessions(new Set<string>(), 120_000);

      // Sanity: the session WAS classified orphaned (the sweep did reach the
      // interrupt decision — otherwise this test proves nothing).
      expect(archived).toBe(1);
      // The guard must have skipped the interrupt: NO SIGINT delivered to the
      // live foreign pid. (Without the O8_TEST_DATA_DIR_PINNED guard this array
      // contains a SIGINT to -pid — the fleet-kill.)
      expect(deliveredSignals).toEqual([]);
      // And the process is still alive.
      expect(isAlive(pid)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });
});
