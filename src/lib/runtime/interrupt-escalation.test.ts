import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { escalateInterrupt, type InterruptEscalationSignal } from './interrupt-escalation';
import { isPidAlive } from '@/lib/runtimes/shared/owned-session/helpers';

const realPlatform = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('interrupt escalation ladder', () => {
  it('escalates SIGINT to SIGTERM and confirms dead', async () => {
    const sent: InterruptEscalationSignal[] = [];
    let alive = true;

    const result = await escalateInterrupt(
      { pid: 123 },
      {
        isAlive: () => alive,
        kill: (_target, signal) => {
          sent.push(signal);
          if (signal === 'SIGTERM') alive = false;
        },
        sleep: async () => {},
      },
    );

    expect(result.confirmedDead).toBe(true);
    expect(result.note).toBe('Worker stopped after SIGTERM.');
    expect(sent).toEqual(['SIGINT', 'SIGTERM']);
    expect(result.steps.map((step) => [step.signal, step.aliveAfter])).toEqual([
      ['SIGINT', true],
      ['SIGTERM', false],
    ]);
  });

  it('reports failure after SIGKILL when liveness never drops', async () => {
    const kill = vi.fn();
    const result = await escalateInterrupt(
      { pid: 456 },
      {
        isAlive: () => true,
        kill,
        sleep: async () => {},
      },
    );

    expect(result.confirmedDead).toBe(false);
    expect(result.note).toBe(
      'Worker tree could not be confirmed stopped after SIGINT, SIGTERM, and SIGKILL. Unconfirmed pids: 456.',
    );
    expect(kill).toHaveBeenCalledTimes(3);
    expect(result.steps.map((step) => step.signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(result.steps.map((step) => step.mechanism)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });
});

describe.skipIf(process.platform === 'win32')('POSIX process-tree escalation', () => {
  it('kills and verifies descendants when the recorded pid is not a process-group leader', async () => {
    const grandchildScript = [
      "process.on('SIGINT', () => {});",
      "process.on('SIGTERM', () => {});",
      "process.send?.('ready');",
      'setInterval(() => {}, 1000);',
    ].join('');
    const interpreterScript = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGINT', () => {});",
      "process.on('SIGTERM', () => {});",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], `,
      "  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "child.on('message', () => process.send?.({ childPid: child.pid }));",
      'setInterval(() => {}, 1000);',
    ].join('');
    const interpreter = spawn(process.execPath, ['-e', interpreterScript], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const interpreterPid = interpreter.pid!;
    const interpreterExited = new Promise<void>((resolve) => interpreter.once('exit', () => resolve()));
    let childPid = 0;

    try {
      childPid = await new Promise<number>((resolve, reject) => {
        interpreter.once('message', (message) => resolve((message as { childPid: number }).childPid));
        interpreter.once('error', reject);
      });
      expect(isPidAlive(interpreterPid)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);

      const result = await escalateInterrupt({ pid: interpreterPid });

      expect(result.confirmedDead).toBe(true);
      expect(result.steps.at(-1)?.confirmedDead).toBe(true);
      expect(result.steps.at(-1)?.aliveAfter).toBe(false);
      await interpreterExited;
      expect(isPidAlive(interpreterPid)).toBe(false);
      expect(isPidAlive(childPid)).toBe(false);
    } finally {
      for (const pid of [childPid, interpreterPid]) {
        if (!pid) continue;
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }, 15_000);

  it('does not infer tree death when the interpreter was gone before descendants could be inspected', async () => {
    const missingPid = 2_000_000_000;
    const result = await escalateInterrupt({ pid: missingPid }, { sleep: async () => {} });

    expect(result.confirmedDead).toBe(false);
    expect(result.steps.every((step) => step.aliveAfter && !step.confirmedDead)).toBe(true);
    expect(result.note).toContain(`Pid ${missingPid} and process group ${missingPid} were absent`);
  });
});

// Windows has one kill mechanism — `taskkill /T /F` — so every rung of this
// ladder does the same forced tree-kill. The audit trail is the operator's only
// record of how a worker was stopped, so it must not report a graceful signal
// that was never sent.
describe('interrupt escalation audit trail on Windows', () => {
  it('records the forced tree-kill as the mechanism, not the requested signal', async () => {
    setPlatform('win32');
    let alive = true;

    const result = await escalateInterrupt(
      { pid: 123 },
      {
        isAlive: () => alive,
        kill: (_target, signal) => { if (signal === 'SIGTERM') alive = false; },
        sleep: async () => {},
      },
    );

    expect(result.confirmedDead).toBe(true);
    // The rung is still recorded — the ladder's shape is real, its signals are not.
    expect(result.steps.map((step) => step.signal)).toEqual(['SIGINT', 'SIGTERM']);
    expect(result.steps.map((step) => step.mechanism)).toEqual(['taskkill-tree', 'taskkill-tree']);
    expect(result.note).toBe('Worker stopped after taskkill-tree.');
  });

  it('does not narrate three escalating signals when the worker survives', async () => {
    setPlatform('win32');

    const result = await escalateInterrupt(
      { pid: 456 },
      { isAlive: () => true, kill: vi.fn(), sleep: async () => {} },
    );

    expect(result.confirmedDead).toBe(false);
    expect(result.note).toBe(
      'Worker tree could not be confirmed stopped after 3 taskkill-tree attempts. Unconfirmed pids: 456.',
    );
  });

  it('keeps the real signal for a tmux target, which delivers one for real', async () => {
    setPlatform('win32');
    let alive = true;

    const result = await escalateInterrupt(
      { tmuxSession: 'o8-worker' },
      {
        isAlive: () => alive,
        kill: () => { alive = false; },
        sleep: async () => {},
      },
    );

    expect(result.steps.map((step) => step.mechanism)).toEqual(['SIGINT']);
  });
});
