// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPanelExtraAgents, type LaneSummary } from '../../../AgentPanelExtraAgents';
import { SidebarHeaderActions } from '../../../shell/SidebarHeaderActions';
import { ChatsTab } from '../ChatsTab';
import { CHAT_GROUP_BY_KEY } from './sidebar-view';
import { COMPLETION_START_KEY, getLastVisited, markVisited } from './read-state';
import type { ChatHistoryItem } from './types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/components/desktop/OrchestratorHoverCard', () => ({ OrchestratorHoverCard: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const repo = { id: 'project', name: 'project', localPath: '/tmp/sidebar-project', remoteUrl: null, defaultBranch: 'main' };
const started = Date.now() - 60_000;
const completed = Date.now() - 1_000;
function lane(id: string, status: LaneSummary['status'] = 'running'): LaneSummary {
  return { id, label: `${id} worker`, repoPath: repo.localPath, branch: 'main', runtime: 'codex',
    sessionKey: `codex-owned:${id}`, packetId: null, status, ownership: 'managed',
    lastEventAt: new Date(status === 'running' ? started : completed).toISOString(), lastEventLabel: null };
}

describe('completion notifications through the live sidebar components', () => {
  let root: Root;
  let container: HTMLDivElement;
  let lanes: LaneSummary[];
  const bell = () => container.querySelector<HTMLButtonElement>('[aria-label="Priority chats"]')!;
  const dot = () => bell().querySelector('[data-attention-dot]');
  const refresh = async () => { await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile'))); };
  const renderWorkers = async () => {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(SidebarHeaderActions), createElement(AgentPanelExtraAgents, { activeSessionKey: 'codex-owned:one' }))));
  };
  beforeEach(() => {
    localStorage.clear(); lanes = [lane('one')];
    vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () =>
      String(url).includes('/api/lanes') ? { lanes } : { agents: [], repos: [], approvals: [] } })));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('notifies even for the selected packetless worker, survives polling and clears only on opening', async () => {
    await renderWorkers(); expect(dot()).toBeNull();
    lanes = [lane('one', 'completed')]; await refresh();
    expect(dot()).not.toBeNull(); expect(container.textContent).toContain('Finished');
    await act(async () => bell().click()); expect(dot()).not.toBeNull();
    await refresh(); expect(dot()).not.toBeNull();
    const row = container.querySelector<HTMLButtonElement>('[data-o8-agent-row="lane:one"]')!;
    await act(async () => row.click());
    expect(dot()).toBeNull(); expect(container.textContent).toContain('one worker');
    expect(getLastVisited('lane:one')).not.toBeNull();
    await act(async () => root.unmount()); root = createRoot(container); await renderWorkers();
    expect(dot()).toBeNull(); expect(container.textContent).toContain('one worker');
    await refresh(); expect(container.textContent).toContain('one worker');
    lanes = [{ ...lane('one', 'completed'), lastEventAt: new Date(Date.now() + 1_000).toISOString() }];
    await refresh(); expect(dot()).not.toBeNull();
  });

  it('retains unread auto-archived outcomes beyond 24 hours and the usual eight-row cap; respects dismissal', async () => {
    localStorage.setItem(COMPLETION_START_KEY, String(Date.now() - 4 * 86_400_000));
    lanes = Array.from({ length: 10 }, (_, index) => ({ ...lane(String(index), 'archived'), outcome: 'no_changes' as const,
      lastEventAt: new Date(Date.now() - 2 * 86_400_000 - index * 1_000).toISOString() }));
    lanes.push({ ...lane('dismissed', 'completed'), archivedByOperator: true });
    await renderWorkers();
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(10);
    expect(container.textContent).not.toContain('dismissed worker'); expect(dot()).not.toBeNull();
    await act(async () => { for (const item of lanes) markVisited(`lane:${item.id}`); });
    await refresh(); expect(dot()).toBeNull(); expect(container.textContent).not.toContain('0 worker');
  });

  it('acknowledges a released packet when its parent chat opens and retains the saved preview', async () => {
    const history: ChatHistoryItem = { tabId: 'thread', title: 'Parent chat', preview: 'Saved completion summary',
      empty: false, messageCount: 2, model: 'codex', savedAt: new Date(started).toISOString(),
      modifiedAt: new Date(completed).toISOString(), starred: false, pinned: false, repoPath: repo.localPath };
    const packet: OrchestratorPacket = { id: 'finished-packet', title: 'Worker', workspaceTargetPath: repo.localPath,
      branchTarget: 'main', orchestratorThreadId: 'thread', status: 'released', releaseState: 'released',
      lastEventAt: new Date(completed).toISOString(), runtime: 'codex', referenceLabel: 'Worker', summary: 'Worker',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued' };
    localStorage.setItem(CHAT_GROUP_BY_KEY, 'flat');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ conversations: [history], lanes: [] }) })));
    const show = async () => { await act(async () => root.render(createElement(Fragment, null,
      createElement(SidebarHeaderActions), createElement(ChatsTab, { repos: [repo], variant: 'mini',
        showLiveSessions: false, packets: [packet], onOpenHistoryChat: vi.fn() })))); };
    await show(); expect(dot()).not.toBeNull(); expect(container.textContent).toContain(history.preview);
    const row = container.querySelector<HTMLElement>('[role="button"][title^="Parent chat"]')!;
    await act(async () => row.click()); expect(dot()).toBeNull();
    expect(container.textContent).toContain(history.preview); expect(getLastVisited('packet:finished-packet')).not.toBeNull();
    await act(async () => root.unmount()); root = createRoot(container); await show(); expect(dot()).toBeNull();
  });
});
