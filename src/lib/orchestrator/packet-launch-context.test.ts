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

function launchContext(caller: string, placement?: { workspaceId: string; threadId: string }) {
  return {
    source: 'cli',
    presentation: 'split',
    repoContext: 'transient',
    caller,
    ...(placement ? {
      parentWorkspaceId: placement.workspaceId,
      parentThreadId: placement.threadId,
    } : {}),
  } as const;
}

describe('packet launch context lookup', () => {
  it('falls back to a non-current mission so durable lane polling can still split the worker', () => {
    const persistedLaunchContext = launchContext('outside terminal', {
      workspaceId: 'workspace-parent',
      threadId: 'thoughts-parent',
    });
    fixtures.current = {
      missionId: 'mission-current',
      packets: [{ id: 'pkt-current', launchContext: launchContext('current') }],
    };
    fixtures.registry = [{
      id: 'mission-older',
      mission: {
        missionId: 'mission-older',
        packets: [{ id: 'pkt-older', launchContext: persistedLaunchContext }],
      },
    }];

    expect(resolvePacketLaunchContexts(['pkt-older']).get('pkt-older')).toEqual({
      launchContext: persistedLaunchContext,
      missionId: 'mission-older',
    });
  });
});
