import { afterEach, describe, expect, it, vi } from 'vitest';
import { escalateInterrupt, type InterruptEscalationSignal } from './interrupt-escalation';

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
    expect(result.note).toBe('Worker remained live after SIGINT, SIGTERM, and SIGKILL.');
    expect(kill).toHaveBeenCalledTimes(3);
    expect(result.steps.map((step) => step.signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(result.steps.map((step) => step.mechanism)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
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
    expect(result.note).toBe('Worker remained live after 3 taskkill-tree attempts.');
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
