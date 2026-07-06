import { describe, expect, it, vi } from 'vitest';
import { escalateInterrupt, type InterruptEscalationSignal } from './interrupt-escalation';

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
  });
});
