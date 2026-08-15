import { describe, expect, it } from 'vitest';

import {
  processProbe,
  synthesizeProcessQuiescence,
  type ProcessIdentityReceipt,
  type ProcessPrimitive,
  type ProcessProbeReceipt,
} from './process-quiescence';

const primitives: ProcessPrimitive[] = [
  'pid',
  'process_group',
  'descendants',
  'owned_marker',
  'tmux',
  'runtime',
  'retained_run_ledger',
  'filesystem_users',
];

const ownedIdentity: ProcessIdentityReceipt = {
  ownership: 'owned',
  pidIdentity: 'matched',
  sessionKey: 'codex-owned:packet-1',
  expectedPid: 101,
  expectedProcessGroupId: 101,
  expectedCommandIdentity: 'codex',
};

function clearProbes(): ProcessProbeReceipt[] {
  return primitives.map((primitive) => processProbe(primitive, 'clear', `${primitive} is clear`));
}

describe('process quiescence synthesis', () => {
  it('returns quiescent only when every primitive is clear and ownership is proved', () => {
    const receipt = synthesizeProcessQuiescence(
      ownedIdentity,
      clearProbes(),
      () => new Date('2026-08-14T00:00:00.000Z'),
    );
    expect(receipt).toMatchObject({ state: 'quiescent', checkedAt: '2026-08-14T00:00:00.000Z' });
    expect(receipt.reasons).toEqual([]);
  });

  it.each<ProcessPrimitive>(primitives)('returns live when the %s primitive proves liveness', (primitive) => {
    const probes = clearProbes().map((probe) => probe.primitive === primitive
      ? processProbe(primitive, 'live', `${primitive} found a process`, [13, 13, 9])
      : probe);
    const receipt = synthesizeProcessQuiescence(ownedIdentity, probes);
    expect(receipt.state).toBe('live');
    expect(receipt.probes.find((probe) => probe.primitive === primitive)?.pids).toEqual([9, 13]);
  });

  it('returns unknown for EPERM-shaped PID uncertainty and lsof failure', () => {
    const pidUnknown = clearProbes().map((probe) => probe.primitive === 'pid'
      ? processProbe('pid', 'unknown', 'kill(pid, 0) returned EPERM')
      : probe);
    expect(synthesizeProcessQuiescence(ownedIdentity, pidUnknown).state).toBe('unknown');

    const lsofUnknown = clearProbes().map((probe) => probe.primitive === 'filesystem_users'
      ? processProbe('filesystem_users', 'unknown', 'lsof failed with exit 2')
      : probe);
    expect(synthesizeProcessQuiescence(ownedIdentity, lsofUnknown).state).toBe('unknown');
  });

  it('returns unknown for PID reuse even if the reused process is live', () => {
    const identity = { ...ownedIdentity, pidIdentity: 'reused' as const };
    const probes = clearProbes().map((probe) => probe.primitive === 'pid'
      ? processProbe('pid', 'live', 'pid exists but command identity differs', [101])
      : probe);
    const receipt = synthesizeProcessQuiescence(identity, probes);
    expect(receipt.state).toBe('unknown');
    expect(receipt.reasons).toContain('The recorded PID belongs to a different process.');
  });

  it('returns unknown for unowned sessions and incomplete or conflicting evidence', () => {
    const unowned = synthesizeProcessQuiescence(
      { ownership: 'unowned', pidIdentity: 'not_applicable' },
      clearProbes(),
    );
    expect(unowned.state).toBe('unknown');

    const incomplete = synthesizeProcessQuiescence(ownedIdentity, clearProbes().slice(1));
    expect(incomplete.state).toBe('unknown');
    expect(incomplete.reasons).toContain('Missing pid probe.');

    const duplicate = synthesizeProcessQuiescence(ownedIdentity, [
      ...clearProbes(),
      processProbe('tmux', 'clear', 'second tmux result'),
    ]);
    expect(duplicate.state).toBe('unknown');
    expect(duplicate.reasons).toContain('Conflicting duplicate tmux probes.');
  });
});
