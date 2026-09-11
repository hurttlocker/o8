import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from './types';

const mocks = vi.hoisted(() => ({
  listLanes: vi.fn(),
  getLane: vi.fn(),
  archiveLane: vi.fn(),
  archiveOwnedRuntimeSession: vi.fn(),
}));

vi.mock('./registry', () => ({
  listLanes: mocks.listLanes,
  getLane: mocks.getLane,
  archiveLane: mocks.archiveLane,
}));
vi.mock('@/lib/runtime/owned-session-archive', () => ({
  archiveOwnedRuntimeSession: mocks.archiveOwnedRuntimeSession,
}));

import { archiveTerminalLanes, terminalLanesToArchive } from './archive-terminal';

function lane(id: string, status: Lane['status'], sessionKey: string | null = null): Lane {
  return { id, status, sessionKey, label: id, repoPath: '/repos/project' } as Lane;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.archiveLane.mockImplementation((id: string) => lane(id, 'archived'));
  mocks.archiveOwnedRuntimeSession.mockResolvedValue({ archived: true, note: 'Archived.' });
});

describe('terminalLanesToArchive', () => {
  it('selects only lanes whose lifecycle is already over', () => {
    const lanes = [
      lane('failed', 'failed'),
      lane('completed', 'completed'),
      lane('running', 'running'),
      lane('reviewing', 'reviewing'),
      lane('awaiting', 'awaiting_human'),
      lane('recovering', 'recovering'),
      lane('already', 'archived'),
    ];

    expect(terminalLanesToArchive(lanes).map((entry) => entry.id)).toEqual(['failed', 'completed']);
  });
});

describe('archiveTerminalLanes', () => {
  it('archives every terminal lane in one pass and keeps the records', async () => {
    const lanes = [lane('failed', 'failed'), lane('completed', 'completed'), lane('live', 'running')];
    mocks.listLanes.mockReturnValue(lanes);
    mocks.getLane.mockImplementation((id: string) => lanes.find((entry) => entry.id === id) ?? null);

    const result = await archiveTerminalLanes('user');

    expect(result.archived).toEqual(['failed', 'completed']);
    expect(mocks.archiveLane).toHaveBeenCalledWith('failed', 'user');
    expect(mocks.archiveLane).toHaveBeenCalledWith('completed', 'user');
    expect(mocks.archiveLane).toHaveBeenCalledTimes(2);
  });

  it('never archives a lane that went live between the listing and the write', async () => {
    mocks.listLanes.mockReturnValue([lane('relaunched', 'failed')]);
    // Re-read sees the retry that relaunched it — live work, hands off.
    mocks.getLane.mockReturnValue(lane('relaunched', 'running'));

    const result = await archiveTerminalLanes('user');

    expect(result.archived).toEqual([]);
    expect(mocks.archiveLane).not.toHaveBeenCalled();
  });

  it('retires the owned session before the lane so the rail stops re-adding it', async () => {
    const failed = lane('with-session', 'failed', 'codex-owned:with-session');
    mocks.listLanes.mockReturnValue([failed]);
    mocks.getLane.mockReturnValue(failed);

    const result = await archiveTerminalLanes('user');

    expect(mocks.archiveOwnedRuntimeSession).toHaveBeenCalledWith('codex-owned:with-session');
    expect(result.archived).toEqual(['with-session']);
    expect(result.sessionArchiveFailures).toEqual([]);
  });

  it('still archives the lane when its session dir is already gone', async () => {
    const failed = lane('stale-session', 'failed', 'codex-owned:stale-session');
    mocks.listLanes.mockReturnValue([failed]);
    mocks.getLane.mockReturnValue(failed);
    mocks.archiveOwnedRuntimeSession.mockResolvedValue({ archived: false, note: 'Session was not found.' });

    const result = await archiveTerminalLanes('user');

    expect(result.archived).toEqual(['stale-session']);
    expect(result.sessionArchiveFailures).toEqual(['stale-session']);
  });
});
