import { describe, expect, it } from 'vitest';
import { terminateManagedRun } from '@/lib/runtimes/managed-runs/termination';
import type { ManagedRunRecord } from '@/lib/runtimes/managed-runs/types';

function record(): ManagedRunRecord {
  return {
    id: 'abc12345',
    session: 'cortex-run-abc12345',
    command: 'node worker.mjs',
    cwd: '/tmp/project',
    panePid: 100,
    processGroupId: 100,
    processMarker: 'marker-abc12345',
    mode: 'stream',
    startedAt: '2026-08-25T00:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    status: 'running',
  };
}

describe('managed-run termination proof', () => {
  it('settles the exact session and escaped marker descendants before confirming', async () => {
    let alive = true;
    let markerPids = [100, 101, 102];
    const groupSignals: string[] = [];
    const pidSignals: Array<[number, string]> = [];
    const result = await terminateManagedRun(record(), {
      reason: 'stream_sigint',
      exitCode: 130,
      deps: {
        run: async (command, args) => {
          if (command === 'tmux' && args[0] === 'has-session') {
            return { code: alive ? 0 : 1, stdout: '', stderr: '' };
          }
          if (command === 'tmux' && args[0] === 'list-panes') {
            return { code: 0, stdout: '100\n', stderr: '' };
          }
          if (command === 'tmux' && args[0] === 'kill-session') {
            alive = false;
            markerPids = [];
            return { code: 0, stdout: '', stderr: '' };
          }
          if (command === 'ps' && args[1] === 'pgid=') {
            return { code: 0, stdout: '100\n', stderr: '' };
          }
          if (command === 'ps') {
            return {
              code: 0,
              stdout: markerPids.map((pid) => `${pid} O8_MANAGED_RUN_MARKER=marker-abc12345`).join('\n'),
              stderr: '',
            };
          }
          return { code: 1, stdout: '', stderr: '' };
        },
        signalGroup: (_group, signal) => { groupSignals.push(signal); },
        signalProcess: (pid, signal) => { pidSignals.push([pid, signal]); },
        sleep: async () => {},
        now: () => new Date('2026-08-25T00:00:00.000Z'),
      },
    });

    expect(result.confirmedDead).toBe(true);
    expect(result.steps.map((step) => step.signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(groupSignals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(pidSignals).toContainEqual([102, 'SIGKILL']);
    expect(result.exitCode).toBe(130);
  });

  it('never signals a stored group after its exact tmux session and marker are gone', async () => {
    let signaled = false;
    const result = await terminateManagedRun(record(), {
      reason: 'operator_stop',
      exitCode: null,
      deps: {
        run: async (command) => command === 'tmux'
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 0, stdout: '', stderr: '' },
        signalGroup: () => { signaled = true; },
        signalProcess: () => { signaled = true; },
        sleep: async () => {},
        now: () => new Date('2026-08-25T00:00:00.000Z'),
      },
    });

    expect(result).toMatchObject({ confirmedDead: true, alreadyDead: true });
    expect(signaled).toBe(false);
  });
});
