// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentPanelExtraAgents, type LaneSummary } from '../../../AgentPanelExtraAgents';
import { ChatsTab } from '../ChatsTab';
import type { ChatHistoryItem } from './types';
import { SIDEBAR_AGENT_PINS_KEY } from './use-sidebar-agent-pins';

vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false }));
const repo = { id: 'site', name: 'site', localPath: '/repos/site', remoteUrl: null, defaultBranch: 'main' };
let host: HTMLDivElement; let root: Root; let lanes: LaneSummary[]; let history: ChatHistoryItem[];
const onOpen = vi.fn();
const render = () => act(async () => root.render(createElement(AgentPanelExtraAgents, {
  renderContent: (entries, actions) => createElement(ChatsTab, { repos: [repo], variant: 'mini',
    groupMode: 'flat', showLiveSessions: false, onOpenHistoryChat: onOpen,
    agentEntries: entries, agentViewActions: actions }),
})));
const row = (id: string) => host.querySelector<HTMLElement>(`[data-o8-agent-row="lane:${id}"]`);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === label)!;
async function choose(label: string) {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change chat view"]')!.click());
  await act(async () => button(label).click());
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); onOpen.mockClear();
  lanes = (['running', 'failed', 'completed'] as const).map((status, index) => ({
    id: status, label: `Worker ${status}`, repoPath: repo.localPath, branch: `topic/${status}`,
    runtime: 'codex', sessionKey: `worker-${status}`, packetId: `packet-${status}`, status, ownership: 'managed',
    outcome: status === 'completed' ? 'no_changes' : null,
    lastEventAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(), lastEventLabel: 'progress',
  }));
  history = [{ tabId: 'thoughts-chat', title: 'Regular chat', preview: 'Conversation preview',
    empty: false, messageCount: 2, model: 'codex', savedAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(), pinned: false, starred: false, repoPath: repo.localPath }];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = String(input);
    if (url.includes('chat-history/list')) return Response.json({ conversations: history });
    if (url.startsWith('/api/lanes?')) return Response.json({ lanes });
    if (url.startsWith('/api/runtime/inventory')) return Response.json({ agents: [], meta: { mode: 'live' } });
    return Response.json({ approvals: [], fixtures: [] });
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('places live workers in every normal view and opens the exact worker without a separate Agents section', async () => {
  await render();
  expect(row('running')?.closest('[aria-label="Today conversations"]')).toBeTruthy();
  expect(host.querySelector('[aria-label="Agents"]')).toBeNull();
  for (const mode of ['Priority', 'Chronological', 'Group by date', 'Group by repo', 'Working']) {
    await choose(mode);
    expect(row('running')).not.toBeNull(); expect(row('failed')).not.toBeNull();
    expect(host.querySelectorAll('[data-o8-agent-row="lane:running"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="Agents"]')).toBeNull();
  }
  const focus = vi.fn(); window.addEventListener('o8:focus-spawned-agent-lane', focus);
  try {
    await act(async () => row('running')!.click());
    expect(focus).toHaveBeenCalledOnce();
    expect((focus.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      packetId: 'packet-running', sessionKey: 'worker-running', laneId: 'running',
    });
    expect(onOpen).not.toHaveBeenCalled();
  } finally { window.removeEventListener('o8:focus-spawned-agent-lane', focus); }
  await choose('Scheduled'); expect(host.querySelector('[data-o8-agent-row]')).toBeNull();
});

it('pins and unpins through the worker menu and restores the pin after remount', async () => {
  await render();
  await act(async () => row('running')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 100 })));
  await act(async () => button('Pin').click());
  expect(row('running')?.closest('[aria-label="Pinned conversations"]')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(SIDEBAR_AGENT_PINS_KEY)!)).toContain('lane:running');
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(row('running')?.closest('[aria-label="Pinned conversations"]')).toBeTruthy();
  await act(async () => row('running')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 100 })));
  await act(async () => button('Unpin').click());
  expect(row('running')?.closest('[aria-label="Pinned conversations"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem(SIDEBAR_AGENT_PINS_KEY)!)).toEqual([]);
});

it('retains an old pinned completion but never resurrects an operator-archived worker', async () => {
  lanes = [{ ...lanes[2], lastEventAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }];
  localStorage.setItem(SIDEBAR_AGENT_PINS_KEY, JSON.stringify(['lane:completed']));
  await render(); expect(row('completed')).not.toBeNull();
  lanes = [{ ...lanes[0], archivedByOperator: true }];
  await act(async () => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
  expect(row('completed')).toBeNull();
});

it('deduplicates an exact saved-chat return path without hiding the parent conversation', async () => {
  lanes = [{ ...lanes[0], sessionKey: 'llm-chat:thoughts-worker' }];
  history.push({ ...history[0], tabId: 'thoughts-worker', title: 'Worker transcript' });
  await render();
  expect(host.textContent).toContain('Regular chat'); expect(host.textContent).toContain('Worker transcript');
  expect(row('running')).toBeNull();
});

it('keeps clear-finished reachable from the view menu without clearing live work', async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change chat view"]')!.click());
  await act(async () => button('Clear 2 finished agents').click());
  expect(row('running')).not.toBeNull();
  expect(row('completed')).toBeNull(); expect(row('failed')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/lanes/archive-terminal' && init?.method === 'POST')).toBe(true);
});
