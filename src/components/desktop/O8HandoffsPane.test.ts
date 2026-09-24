// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentPresence } from '@/lib/agents/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { O8HandoffsPane } from './O8HandoffsPane';

const repo = { id: 'repo-o8', name: 'o8', localPath: '/workspace/o8' } as RepoRegistryEntry;
const agent: AgentPresence = {
  agentId: 'agent-keen', name: 'Keen', repo: repo.localPath,
  worktreePath: null, runtime: 'codex', sessionKey: 'session-keen',
  laneId: null, packetId: null, lastSeen: new Date().toISOString(),
};
const message: AgentMessage = {
  schema: 'o8/agents.message-event/v1', kind: 'message', sequence: 1, id: 'message-one',
  from: 'operator', to: 'Keen', repo: repo.localPath, text: 'Check the contract.',
  refs: { laneId: null, packetId: null }, delivery: 'poll',
  deliveryNote: 'Waiting for the session inbox.', timestamp: new Date().toISOString(),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function enterMessage(host: HTMLElement, value: string): void {
  const textarea = host.querySelector<HTMLTextAreaElement>('#o8-handoff-message')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('O8HandoffsPane', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('loads a repository exchange and sends to an exact live agent through the message route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/agents/presence?')) return jsonResponse({ agents: [agent] });
      if (url.startsWith('/api/agents/message?')) return jsonResponse({ messages: [message] });
      if (url === '/api/agents/message' && init?.method === 'POST') {
        return jsonResponse({ ok: true, message: { ...message, id: 'message-two', sequence: 2, text: 'Please review this.' } }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(O8HandoffsPane, {
        active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: false,
      }));
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Check the contract.'));
    expect(host.textContent).toContain('Waiting in inbox');
    expect(host.textContent).not.toContain('Delivered');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/agents/message?repo=%2Fworkspace%2Fo8&limit=50')).toBe(true);

    await act(async () => {
      const selector = host.querySelector<HTMLSelectElement>('#o8-handoff-recipient')!;
      selector.value = 'Keen';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      enterMessage(host, 'Please review this.');
    });
    await act(async () => {
      const send = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Send message');
      send?.click();
      send?.click();
    });

    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/agents/message' && init?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/agents/message' && init?.method === 'POST');
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/agents/message' && init?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ repo: repo.localPath, to: 'Keen', text: 'Please review this.' });
    await vi.waitFor(() => expect(host.textContent).toContain('Please review this.'));
    expect(host.querySelector<HTMLTextAreaElement>('#o8-handoff-message')?.value).toBe('');
  });

  it('requires an explicit repository when the shared panel is scoped to all repos', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onRepoPathChange = vi.fn();
    await act(async () => root.render(createElement(O8HandoffsPane, {
      active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: true, onRepoPathChange,
    })));
    expect(host.textContent).toContain('Choose a repository to see its agents and messages.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button:last-child')?.disabled).toBe(true);
  });

  it('keeps a failed message draft and reports a server error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ error: { message: 'Agent went offline.' } }, 404);
      if (String(input).startsWith('/api/agents/presence?')) return jsonResponse({ agents: [agent] });
      return jsonResponse({ messages: [] });
    }));
    await act(async () => root.render(createElement(O8HandoffsPane, {
      active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: false,
    })));
    await vi.waitFor(() => expect(host.querySelector<HTMLSelectElement>('#o8-handoff-recipient')?.options.length).toBe(2));
    await act(async () => {
      const selector = host.querySelector<HTMLSelectElement>('#o8-handoff-recipient')!;
      selector.value = 'Keen';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      enterMessage(host, 'Keep this draft.');
    });
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Send message')?.click());
    await vi.waitFor(() => expect(host.textContent).toContain('Agent went offline.'));
    expect(host.querySelector<HTMLTextAreaElement>('#o8-handoff-message')?.value).toBe('Keep this draft.');
  });
});
