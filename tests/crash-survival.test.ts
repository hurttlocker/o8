import { describe, expect, it, afterEach } from 'vitest';

import { isOwnedRunAlive } from '@/lib/runtimes/shared/owned-session/helpers';
import { crashSurvivableWorkersEnabled } from '@/lib/runtimes/shared/owned-session/crash-survival';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';

/**
 * #4 crash-survival contract (daemon crash-survival, Stage 2).
 *
 * The whole feature rests on one predicate: a DETACHED worker that outlived a
 * ws-server/app crash must read as ALIVE on boot so the lane reconciler re-binds
 * it (keeps the lane `running`), the orphan sweep skips it, and the silent-exit
 * detector does NOT finalize it. All three gate on `isOwnedRunAlive`. If a future
 * change makes a live detached survivor read dead, this suite fails loudly before
 * it can silently reintroduce "salvaged instead of resumed."
 */

function detachedRun(overrides: Partial<OwnedRunRecord> = {}): OwnedRunRecord {
  return {
    id: 'run-test',
    mode: 'launch',
    prompt: 'test',
    startedAt: new Date(0).toISOString(),
    pid: process.pid, // this test process is, definitionally, alive
    stdoutPath: '/tmp/o8-crash-survival-test.jsonl',
    stderrPath: '/tmp/o8-crash-survival-test.stderr',
    outcome: 'running',
    detachMode: 'detached',
    // tmuxSession intentionally absent — a detached survivor has no bridge/PTY,
    // so aliveness must fall through to the pid probe.
    ...overrides,
  };
}

describe('#4 crash-survival — detached survivor liveness contract', () => {
  it('an alive detached run (pid alive, no tmux, not finished) reads ALIVE', async () => {
    await expect(isOwnedRunAlive(detachedRun())).resolves.toBe(true);
  });

  it('a finished detached run is terminal even with a live pid (the #1293 short-circuit)', async () => {
    await expect(
      isOwnedRunAlive(detachedRun({ finishedAt: new Date().toISOString() })),
    ).resolves.toBe(false);
  });

  it('a dead detached run (no live pid, no tmux) reads DEAD so salvage can run', async () => {
    // 0x7fffffff is beyond any real pid table → process.kill(pid,0) throws ESRCH.
    await expect(isOwnedRunAlive(detachedRun({ pid: 0x7fffffff }))).resolves.toBe(false);
  });

  it('a null run is not alive', async () => {
    await expect(isOwnedRunAlive(null)).resolves.toBe(false);
  });
});

describe('#4 crash-survival — feature flag (default OFF)', () => {
  const prior = process.env.O8_CRASH_SURVIVABLE_WORKERS;
  afterEach(() => {
    if (prior === undefined) delete process.env.O8_CRASH_SURVIVABLE_WORKERS;
    else process.env.O8_CRASH_SURVIVABLE_WORKERS = prior;
  });

  it('is OFF when unset (production stays bridge-primary until dogfood flips it)', () => {
    delete process.env.O8_CRASH_SURVIVABLE_WORKERS;
    expect(crashSurvivableWorkersEnabled()).toBe(false);
  });

  it('accepts 1 / true / on / yes (case-insensitive)', () => {
    for (const v of ['1', 'true', 'on', 'YES', ' On ']) {
      process.env.O8_CRASH_SURVIVABLE_WORKERS = v;
      expect(crashSurvivableWorkersEnabled()).toBe(true);
    }
  });

  it('treats 0 / false / empty / garbage as OFF', () => {
    for (const v of ['0', 'false', '', 'off', 'maybe']) {
      process.env.O8_CRASH_SURVIVABLE_WORKERS = v;
      expect(crashSurvivableWorkersEnabled()).toBe(false);
    }
  });
});
