import { describe, expect, it, vi } from 'vitest';
import { terminatePacketManagedRuns } from '@/lib/runtimes/managed-runs/packet-lifecycle';
import type {
  ManagedRunRecord,
  ManagedRunTerminationReceipt,
} from '@/lib/runtimes/managed-runs/types';

function run(
  id: string,
  packetId: string | null,
  status: ManagedRunRecord['status'] = 'running',
): ManagedRunRecord {
  return {
    id,
    session: `cortex-run-${id}`,
    command: 'node worker.mjs',
    cwd: `/tmp/${id}`,
    packetId,
    mode: 'stream',
    startedAt: '2026-09-04T00:00:00.000Z',
    status,
  };
}

function termination(confirmedDead: boolean): ManagedRunTerminationReceipt {
  return {
    schema: 'o8/managed-run-termination/v1',
    reason: 'operator_stop',
    exitCode: null,
    requestedAt: '2026-09-04T00:00:00.000Z',
    confirmedAt: confirmedDead ? '2026-09-04T00:00:01.000Z' : null,
    confirmedDead,
    alreadyDead: false,
    steps: [],
  };
}

describe('packet-owned managed-run settlement', () => {
  it('terminates only live or gone runs bound to the stopped packet', async () => {
    const matching = run('matching', 'packet-one');
    const gone = run('gone', 'packet-one', 'gone');
    const other = run('other', 'packet-two');
    const finished = run('finished', 'packet-one', 'finished');
    const terminate = vi.fn(async (_target: ManagedRunRecord) => termination(true));
    const markKilled = vi.fn((session: string) => ({
      ...(session === matching.session ? matching : gone),
      status: 'killed' as const,
      finishedAt: '2026-09-04T00:00:01.000Z',
    }));
    const recordKilled = vi.fn();

    const receipt = await terminatePacketManagedRuns('packet-one', {
      listRuns: async () => [matching, gone, other, finished],
      terminate,
      markKilled,
      recordKilled,
    });

    expect(receipt).toEqual({ targeted: 2, confirmed: 2, failures: [] });
    expect(terminate.mock.calls.map(([target]) => target.id)).toEqual(['matching', 'gone']);
    expect(markKilled).toHaveBeenCalledTimes(2);
    expect(recordKilled).toHaveBeenCalledTimes(2);
  });

  it('preserves an unconfirmed run as a stop failure', async () => {
    const target = run('blocked', 'packet-one');
    const markKilled = vi.fn();

    const receipt = await terminatePacketManagedRuns('packet-one', {
      listRuns: async () => [target],
      terminate: async () => termination(false),
      markKilled,
      recordKilled: vi.fn(),
    });

    expect(receipt).toEqual({
      targeted: 1,
      confirmed: 0,
      failures: [{
        id: 'blocked',
        session: 'cortex-run-blocked',
        reason: 'termination_unconfirmed',
      }],
    });
    expect(markKilled).not.toHaveBeenCalled();
  });
});
