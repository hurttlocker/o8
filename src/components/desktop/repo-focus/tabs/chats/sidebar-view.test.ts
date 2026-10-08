// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPanelExtraAgents, type LaneSummary } from '../../../AgentPanelExtraAgents';
import { ChatsTab } from '../ChatsTab';
import { CHAT_GROUP_BY_KEY, staysInWorkingView } from './sidebar-view';
import type { ChatHistoryItem } from './types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/components/desktop/OrchestratorHoverCard', () => ({ OrchestratorHoverCard: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const repo = { id: 'test', name: 'project', localPath: '/tmp/sidebar-project', remoteUrl: null, defaultBranch: 'main' };
const history = ['Idle', 'Running', 'Decision', 'Pinned'].map((title, index): ChatHistoryItem => ({
  tabId: `thoughts-${title}`, title, preview: '', empty: false, messageCount: 1, model: 'codex',
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
  const render = async (active = 'thoughts-Idle') => {
    await act(async () => root.render(createElement(ChatsTab, {
      repos: [repo], variant: 'mini', groupMode: 'flat', showLiveSessions: false,
      activeSessionKey: active, onOpenHistoryChat: onOpen, packets,
      agentsSection: (workingOnly) => createElement('span', { 'data-workers': String(workingOnly) }, 'Workers'),
    })));
  };
  const rows = () => Array.from(container.querySelectorAll('[role="button"][title]')).map((row) => row.getAttribute('title')?.split(' · ')[0]);
  const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Change chat view"]')!;
  const choose = async (label: string) => {
    await act(async () => trigger().click());
    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find((button) => button.textContent?.trim() === label)!;
    await act(async () => item.click());
  };
  beforeEach(() => {
    window.localStorage.clear(); onOpen.mockClear();
    vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => String(url).includes('chat-history/list') ? { conversations: history } : { lanes: [] } })));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  it('persists working view, keeps decisions and selected idle chat, and forwards the worker filter', async () => {
    await render(); await choose('Working only');
    expect(rows()).toEqual(expect.arrayContaining(['Idle', 'Running', 'Decision']));
    expect(rows()).not.toContain('Pinned');
    expect(container.querySelector('[data-workers="true"]')).not.toBeNull();
    expect(window.localStorage.getItem(CHAT_GROUP_BY_KEY)).toBe('working');
    await render('thoughts-Running'); expect(rows()).not.toContain('Idle');
    await act(async () => root.unmount()); root = createRoot(container); await render('thoughts-Running');
    expect(container.querySelector('[data-workers="true"]')).not.toBeNull();
    expect(rows()).not.toContain('Idle');
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
  it('centers the hit area, moves keyboard focus in the menu and returns it on Escape', async () => {
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
