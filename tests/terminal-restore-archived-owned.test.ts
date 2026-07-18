import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeRestoredTabs, type ApplyPersistedStateOptions } from '@/components/desktop/workspace-terminal/terminal-restore';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import type { PersistedTabState } from '@/lib/terminal/tab-state';

const OPTIONS: ApplyPersistedStateOptions = {
  preferredRepo: { name: 'o8', localPath: '/tmp/o8' },
  defaultTab: 'terminal',
  createDefaultChatTab: (): TerminalTab => ({
    id: 'workspace-llm-chat-test',
    label: 'Chat',
    kind: 'llm-chat',
    tmuxSession: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  }),
};

function ownedChatTab(id: string, sessionKey: string, packetId?: string) {
  return {
    id,
    label: id,
    kind: 'chat' as const,
    cliAgent: 'codex',
    chatRuntime: 'codex' as const,
    chatSessionKey: sessionKey,
    repoName: 'o8',
    repoPath: '/tmp/o8',
    orchestrationPacket: packetId ? {
      packetId,
      referenceLabel: 'o8.1',
      title: `Lane ${packetId}`,
      status: 'awaiting_review' as const,
      runtime: 'codex' as const,
    } : undefined,
  };
}

function savedState(tabs: PersistedTabState['tabs']): PersistedTabState {
  return { version: 1, activeTabId: tabs[0]?.id ?? '', tabs, savedAt: new Date().toISOString() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('computeRestoredTabs — archived owned sessions', () => {
  it('drops an owned chat tab positively confirmed archived', async () => {
    const sessionKey = 'codex-owned:codex-owned-archived';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      states: { [sessionKey]: 'archived' },
    }), { status: 200 })));

    const result = await computeRestoredTabs(savedState([
      ownedChatTab('tab-archived', sessionKey),
    ]), OPTIONS);

    expect(result?.tabs.map((tab) => tab.id)).not.toContain('tab-archived');
  });

  it('keeps an owned chat tab confirmed active', async () => {
    const sessionKey = 'gemini-owned:gemini-owned-active';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      states: { [sessionKey]: 'active' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await computeRestoredTabs(savedState([
      ownedChatTab('tab-active', `codex:${sessionKey}`),
    ]), OPTIONS);

    expect(result?.tabs.map((tab) => tab.id)).toContain('tab-active');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(sessionKey)),
      { cache: 'no-store' },
    );
  });

  it('fail-open: keeps owned chat tabs when the state probe rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const result = await computeRestoredTabs(savedState([
      ownedChatTab('tab-a', 'opencode-owned:opencode-owned-a'),
      ownedChatTab('tab-b', 'cursor-owned:cursor-owned-b'),
    ]), OPTIONS);

    expect(result?.tabs.map((tab) => tab.id)).toEqual(expect.arrayContaining(['tab-a', 'tab-b']));
  });

  it('leaves badge-carrying tabs to the lane sweep even when owned state reports archived', async () => {
    const unbadgedSessionKey = 'codex-owned:codex-owned-active';
    const badgeSessionKey = 'codex-owned:codex-owned-badged';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/lanes')) {
        return new Response(JSON.stringify({ lanes: [{ packetId: 'pkt-badged' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        states: {
          [unbadgedSessionKey]: 'active',
          [badgeSessionKey]: 'archived',
        },
      }), { status: 200 });
    }));

    const result = await computeRestoredTabs(savedState([
      ownedChatTab('tab-unbadged', unbadgedSessionKey),
      ownedChatTab('tab-badged', badgeSessionKey, 'pkt-badged'),
    ]), OPTIONS);

    expect(result?.tabs.map((tab) => tab.id)).toContain('tab-badged');
  });
});
