/**
 * Stale-lane sweep (2026-07-12) — real-path test through computeRestoredTabs.
 *
 * A packet-bound chat tab whose lane left the active registry (archived /
 * pruned) must NOT restore — it renders as a zombie pill in the workspace tab
 * strip forever (operator hit: archived Polish/Huddle lanes resurfacing when
 * a new tab made the pill strip appear). Fail-open doctrine: when the lane
 * probe fails or times out, EVERY tab restores — only a positive "not active"
 * verdict drops one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeRestoredTabs, type ApplyPersistedStateOptions } from '@/components/desktop/workspace-terminal/terminal-restore';
import type { PersistedTabState } from '@/lib/terminal/tab-state';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';

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

function packetChatTab(id: string, packetId: string) {
  return {
    id,
    label: `Lane ${packetId}`,
    kind: 'chat' as const,
    cliAgent: 'codex',
    chatRuntime: 'codex' as const,
    chatSessionKey: `codex-owned:codex-owned-${packetId}`,
    repoName: 'o8',
    repoPath: '/tmp/o8',
    orchestrationPacket: {
      packetId,
      referenceLabel: 'o8.1',
      title: `Lane ${packetId}`,
      status: 'awaiting_review' as const,
      runtime: 'codex' as const,
    },
  };
}

function savedState(tabs: PersistedTabState['tabs']): PersistedTabState {
  return { version: 1, activeTabId: tabs[0]?.id ?? '', tabs, savedAt: new Date().toISOString() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('computeRestoredTabs — stale-lane sweep', () => {
  it('drops a packet-bound chat tab whose lane is not in the active registry, keeps live ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/lanes')) {
        return new Response(JSON.stringify({ lanes: [{ id: 'lane-1', packetId: 'pkt-live' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    const result = await computeRestoredTabs(
      savedState([packetChatTab('tab-dead', 'pkt-dead'), packetChatTab('tab-live', 'pkt-live')]),
      OPTIONS,
    );

    expect(result).not.toBeNull();
    const labels = result!.tabs.map((tab) => tab.id);
    expect(labels).not.toContain('tab-dead');
    expect(labels).toContain('tab-live');
  });

  it('fail-open: keeps every packet-bound tab when the lane probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const result = await computeRestoredTabs(
      savedState([packetChatTab('tab-a', 'pkt-a'), packetChatTab('tab-b', 'pkt-b')]),
      OPTIONS,
    );

    expect(result).not.toBeNull();
    const ids = result!.tabs.map((tab) => tab.id);
    expect(ids).toContain('tab-a');
    expect(ids).toContain('tab-b');
  });
});
