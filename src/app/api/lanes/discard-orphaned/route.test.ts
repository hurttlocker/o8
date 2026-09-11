/**
 * #2144 — driven through the REAL route handler, not `discardOrphanedLane` in
 * isolation. The bug was reachability: the registry could already archive these
 * lanes, but no surface an operator could see offered the call. So the
 * assertions here are "the endpoint retires the lane" and "the endpoint refuses
 * a lane that still has work on disk", never "the helper returns a refusal".
 */
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLane: vi.fn(),
  archiveLane: vi.fn(),
  updateLane: vi.fn(),
  principal: vi.fn(),
}));

vi.mock('@/lib/lane/registry', () => ({
  getLane: mocks.getLane,
  archiveLane: mocks.archiveLane,
  updateLane: mocks.updateLane,
}));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipalContext: mocks.principal }));
vi.mock('@/lib/runtime/owned-session-archive', () => ({
  archiveOwnedRuntimeSession: vi.fn(async () => ({ archived: true, note: 'Session archived.' })),
}));

import { POST } from './route';

/** A path that cannot exist, so the lane reads as orphaned without touching disk state. */
const GONE = join(os.tmpdir(), 'o8-2144-worktree-that-was-removed');
/** A path that always exists — stands in for a lane whose work is still there. */
const PRESENT = os.tmpdir();

function post(body: unknown) {
  return new NextRequest('http://localhost/api/lanes/discard-orphaned', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal.mockReturnValue({ role: 'operator' });
  mocks.archiveLane.mockImplementation((laneId: string) => ({ id: laneId, status: 'archived' }));
});

describe('POST /api/lanes/discard-orphaned', () => {
  it('retires an escalated lane whose checkout is gone', async () => {
    mocks.getLane.mockReturnValue({
      id: 'lane-escalated',
      status: 'awaiting_human',
      sessionKey: null,
      worktreePath: GONE,
    });

    const response = await POST(post({ laneId: 'lane-escalated' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, laneId: 'lane-escalated', status: 'archived' });
    expect(mocks.archiveLane).toHaveBeenCalledWith('lane-escalated', 'user', expect.objectContaining({ outcome: 'discarded' }));
  });

  it('refuses a lane whose work is still on disk', async () => {
    mocks.getLane.mockReturnValue({
      id: 'lane-live',
      status: 'awaiting_orchestrator',
      sessionKey: null,
      worktreePath: PRESENT,
    });

    const response = await POST(post({ laneId: 'lane-live' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'worktree_present' } });
    expect(mocks.archiveLane).not.toHaveBeenCalled();
  });

  it('refuses a lane whose lifecycle is already over', async () => {
    mocks.getLane.mockReturnValue({
      id: 'lane-done',
      status: 'completed',
      sessionKey: null,
      worktreePath: GONE,
    });

    const response = await POST(post({ laneId: 'lane-done' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'already_terminal' } });
    expect(mocks.archiveLane).not.toHaveBeenCalled();
  });

  it('404s a lane that is no longer in the registry', async () => {
    mocks.getLane.mockReturnValue(null);

    const response = await POST(post({ laneId: 'lane-ghost' }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'lane_not_found' } });
  });

  it('denies a worker credential — discarding is an operator gesture', async () => {
    mocks.principal.mockReturnValue({ role: 'worker', packetId: 'pkt-1' });

    const response = await POST(post({ laneId: 'lane-escalated' }));

    expect(response.status).toBe(403);
    expect(mocks.getLane).not.toHaveBeenCalled();
    expect(mocks.archiveLane).not.toHaveBeenCalled();
  });

  it('requires a laneId', async () => {
    const response = await POST(post({}));

    expect(response.status).toBe(400);
    expect(mocks.archiveLane).not.toHaveBeenCalled();
  });
});
