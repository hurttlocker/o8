import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  current: { missionId: 'mission-current', packets: [] as Array<Record<string, unknown>> },
  registry: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/orchestrator/control-plane', () => ({
  readOrchestratorControlPlaneState: () => fixtures.current,
}));

vi.mock('@/lib/orchestrator/mission-registry', () => ({
  listMissionRegistryEntries: () => fixtures.registry,
}));

const { resolvePacketLaunchContexts } = await import('./packet-launch-context');

function launchContext(caller: string) {
  return {
    source: 'cli',
    presentation: 'split',
    repoContext: 'transient',
    caller,
  } as const;
}

describe('packet launch context lookup', () => {
  it('falls back to a non-current mission so durable lane polling can still split the worker', () => {
    fixtures.current = {
      missionId: 'mission-current',
      packets: [{ id: 'pkt-current', launchContext: launchContext('current') }],
    };
    fixtures.registry = [{
      id: 'mission-older',
      mission: {
        missionId: 'mission-older',
        packets: [{ id: 'pkt-older', launchContext: launchContext('outside terminal') }],
      },
    }];

    expect(resolvePacketLaunchContexts(['pkt-older']).get('pkt-older')).toEqual({
      launchContext: launchContext('outside terminal'),
      missionId: 'mission-older',
    });
  });
});
