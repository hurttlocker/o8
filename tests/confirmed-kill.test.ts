/**
 * Confirmed-kill escalation (#1471 S1). Two halves, both real-path:
 *
 *  A. The escalation LADDER against REAL child processes — spawn a detached
 *     child that traps SIGINT (and SIGTERM), assert `escalateInterrupt` climbs
 *     SIGINT → SIGTERM → SIGKILL and only reports `confirmedDead` once the OS
 *     actually reaped it (kill(pid,0) → ESRCH). Plus the unconfirmed branch.
 *
 *  B. The reap-sessions WIRING — `killLaneSessionsConfirmed` emits a
 *     `kill_escalated` lane event per stage into the REAL lane_events table and
 *     reports `confirmed` straight from the ladder, so the caller (stopPacket)
 *     flips status / parks kill_unconfirmed off a truthful signal.
 *
 * The child traps are real OS signals; the ladder result in half B is the only
 * thing stubbed (spawning a real owned codex session is out of a unit test's
 * reach), and it's stubbed via importActual so half A keeps the real ladder.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const escalationMock = vi.hoisted(() => ({ escalateInterruptOwnedSurface: vi.fn() }));

vi.mock('@/lib/runtime/interrupt-escalation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/interrupt-escalation')>();
  return { ...actual, escalateInterruptOwnedSurface: escalationMock.escalateInterruptOwnedSurface };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-confirmed-kill-'));
writeFileSync(join(dataDir, 'ws-token'), 'ws-token-confirmed-kill-0123456789\n', 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { escalateInterrupt } = await import('@/lib/runtime/interrupt-escalation');
const { isPidAlive } = await import('@/lib/runtimes/shared/owned-session/helpers');
const { killLaneSessionsConfirmed } = await import('@/lib/lane/reap-sessions');
const { getLaneEvents, createLane } = await import('@/lib/lane/registry');
import type { InterruptEscalationResult } from '@/lib/runtime/interrupt-escalation';

/**
 * Spawn a detached child (its own process-group leader) that traps `traps` and
 * signals `ready` ONLY after the handlers are installed. We must wait for that
 * IPC before signaling — under full-suite parallelism node startup can lag, and
 * a SIGINT that races the handler install would kill the child on the first
 * signal (a false "died at SIGINT"). No time-based fallback for that reason.
 */
function spawnTrapChild(traps: string[]): Promise<{ pid: number; done: Promise<void> }> {
  const script = `${traps.map((sig) => `process.on(${JSON.stringify(sig)}, () => {});`).join('')}setInterval(() => {}, 1000);process.send('ready');`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const done = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return new Promise((resolve, reject) => {
    child.on('message', () => resolve({ pid: child.pid as number, done }));
    child.on('error', reject);
  });
}

/** A real persisted lane so lane_events' FK to lanes(id) is satisfied. */
function makeLane(sessionKey: string | null) {
  return createLane({
    repoPath: '/tmp/repo',
    branch: 'issue/x',
    runtime: 'codex',
    label: 'kill test',

    ...(sessionKey ? { sessionKey } : {}),
  });
}

describe('A. escalation ladder against REAL child processes', () => {
  it('climbs SIGINT→SIGTERM→SIGKILL and confirms exit for a child that ignores SIGINT+SIGTERM', async () => {
    const { pid, done } = await spawnTrapChild(['SIGINT', 'SIGTERM']);
    expect(isPidAlive(pid)).toBe(true);

    const result = await escalateInterrupt({ pid });

    expect(result.confirmedDead).toBe(true);
    const signals = result.steps.map((step) => step.signal);
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
    // Only the final SIGKILL step confirms the exit.
    expect(result.steps[result.steps.length - 1]?.aliveAfter).toBe(false);
    await done;
    expect(isPidAlive(pid)).toBe(false);
  }, 15_000);

  it('confirms at SIGTERM for a child that only ignores SIGINT', async () => {
    const { pid, done } = await spawnTrapChild(['SIGINT']);
    const result = await escalateInterrupt({ pid });

    expect(result.confirmedDead).toBe(true);
    const signals = result.steps.map((step) => step.signal);
    expect(signals).toEqual(['SIGINT', 'SIGTERM']); // stopped after SIGTERM — never reached SIGKILL
    await done;
    expect(isPidAlive(pid)).toBe(false);
  }, 15_000);

  it('reports confirmedDead=false when the process survives all three signals (unconfirmed branch)', async () => {
    const result = await escalateInterrupt(
      { pid: 999999 },
      { isAlive: () => true, kill: () => {}, sleep: async () => {} },
    );
    expect(result.confirmedDead).toBe(false);
    expect(result.steps.map((step) => step.signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });
});

describe('B. killLaneSessionsConfirmed wiring — events + confirmed signal', () => {
  it('emits a kill_escalated lane event per stage and reports confirmed', async () => {
    const lane = makeLane('codex-owned:kill-target');
    escalationMock.escalateInterruptOwnedSurface.mockResolvedValueOnce({
      attempted: true,
      confirmedDead: true,
      alreadyDead: false,
      steps: [
        { signal: 'SIGINT', mechanism: 'SIGINT', sent: true, aliveAfter: true },
        { signal: 'SIGTERM', mechanism: 'SIGTERM', sent: true, aliveAfter: false },
      ],
      pid: 4321,
      note: 'Worker stopped after SIGTERM.',
    } satisfies InterruptEscalationResult);

    const [outcome] = await killLaneSessionsConfirmed([lane]);
    expect(outcome.confirmed).toBe(true);
    expect(outcome.pid).toBe(4321);
    expect(outcome.stages.map((stage) => stage.stage)).toEqual(['SIGINT', 'SIGTERM']);

    const events = getLaneEvents(lane.id, 50).filter((event) => (event.verb as string) === 'kill_escalated');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload.stage)).toEqual(['SIGINT', 'SIGTERM']);
    expect(events.every((event) => event.payload.pid === 4321)).toBe(true);
    // Truthful confirmed flag per stage: SIGINT did not confirm, SIGTERM did.
    expect(events.map((event) => event.payload.confirmed)).toEqual([false, true]);
  });

  it('reports confirmed=false when the worker survives even SIGKILL (drives kill_unconfirmed)', async () => {
    const lane = makeLane('codex-owned:kill-target');
    escalationMock.escalateInterruptOwnedSurface.mockResolvedValueOnce({
      attempted: true,
      confirmedDead: false,
      alreadyDead: false,
      steps: [
        { signal: 'SIGINT', mechanism: 'SIGINT', sent: true, aliveAfter: true },
        { signal: 'SIGTERM', mechanism: 'SIGTERM', sent: true, aliveAfter: true },
        { signal: 'SIGKILL', mechanism: 'SIGKILL', sent: true, aliveAfter: true },
      ],
      pid: 5555,
      note: 'Worker remained live after SIGINT, SIGTERM, and SIGKILL.',
    } satisfies InterruptEscalationResult);

    const [outcome] = await killLaneSessionsConfirmed([lane]);
    expect(outcome.confirmed).toBe(false);
    expect(outcome.alreadyDead).toBe(false);
    expect(getLaneEvents(lane.id, 50).filter((event) => (event.verb as string) === 'kill_escalated')).toHaveLength(3);
  });

  it('skips lanes with no sessionKey (nothing to reap)', async () => {
    const outcomes = await killLaneSessionsConfirmed([makeLane(null)]);
    expect(outcomes).toHaveLength(0);
  });
});
