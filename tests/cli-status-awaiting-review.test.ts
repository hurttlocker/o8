import { describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
const printJsonMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/src/api.js', () => ({ apiFetch: apiFetchMock }));
vi.mock('../cli/src/config.js', () => ({ resolveConfig: () => ({ apiBase: 'http://127.0.0.1:47120' }) }));
vi.mock('../cli/src/output.js', () => ({
  color: (value: string) => value,
  printHumanHeading: vi.fn(),
  printJson: printJsonMock,
}));

const { runStatus } = await import('../cli/src/commands/status');

describe('o8 status awaiting-review visibility (#1570)', () => {
  it('counts and lists reviewing lanes even when the active snapshot is empty', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ data: { lanes: [] } })
      .mockResolvedValueOnce({ data: { lanes: [{
        id: 'lane-review',
        label: 'Needs an operator',
        status: 'reviewing',
        runtime: 'codex',
        branch: 'issue/1570',
        baseBranch: 'main',
        repoPath: '/tmp/o8',
        worktreePath: '/tmp/o8-worktree',
        packetId: 'pkt-review',
        updatedAt: '2026-07-18T00:00:00.000Z',
        lastEventAt: '2026-07-18T00:00:00.000Z',
        lastEventLabel: 'review_requested',
      }] } })
      .mockResolvedValueOnce({ data: { approvals: [] } });

    await runStatus({ human: false, verbose: false });

    expect(printJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      counts: expect.objectContaining({ awaitingReview: 1 }),
      awaitingReview: [expect.objectContaining({ packetId: 'pkt-review', status: 'reviewing' })],
    }));
  });
});
