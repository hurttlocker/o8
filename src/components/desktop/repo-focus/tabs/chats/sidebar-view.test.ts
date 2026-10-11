// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPanelExtraAgents, type LaneSummary } from '../../../AgentPanelExtraAgents';
import { ChatsTab } from '../ChatsTab';
import { SidebarHeaderActions } from '../../../shell/SidebarHeaderActions';
import { CHAT_GROUP_BY_KEY, staysInWorkingView } from './sidebar-view';
import type { ChatHistoryItem } from './types';
import type { IdeWorkspaceSession } from '../../types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/components/desktop/OrchestratorHoverCard', () => ({ OrchestratorHoverCard: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const repo = { id: 'test', name: 'project', localPath: '/tmp/sidebar-project', remoteUrl: null, defaultBranch: 'main' };
const history = ['Idle', 'Running', 'Decision', 'Pinned'].map((title, index): ChatHistoryItem => ({
  tabId: `thoughts-${title}`, title, preview: `Latest update for ${title}`, empty: false, messageCount: 1, model: 'codex',
  savedAt: new Date(Date.now() - index * 60_000).toISOString(),
  modifiedAt: new Date(Date.now() - index * 60_000).toISOString(),
  starred: false, pinned: title === 'Pinned', repoPath: repo.localPath, repoName: repo.name, repoBranch: 'main',
}));
const packets = ['Running', 'Decision'].map((title) => ({
  id: `packet-${title}`, title, workspaceTargetPath: repo.localPath, branchTarget: 'main',
  orchestratorThreadId: `thoughts-${title}`, status: title === 'Running' ? 'running' : 'awaiting_review',
  lastEventAt: new Date().toISOString(), runtime: 'codex',
  referenceLabel: title, summary: title, dependencyLabels: [], dependencyPacketIds: [],
  queueState: 'queued', releaseState: 'pending',
}) satisfies OrchestratorPacket);

describe('compact sidebar view through the chat panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpen = vi.fn();
  const onSearch = vi.fn();
  const render = async (active = 'thoughts-Idle') => {
    await act(async () => root.render(createElement(Fragment, null, createElement(SidebarHeaderActions, { onSearch }), createElement(ChatsTab, {
      repos: [repo], variant: 'mini', groupMode: 'flat', showLiveSessions: false,
      activeSessionKey: active, onOpenHistoryChat: onOpen, packets,
      agentsSection: (workingOnly) => createElement('span', { 'data-workers': String(workingOnly) }, 'Workers'),
    }))));
  };
  const rows = () => Array.from(container.querySelectorAll('[role="button"][title]:not([aria-expanded])')).map((row) => row.getAttribute('title')?.split(' · ')[0]);
  const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Change chat view"]')!;
  const choose = async (label: string) => {
    await act(async () => trigger().click());
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.trim() === label)!;
    await act(async () => item.click());
  };
  beforeEach(() => {
    window.localStorage.clear(); onOpen.mockClear(); onSearch.mockClear();
    vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => String(url).includes('chat-history/list') ? { conversations: history } : { lanes: [] } })));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  it('toggles priority from the header, shows previews and restores the normal view without opening a chat', async () => {
    await render();
    const bell = container.querySelector<HTMLButtonElement>('[aria-label="Priority chats"]')!;
    expect(bell.getAttribute('aria-pressed')).toBe('false');
    expect(bell.querySelector('[data-attention-dot]')).not.toBeNull();
    expect(container.textContent).not.toContain('Latest update for');
    expect(container.textContent).not.toContain('Nothing needs attention');
    await act(async () => bell.click());
    expect(bell.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Latest update for Decision');
    expect(container.textContent).toContain('Latest update for Running');
    expect(window.localStorage.getItem(CHAT_GROUP_BY_KEY)).toBe('flat');
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => bell.click());
    expect(container.textContent).not.toContain('Latest update for');
    expect(window.localStorage.getItem(CHAT_GROUP_BY_KEY)).toBe('chronological');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Search chats"]')!.click());
    expect(onSearch).toHaveBeenCalledOnce();
  });
  it('persists working shelves, keeps pins and decisions, and forwards the worker filter', async () => {
    await render(); await choose('Working');
    expect(rows()).toEqual(expect.arrayContaining(['Idle', 'Running', 'Decision']));
    expect(rows()).toContain('Pinned');
    expect(container.querySelector('[data-workers="true"]')).not.toBeNull();
    expect(window.localStorage.getItem(CHAT_GROUP_BY_KEY)).toBe('working');
    await render('thoughts-Running'); expect(rows()).not.toContain('Idle');
    await act(async () => root.unmount()); root = createRoot(container); await render('thoughts-Running');
    expect(container.querySelector('[data-workers="true"]')).not.toBeNull();
    expect(rows()).not.toContain('Idle');
  });
  it('orders Priority, Pinned and dated history without duplicates and remembers date folds', async () => {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(12, 0, 0, 0);
    const older = new Date(); older.setDate(older.getDate() - 3); older.setHours(12, 0, 0, 0);
    const dated = history.map(item => ({ ...item, messageCount: 2,
      modifiedAt: item.title === 'Idle' ? yesterday.toISOString() : item.modifiedAt }));
    dated.push({ ...history[0]!, tabId: 'thoughts-Today', title: 'Today work', messageCount: 2 });
    dated.push({ ...history[0]!, tabId: 'thoughts-Older', title: 'Older work', messageCount: 2, modifiedAt: older.toISOString() });
    vi.mocked(fetch).mockImplementation(async url => ({ ok: true, json: async () => String(url).includes('chat-history/list') ? { conversations: dated } : { lanes: [] } }) as Response);
    await render('thoughts-Running'); await choose('Priority');
    const shelves = [...container.querySelectorAll('[aria-label$=" conversations"]')].map(node => node.getAttribute('aria-label'));
    expect(shelves.slice(0, 5)).toEqual(['Priority conversations', 'Pinned conversations', 'Today conversations', 'Yesterday conversations', 'Previous 7 days conversations']);
    expect(container.querySelector('[aria-label="Recents conversations"]')).toBeNull();
    expect(rows()).toEqual(expect.arrayContaining(['Idle', 'Running', 'Decision', 'Pinned', 'Older work']));
    expect(new Set(rows()).size).toBe(rows().length);
    const yesterdayToggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Yesterday conversations"] button[aria-expanded]')!;
    await act(async () => yesterdayToggle().click()); expect(rows()).not.toContain('Idle');
    expect(rows()).toContain('Pinned'); expect(container.querySelector('[data-attention-dot]')).not.toBeNull();
    await act(async () => root.unmount()); root = createRoot(container); await render('thoughts-Running');
    expect(yesterdayToggle().getAttribute('aria-expanded')).toBe('false'); expect(rows()).not.toContain('Idle');
  });
  it('folds quiet history without removing pins or notifications and remembers the shelves', async () => {
    await render('thoughts-Running'); await choose('Working');
    const shelf = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label} conversations"]`)!;
    expect(shelf('Pinned').textContent).toContain('Pinned');
    expect(shelf('Working').textContent).toContain('Running');
    expect(shelf('Settled').querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(rows()).not.toContain('Idle');
    await act(async () => shelf('Settled').querySelector('button')!.click());
    expect(shelf('Settled').textContent).toContain('Idle');
    await act(async () => shelf('Working').querySelector('button')!.click());
    expect(rows()).not.toContain('Running');
    expect(rows()).toContain('Pinned');
    expect(container.querySelector('[data-attention-dot]')).not.toBeNull();
    await act(async () => root.unmount()); root = createRoot(container); await render('thoughts-Running');
    expect(shelf('Working').querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(shelf('Settled').querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(rows()).not.toContain('Running'); expect(rows()).toContain('Idle');
    await choose('Chronological'); expect(rows()).toEqual(expect.arrayContaining(['Idle', 'Running', 'Decision', 'Pinned']));
  });
  it('keeps chronological order and routing context on selection; preserves repo and date views', async () => {
    await render(); await choose('Chronological'); const before = rows();
    const row = Array.from(container.querySelectorAll<HTMLElement>('[role="button"][title]')).find((row) => row.title.startsWith('Pinned ·'))!;
    await act(async () => row.click());
    expect(onOpen).toHaveBeenCalledWith('thoughts-Pinned', 'Pinned', expect.objectContaining({ localPath: repo.localPath }));
    await render('thoughts-Pinned'); expect(rows()).toEqual(before);
    await choose('Group by repo'); expect(container.textContent).toContain('project');
    await choose('Group by date'); expect(container.textContent).toContain('Today');
  });
  it('folds each chat section in every view and retains attention while a section is closed', async () => {
    await render();
    const shelfButton = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label} conversations"] button[aria-expanded]`)!;
    await act(async () => shelfButton('Pinned').click());
    expect(rows()).not.toContain('Pinned');
    expect(rows()).toContain('Idle');
    await act(async () => shelfButton('Pinned').click());
    await act(async () => shelfButton('Recents').click());
    expect(rows()).toEqual(['Pinned']);
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(shelfButton('Recents').getAttribute('aria-expanded')).toBe('false');
    await act(async () => shelfButton('Recents').click());
    await choose('Priority');
    expect(rows()).toContain('Decision');
    await act(async () => shelfButton('Priority').click());
    expect(rows()).not.toContain('Decision');
    expect(rows()).toContain('Pinned');
    expect(container.querySelector('[data-attention-dot]')).not.toBeNull();
    await choose('Group by date');
    await act(async () => shelfButton('Today').click());
    expect(rows()).toEqual([]);
    await act(async () => shelfButton('Today').click());
    await choose('Group by repo');
    const group = container.querySelector<HTMLElement>('[role="button"][aria-expanded]')!;
    await act(async () => group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(rows()).toEqual([]);
    expect(group.getAttribute('aria-expanded')).toBe('false');
    await act(async () => group.click());
    expect(rows()).toContain('Idle');
  });
  it('shows only scheduled chats owned here, retains notifications and restores the selected view', async () => {
    const sessions = [
      { sessionKey: 'llm-chat:thoughts-Pinned', sessionKind: 'automation', workspace: repo.localPath,
        runtimeSurface: { ownership: 'owned' } },
      { sessionKey: 'llm-chat:thoughts-Idle', sessionKind: 'automation', workspace: repo.localPath,
        runtimeSurface: { ownership: 'discovered' } },
      { sessionKey: 'llm-chat:thoughts-Running', sessionKind: 'chat', workspace: repo.localPath,
        runtimeSurface: { ownership: 'owned' } },
      { sessionKey: 'owned-schedule', name: 'Owned scheduled run', sessionKind: 'automation', workspace: repo.localPath,
        branch: 'main', runtime: 'codex', status: 'idle', lastEventAt: new Date().toISOString(),
        runtimeSurface: { ownership: 'owned' } },
    ] as IdeWorkspaceSession[];
    const show = async () => act(async () => root.render(createElement(Fragment, null,
      createElement(SidebarHeaderActions), createElement(ChatsTab, { repos: [repo], variant: 'mini',
        groupMode: 'flat', showLiveSessions: false, packets, ideWorkspaceSessions: sessions,
        onOpenHistoryChat: onOpen, agentsSection: createElement('span', null, 'Worker section') }))));
    await show(); await choose('Scheduled');
    expect(rows()).toContain('Pinned'); expect(rows()).not.toContain('Idle'); expect(rows()).not.toContain('Running');
    expect(container.textContent).toContain('Owned scheduled run');
    expect(container.querySelector<HTMLElement>('[data-sidebar-workers]')?.style.display).toBe('none');
    expect(container.querySelector('[data-attention-dot]')).not.toBeNull();
    expect(window.localStorage.getItem(CHAT_GROUP_BY_KEY)).toBe('scheduled');
    const scheduled = container.querySelector<HTMLButtonElement>('[aria-label="Scheduled conversations"] button[aria-expanded]')!;
    await act(async () => scheduled.click());
    expect(rows()).toEqual([]);
    expect(container.textContent).not.toContain('Owned scheduled run');
    expect(container.querySelector('[data-attention-dot]')).not.toBeNull();
    await act(async () => scheduled.click());
    await act(async () => root.unmount()); root = createRoot(container); await show();
    expect(rows()).toContain('Pinned'); expect(rows()).not.toContain('Idle');
    await choose('Chronological'); expect(rows()).toContain('Idle');
  });
  it('centers the hit area, moves keyboard focus in the menu and returns it on Escape', async () => {
    window.localStorage.setItem(CHAT_GROUP_BY_KEY, 'flat');
    await render(); expect(trigger().style.justifyContent).toBe('center');
    await act(async () => trigger().click());
    expect(document.activeElement?.textContent).toBe('Priority');
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement?.textContent).toBe('Chronological');
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(trigger()); expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
  it('filters actual worker rows without hiding decisions or the selected idle worker', async () => {
    const lanes: LaneSummary[] = ['running', 'idle', 'failed'].map((status) => ({
      id: status, label: `${status} worker`, repoPath: repo.localPath, branch: 'main', runtime: 'codex',
      sessionKey: `codex-owned:${status}`, packetId: null, status: status as LaneSummary['status'],
      ownership: 'managed', lastEventAt: new Date().toISOString(), lastEventLabel: null,
    }));
    vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true,
      json: async () => String(url).includes('/api/lanes') ? { lanes } : { agents: [], repos: [] },
    })));
    const showWorkers = async (activeSessionKey: string | null) => {
      await act(async () => root.render(createElement(AgentPanelExtraAgents, { workingOnly: true, activeSessionKey })));
    };
    await showWorkers(null);
    expect(container.textContent).toContain('running worker');
    expect(container.textContent).toContain('failed worker');
    expect(container.textContent).not.toContain('idle worker');
    await showWorkers('codex-owned:idle'); expect(container.textContent).toContain('idle worker');
  });
  it('does not classify idle, queued, paused or completed work as running', () => {
    for (const status of ['idle', 'queued', 'paused', 'completed', 'merged']) expect(staysInWorkingView({ status })).toBe(false);
    expect(staysInWorkingView({ status: 'running', outcome: 'no_changes' })).toBe(false);
    expect(staysInWorkingView({ status: 'blocked' })).toBe(true);
  });
});
