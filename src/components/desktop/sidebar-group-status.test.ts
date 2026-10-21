// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPanelExtraAgents, type LaneSummary } from './AgentPanelExtraAgents';
import { CompactChatHistory } from './repo-focus/tabs/chats/CompactChatHistory';
import type { ChatHistoryItem } from './repo-focus/tabs/chats/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function lane(id: string, status: LaneSummary['status']): LaneSummary {
  return { id, status, label: id, repoPath: '/repos/example', branch: id,
    runtime: 'codex', sessionKey: `codex-owned:${id}`, packetId: `pkt-${id}`,
    ownership: 'managed', lastEventAt: new Date().toISOString(), lastEventLabel: null };
}

describe('sidebar group status', () => {
  it('keeps conversation shelves usable without count badges', async () => {
    const items = [
      { tabId: 'pinned', title: 'Pinned conversation', pinned: true, modifiedAt: new Date().toISOString() },
      { tabId: 'today', title: 'Today conversation', modifiedAt: new Date().toISOString() },
    ] as ChatHistoryItem[];
    await act(async () => root.render(createElement(CompactChatHistory, {
      chatGroupBy: 'chronological', updateChatGroupBy: vi.fn(), priority: [], remainder: items,
      flatHistoryItems: items, flatHistoryDateGroups: [], flatHistoryRepoGroups: [],
      collapsedRepoGroups: new Set<string>(), repoByGroupKey: new Map(), toggleRepoGroup: vi.fn(),
      renderHistoryRow: item => createElement('div', { key: item.tabId }, item.title),
      hiddenChatCount: 0, showMore: vi.fn(), fixtures: [], onOpenHistoryChat: vi.fn(),
    })));
    expect(host.textContent).toContain('Pinned conversation');
    expect(host.textContent).toContain('Today conversation');
    expect(host.querySelector('[aria-label="1 pinned"]')).toBeNull();
    expect(host.querySelector('[aria-label="1 today"]')).toBeNull();
    const collapse = host.querySelector<HTMLButtonElement>('button[title="Hide pinned"]')!;
    await act(async () => collapse.click());
    expect(host.textContent).not.toContain('Pinned conversation');
    await act(async () => collapse.click());
    expect(host.textContent).toContain('Pinned conversation');
  });

  it('retains an accurate working summary when Agents is collapsed', async () => {
    const lanes = [lane('running', 'running'), lane('idle', 'idle'), lane('failed', 'failed'), lane('done', 'completed')];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({
      ok: true, json: async () => String(input).includes('/api/lanes') ? { lanes } : {},
    })));
    await act(async () => root.render(createElement(AgentPanelExtraAgents)));
    expect(host.querySelector('[aria-label="1 agent working"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Hide agents"]')!.click());
    expect(host.querySelector('[role="list"][aria-label="Agents"]')).toBeNull();
    expect(host.querySelector('[aria-label="1 agent working"]')).not.toBeNull();
    expect(host.querySelector('[aria-label$=" agents"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Show agents"]')!.click());
    expect(host.querySelector('[role="list"][aria-label="Agents"]')).not.toBeNull();
  });
});
