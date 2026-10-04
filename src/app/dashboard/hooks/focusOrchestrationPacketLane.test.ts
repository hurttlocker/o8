import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { fetchLaneBinding, focusOrchestrationPacketLaneInWorkspace, resolveFocusableLaneBinding } from './focusOrchestrationPacketLane';

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

  it('resolves a cloud Search result to its project instead of the remote checkout', async () => {
    mockLaneFetch([{ id: 'lane-cloud', sessionKey: 'cloud:job', runtime: 'cloud', repoPath: '/project', worktreePath: '/remote/checkout' }]);
    await expect(resolveFocusableLaneBinding({ sessionKey: 'cloud:job', runtime: 'cloud' })).resolves.toMatchObject({
      repoPath: '/project', worktreePath: '/remote/checkout', sessionKey: 'cloud:job', runtime: 'cloud',
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


describe('opening cloud packet sessions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])('keeps the packet repository when an existing tab is %s', async (existing) => {
    const packet = {
      id: 'packet-cloud', title: 'Review task', runtime: 'cloud',
      workspaceTargetPath: '/project',
      lane: { laneId: 'lane-cloud', tileId: 'tile-root', tabId: 'cloud-tab', sessionKey: 'cloud:job', runtime: 'cloud', repoPath: '/project' },
    } as OrchestratorPacket;
    mockLaneFetch([{ id: 'lane-cloud', sessionKey: 'cloud:job', runtime: 'cloud', repoPath: '/project', worktreePath: '/remote/checkout' }]);
    const openCliChatSession = vi.fn().mockReturnValue('cloud-tab');
    const handle = {
      focusTab: vi.fn().mockReturnValue(existing), getChatTabSnapshots: vi.fn().mockReturnValue([]), openCliChatSession,
    } as unknown as TerminalTabHandle;
    focusOrchestrationPacketLaneInWorkspace({
      packet, setActiveTileId: vi.fn(),
      waitForWorkspaceTerminalTarget: vi.fn().mockResolvedValue({ tileId: 'tile-root', handle }),
      workspaceTerminalHandlesRef: { current: new Map([['tile-root', handle]]) },
    });
    await vi.waitFor(() => expect(openCliChatSession).toHaveBeenCalledWith(expect.objectContaining({
      runtime: 'cloud', targetSessionKey: 'cloud:job', repo: { name: 'project', localPath: '/project' },
    })));
  });
});
