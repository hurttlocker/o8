import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLaneBinding, resolveFocusableLaneBinding } from './focusOrchestrationPacketLane';

function mockLaneFetch(lanes: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ lanes }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolveFocusableLaneBinding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a lane by laneId', async () => {
    const fetchMock = mockLaneFetch([
      {
        id: 'lane-target',
        packetId: 'pkt-other',
        sessionKey: 'session-a',
        repoPath: '/repo',
        runtime: 'codex',
        lastHeartbeatAt: 123,
      },
    ]);

    const result = await resolveFocusableLaneBinding({
      laneId: 'lane-target',
      packetId: 'pkt-missing',
      sessionKey: 'session-missing',
      runtime: 'codex',
      repoPath: '/fallback',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/lanes?active=false', { cache: 'no-store' });
    expect(result).toMatchObject({
      laneId: 'lane-target',
      sessionKey: 'session-a',
      repoPath: '/repo',
      runtime: 'codex',
      lastHeartbeatAt: '123',
    });
  });

  it('resolves a lane by packetId', async () => {
    mockLaneFetch([
      {
        id: 'lane-other',
        packetId: 'pkt-other',
        sessionKey: 'session-other',
        repoPath: '/other',
        runtime: 'codex',
      },
      {
        id: 'lane-packet',
        packetId: 'pkt-target',
        sessionKey: 'session-target',
        worktreePath: '/worktree',
        runtime: 'claude-code',
      },
    ]);

    await expect(resolveFocusableLaneBinding({
      packetId: 'pkt-target',
      runtime: 'codex',
      repoPath: '/fallback',
    })).resolves.toMatchObject({
      laneId: 'lane-packet',
      sessionKey: 'session-target',
      repoPath: '/worktree',
      worktreePath: '/worktree',
      runtime: 'claude-code',
    });
  });

  it('resolves a lane by sessionKey', async () => {
    mockLaneFetch([
      {
        id: 'lane-session',
        packetId: 'pkt-session',
        sessionKey: 'session-target',
        runtime: null,
      },
    ]);

    await expect(resolveFocusableLaneBinding({
      sessionKey: 'session-target',
      runtime: 'gemini',
      repoPath: '/fallback',
    })).resolves.toMatchObject({
      laneId: 'lane-session',
      sessionKey: 'session-target',
      repoPath: '/fallback',
      runtime: 'gemini',
    });
  });

  it('returns null when no lane matches', async () => {
    mockLaneFetch([
      {
        id: 'lane-other',
        packetId: 'pkt-other',
        sessionKey: 'session-other',
        runtime: 'codex',
      },
    ]);

    await expect(resolveFocusableLaneBinding({
      laneId: 'lane-missing',
      packetId: 'pkt-missing',
      sessionKey: 'session-missing',
      runtime: 'codex',
    })).resolves.toBeNull();
  });
});

describe('fetchLaneBinding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when the lane endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await expect(fetchLaneBinding({
      laneId: 'lane-target',
      fallbackRuntime: 'codex',
    })).resolves.toBeNull();
  });
});
