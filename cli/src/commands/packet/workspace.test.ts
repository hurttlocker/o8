import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetchMutation: vi.fn(),
  printJson: vi.fn(),
}));

vi.mock('../../config.js', () => ({ resolveConfig: () => ({ apiBase: 'http://127.0.0.1:47120' }) }));
vi.mock('../../output.js', () => ({
  printHumanHeading: vi.fn(),
  printHumanKv: vi.fn(),
  printJson: h.printJson,
}));
vi.mock('./correlated-mutation.js', () => ({ fetchCorrelatedPacketMutation: h.fetchMutation }));
vi.mock('./target.js', () => ({
  parsePacketArguments: (rest: string[]) => ({
    target: rest[0] ?? null,
    targetWasExplicit: true,
    values: rest[1] === '--idempotency-key' ? { 'idempotency-key': rest[2] } : {},
    booleans: new Set<string>(),
  }),
  resolvePacketTarget: async (target: string) => ({ packetId: target, laneId: 'lane-1' }),
  requirePacketId: (target: { packetId: string }) => target.packetId,
}));

import { runPacketWorkspace } from './workspace';

describe('o8 packet park/restore', () => {
  beforeEach(() => {
    h.fetchMutation.mockReset();
    h.printJson.mockReset();
  });

  it('passes the operator retry key unchanged to the exact receipt poller', async () => {
    h.fetchMutation.mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        result: {
          action: 'park',
          status: 'parked',
          state: 'parked',
          laneId: 'lane-1',
          repositoryUuid: 'repo-1',
          branch: 'inline/packet-1',
          reviewedHead: 'head-1',
          reviewable: true,
          note: 'Workspace parked.',
        },
      },
    });

    await expect(runPacketWorkspace(
      { human: false, verbose: false },
      'park',
      ['packet-1', '--idempotency-key', 'park-retry-1'],
    )).resolves.toBe(0);

    expect(h.fetchMutation).toHaveBeenCalledWith(
      expect.anything(),
      '/api/orchestrator/workspace',
      { action: 'park', packetId: 'packet-1', clientMutationId: 'park-retry-1' },
      expect.objectContaining({ allowConflict: true }),
    );
    expect(h.printJson).toHaveBeenCalledWith(expect.objectContaining({
      schema: 'o8/cli/packet.park/v1',
      clientMutationId: 'park-retry-1',
      workspace: expect.objectContaining({ state: 'parked', reviewable: true }),
    }));
  });
});
