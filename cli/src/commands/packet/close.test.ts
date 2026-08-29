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
vi.mock('./target.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./target')>();
  return {
    ...actual,
    resolvePacketTarget: async (target: string) => ({ packetId: target, laneId: 'lane-1' }),
    requirePacketId: (target: { packetId: string }) => target.packetId,
  };
});

import { runPacketClose } from './close';

describe('o8 packet discard', () => {
  beforeEach(() => {
    h.fetchMutation.mockReset();
    h.printJson.mockReset();
  });

  it('sends the missing-worktree acknowledgement through the canonical discard route', async () => {
    h.fetchMutation.mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        result: {
          closed: true,
          disposition: 'wontfix',
          laneId: 'lane-1',
          worktreeCleanup: 'missing',
          note: 'Worktree was already missing.',
        },
      },
    });

    await expect(runPacketClose(
      { human: false, verbose: false },
      ['packet-1', '--acknowledge-missing-worktree'],
      'discard',
    )).resolves.toBe(0);

    expect(h.fetchMutation).toHaveBeenCalledWith(
      expect.anything(),
      '/api/orchestrator/discard-packet',
      expect.objectContaining({
        packetId: 'packet-1',
        disposition: 'wontfix',
        acknowledgeMissingWorktree: true,
        clientMutationId: expect.any(String),
      }),
      expect.anything(),
    );
    expect(h.printJson).toHaveBeenCalledWith(expect.objectContaining({
      schema: 'o8/cli/packet.discard/v1',
      packet: expect.objectContaining({ worktreeCleanup: 'missing' }),
    }));
  });
});
