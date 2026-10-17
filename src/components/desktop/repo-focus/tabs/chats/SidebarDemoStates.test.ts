// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatsTab } from '../ChatsTab';
import { SidebarHeaderActions } from '../../../shell/SidebarHeaderActions';
import { setSidebarView } from './sidebar-view-store';
import type { SidebarFixture } from '@/lib/ui/sidebar-fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const repo = { id: 'test', name: 'project', localPath: '/tmp/sidebar-project', remoteUrl: null, defaultBranch: 'main' };
const states: SidebarFixture['state'][] = ['running', 'stuck', 'failed', 'waiting', 'finished', 'merged', 'review', 'rejected', 'idle'];
const fixtures: SidebarFixture[] = states.map((state, index) => ({
  tabId: `thoughts-sidebar-demo-test-${state}`, title: `Demo · ${state}`, state, scheduled: index === 0 || index === 8,
  repoName: repo.name, repoPath: repo.localPath, branch: `demo/${state}`, preview: `Synthetic ${state} update`,
  updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
}));

describe('seeded states through the actual compact chat panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  const open = vi.fn();
  const fetchMock = vi.fn();
  const stateNames = () => [...container.querySelectorAll('[data-o8-demo-state]')].map((node) => node.getAttribute('data-o8-demo-state'));
  const render = async () => {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(SidebarHeaderActions, { onSearch: vi.fn() }),
      createElement(ChatsTab, { repos: [repo], variant: 'mini', groupMode: 'flat', showLiveSessions: false, onOpenHistoryChat: open }),
    )));
  };
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development'); localStorage.clear(); open.mockReset(); fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) => ({ ok: true, json: async () => String(url).includes('sidebar-fixtures')
      ? { schema: 'o8/ui-sidebar-fixtures/v1', synthetic: true, fixtures }
      : String(url).includes('chat-history/list') ? { conversations: fixtures.map((sample) => ({
        ...sample, modifiedAt: sample.updatedAt, savedAt: sample.updatedAt, model: 'codex', backend: 'codex',
        messageCount: 3, empty: false, pinned: false, starred: false,
      })) } : { lanes: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  it('shows every family once, real marks beside timestamps, and a notification without launching work', async () => {
    await render(); await act(async () => setSidebarView('flat'));
    expect(stateNames()).toEqual(expect.arrayContaining(states));
    expect(container.querySelectorAll('[data-o8-demo-state]')).toHaveLength(states.length);
    expect(container.querySelectorAll('[data-o8-demo-state] .o8-fam')).toHaveLength(states.length);
    expect(container.querySelector('[aria-label="Priority chats"] [data-attention-dot]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Merged"]')).toBeNull();
    expect(container.querySelector('[aria-label="Scheduled task"]')?.getAttribute('stroke')).toBe('var(--t-text-muted)');
    expect(container.querySelector('[data-o8-demo-state]')?.innerHTML).not.toContain('color-mix');
    expect(container.textContent?.match(/Demo · merged/g)).toHaveLength(1);
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => /launch|retry|schedule|packet-transcript/.test(String(url)))).toBe(false);
  });
  it('opens the saved sample in its repo context and keeps its state visible after reading', async () => {
    await render(); await act(async () => setSidebarView('flat'));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-o8-demo-state="merged"] button')!.click());
    expect(open).toHaveBeenCalledWith('thoughts-sidebar-demo-test-merged', 'Demo · merged', {
      name: repo.name, localPath: repo.localPath, branch: 'demo/merged',
    });
    expect(stateNames()).toContain('merged');
    expect(localStorage.getItem('o8:row-last-visited')).toContain('ui-demo:thoughts-sidebar-demo-test-merged');
  });
  it('filters working and scheduled samples and restores all samples in repo mode', async () => {
    await render(); await act(async () => setSidebarView('working'));
    expect(stateNames()).toContain('running'); expect(stateNames()).not.toContain('idle');
    await act(async () => setSidebarView('scheduled'));
    expect(stateNames()).toEqual(['running', 'idle']);
    await act(async () => setSidebarView('repo'));
    expect(stateNames()).toHaveLength(states.length);
    expect(container.querySelector('[data-o8-sidebar-demo]')?.textContent).toContain('Demo states');
  });
  it('keeps chronological samples compact under dated history after pinned chats', async () => {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(12, 0, 0, 0);
    const older = new Date(); older.setDate(older.getDate() - 3); older.setHours(12, 0, 0, 0);
    const dated = fixtures.map((sample) => ({ ...sample, updatedAt: sample.state === 'finished' ? yesterday.toISOString()
      : sample.state === 'idle' ? older.toISOString() : sample.updatedAt }));
    fetchMock.mockImplementation(async (url) => ({ ok: true, json: async () => String(url).includes('sidebar-fixtures')
      ? { schema: 'o8/ui-sidebar-fixtures/v1', synthetic: true, fixtures: dated }
      : String(url).includes('chat-history/list') ? { conversations: [
        { tabId: 'thoughts-pinned', title: 'Pinned chat', preview: 'Pinned preview', modifiedAt: older.toISOString(),
          savedAt: older.toISOString(), model: 'codex', backend: 'codex', messageCount: 2, empty: false,
          pinned: true, starred: false, repoPath: repo.localPath, repoName: repo.name },
        ...dated.map((sample) => ({ ...sample, modifiedAt: sample.updatedAt, savedAt: sample.updatedAt,
          model: 'codex', backend: 'codex', messageCount: 3, empty: false, pinned: false, starred: false })),
      ] } : { lanes: [] } }));
    await render(); await act(async () => setSidebarView('chronological'));
    expect(stateNames()).toHaveLength(states.length);
    expect(container.textContent).not.toContain('Synthetic');
    expect(container.textContent).not.toContain('Pinned preview');
    expect(container.textContent).not.toContain('Demo states');
    const shelves = [...container.querySelectorAll('[aria-label$=" conversations"]')].map((node) => node.getAttribute('aria-label'));
    expect(shelves).toEqual(['Pinned conversations', 'Recents conversations', 'Today conversations', 'Yesterday conversations', 'Previous 7 days conversations']);
    expect(container.querySelector('[aria-label="Pinned conversations"]')?.textContent).toContain('Pinned chat');
    expect(container.querySelector('[aria-label="Yesterday conversations"]')?.textContent).toContain('Demo · finished');
    expect(container.querySelector('[aria-label="Previous 7 days conversations"]')?.textContent).toContain('Demo · idle');
    expect(container.querySelectorAll('[data-o8-demo-state] .o8-fam')).toHaveLength(states.length);
    await act(async () => setSidebarView('flat'));
    expect(container.textContent).toContain('Synthetic waiting update');
  });
  it('retains unread completed samples in Working until read, with notifications even when folded', async () => {
    await render(); await act(async () => setSidebarView('working'));
    expect(stateNames()).toContain('finished');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-o8-demo-state="finished"] button')!.click());
    expect(stateNames()).not.toContain('finished');
    expect(container.querySelector('[aria-label="Settled conversations"]')?.textContent).toContain('Settled');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Working conversations"] button[aria-expanded="true"]')!.click());
    expect(stateNames()).toEqual([]);
    expect(container.querySelector('[aria-label="Priority chats"] [data-attention-dot]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Settled conversations"] button[aria-expanded="false"]')!.click());
    expect(stateNames()).toEqual(expect.arrayContaining(['finished', 'idle']));
    expect(stateNames()).not.toContain('running');
  });
  it('does not request display fixtures in production', async () => {
    vi.stubEnv('NODE_ENV', 'production'); await render();
    expect(stateNames()).toEqual([]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('sidebar-fixtures'))).toBe(false);
  });
});
