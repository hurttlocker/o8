import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  printHumanKv: vi.fn(),
}));

vi.mock('../cli/src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/api.js')>();
  return { ...actual, apiFetch: h.apiFetch };
});
vi.mock('../cli/src/config.js', () => ({ resolveConfig: () => ({ apiBase: 'http://127.0.0.1:47120' }) }));
vi.mock('../cli/src/output.js', () => ({
  printHumanHeading: vi.fn(),
  printHumanKv: h.printHumanKv,
  printJson: vi.fn(),
}));

const { CliError } = await import('../cli/src/api.js');
const { runPacketReset } = await import('../cli/src/commands/packet/recover.js');

beforeEach(() => {
  h.apiFetch.mockReset();
  h.printHumanKv.mockReset();
});

describe('o8 packet reset cleanup truth', () => {
  it('does not print worktree wiped or suggest redispatch after a partial cleanup failure', async () => {
    h.apiFetch
      .mockResolvedValueOnce({
        data: { lanes: [{ id: 'lane-cleanup-failed', packetId: 'packet-cleanup-failed', worktreePath: '/tmp/worktree' }] },
      })
      .mockResolvedValueOnce({
        data: {
          ok: false,
          error: { code: 'worktree_cleanup_failed', message: 'Worktree cleanup was not confirmed.' },
          result: { reset: false, partial: true, worktreePruned: false },
        },
      });

    await expect(runPacketReset(
      { human: true, verbose: false },
      ['--packet', 'packet-cleanup-failed'],
    )).rejects.toMatchObject({
      constructor: CliError,
      code: 'reset_failed',
      message: 'Worktree cleanup was not confirmed.',
    });
    expect(h.printHumanKv).not.toHaveBeenCalled();
  });

  it('labels an already-absent worktree honestly instead of claiming it was wiped', async () => {
    h.apiFetch
      .mockResolvedValueOnce({
        data: { lanes: [{ id: 'lane-already-clear', packetId: 'packet-already-clear', worktreePath: null }] },
      })
      .mockResolvedValueOnce({
        data: { ok: true, result: { reset: true, worktreePruned: false } },
      });

    await expect(runPacketReset(
      { human: true, verbose: false },
      ['--packet', 'packet-already-clear'],
    )).resolves.toBe(0);
    expect(h.printHumanKv).toHaveBeenCalledWith(expect.arrayContaining([
      ['worktree', 'already clear'],
    ]));
  });
});
