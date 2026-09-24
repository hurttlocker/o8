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
  refs: { laneId: null, packetId: null, identities: { from: null, to: { runtime: 'codex', sessionKey: 'session-keen' } } }, delivery: 'poll',
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

function openComposer(host: HTMLElement): void {
  Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'New handoff to a live agent')?.click();
}

describe('O8HandoffsPane', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sessionStorage.clear();
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
    await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-conversation-id="legacy:message-one"]')?.click());
    expect(document.body.textContent).toContain('Waiting in inbox');
    expect(document.body.textContent).not.toContain('Delivered');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/agents/message?repo=%2Fworkspace%2Fo8&limit=50')).toBe(true);

    await act(async () => openComposer(host));
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
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ repo: repo.localPath, to: 'Keen', text: 'Please review this.', replyToId: null, requestId: expect.any(String) });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Please review this.'));
    expect(host.querySelector<HTMLTextAreaElement>('#o8-handoff-message')).toBeNull();
    expect(host.textContent).toContain('New handoff to a live agent');
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

  it('retains offline identity in history without offering it as a recipient', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/agents/presence?')) return jsonResponse({ agents: [{ ...agent, live: false }] });
      if (String(input).startsWith('/api/agents/message?')) return jsonResponse({ messages: [message] });
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    await act(async () => root.render(createElement(O8HandoffsPane, {
      active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: false,
    })));
    await vi.waitFor(() => expect(host.textContent).toContain('@Keen · Codex · ONKEEN'));
    await act(async () => openComposer(host));
    expect(host.querySelector<HTMLSelectElement>('#o8-handoff-recipient')?.options).toHaveLength(1);
  });

  it('clears a selected recipient when that agent expires and keeps the draft', async () => {
    let live = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/agents/presence?')) return jsonResponse({ agents: [{ ...agent, live }] });
      if (String(input).startsWith('/api/agents/message?')) return jsonResponse({ messages: [] });
      if (init?.method === 'POST') throw new Error('Offline send should not run.');
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => root.render(createElement(O8HandoffsPane, {
      active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: false,
    })));
    await act(async () => openComposer(host));
    await vi.waitFor(() => expect(host.querySelector<HTMLSelectElement>('#o8-handoff-recipient')?.options).toHaveLength(2));
    await act(async () => {
      const selector = host.querySelector<HTMLSelectElement>('#o8-handoff-recipient')!;
      selector.value = 'Keen';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      enterMessage(host, 'Keep the draft.');
    });
    live = false;
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === 'Refresh handoffs')?.click());
    await vi.waitFor(() => expect(host.querySelector<HTMLSelectElement>('#o8-handoff-recipient')?.value).toBe(''));
    expect(host.querySelector<HTMLTextAreaElement>('#o8-handoff-message')?.value).toBe('Keep the draft.');
    expect(Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Send message')?.disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('uses immutable message identities after a codename changes sessions and marks a linked answer', async () => {
    const first: AgentMessage = {
      ...message, from: 'operator', to: 'Keen', text: 'First turn.',
      refs: { laneId: null, packetId: null, identities: { from: null, to: { runtime: 'codex', sessionKey: 'old-session-123456' } } },
      conversation: { id: 'conversation-identity', replyToId: null, turnIndex: 1, turnLimit: 8, remainingTurns: 6, status: 'open', closedReason: null, lastMessageId: 'message-two' },
    };
    const reply: AgentMessage = {
      ...message, id: 'message-two', sequence: 2, from: 'Keen', to: 'operator', text: 'Answer received.',
      refs: { laneId: null, packetId: null, identities: { from: { runtime: 'codex', sessionKey: 'old-session-123456' }, to: null } },
      conversation: { id: 'conversation-identity', replyToId: first.id, turnIndex: 2, turnLimit: 8, remainingTurns: 6, status: 'open', closedReason: null, lastMessageId: 'message-two' },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/agents/presence?')) return jsonResponse({ agents: [{ ...agent, sessionKey: 'new-session-999999', live: true }] });
      if (String(input).startsWith('/api/agents/message?')) return jsonResponse({ messages: [reply, first] });
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    await act(async () => root.render(createElement(O8HandoffsPane, {
      active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: false,
    })));
    await vi.waitFor(() => expect(host.textContent).toContain('Answer received.'));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-conversation-id="conversation-identity"]')?.click());
    const detail = document.body.querySelector('[data-agent-conversation-detail="conversation-identity"]');
    expect(detail?.textContent).toContain('123456');
    expect(detail?.textContent).not.toContain('999999');
    expect(detail?.textContent).toContain('Answered');
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
    await act(async () => openComposer(host));
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

  it('groups linked turns, labels legacy messages, and lets the operator stop a conversation', async () => {
    const linked: AgentMessage = {
      ...message,
      id: 'message-linked',
      text: 'A linked request.',
      conversation: {
        id: 'conversation-one', replyToId: null, turnIndex: 1, turnLimit: 8,
        remainingTurns: 7, status: 'open', closedReason: null, lastMessageId: 'message-linked',
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/agents/presence?')) return jsonResponse({ agents: [agent] });
      if (url.startsWith('/api/agents/message?')) return jsonResponse({ messages: [linked, message] });
      if (url === '/api/agents/conversation' && init?.method === 'POST') {
        return jsonResponse({ conversation: { id: 'conversation-one', status: 'closed' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => root.render(createElement(O8HandoffsPane, {
      active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: false,
    })));
    await vi.waitFor(() => expect(host.textContent).toContain('A linked request.'));
    expect(host.querySelector('[data-agent-conversation-id="conversation-one"]')?.textContent).toContain('7 turns left');
    expect(host.querySelectorAll('nav[aria-label="Conversations"] button')).toHaveLength(2);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-conversation-id="conversation-one"]')?.click());
    expect(document.body.querySelector('[data-agent-conversation-detail="conversation-one"]')?.textContent).toContain('A linked request.');
    expect(host.textContent).toContain('@Keen · Codex · ONKEEN');
    expect(host.textContent).toContain('Unthreaded');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-agent-conversation-id="conversation-one"]')?.click();
      Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Stop')?.click();
    });
    const post = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/agents/conversation' && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ id: 'conversation-one', repo: repo.localPath, action: 'close' });
  });

  it('shows a conversation action error while the composer is collapsed', async () => {
    const linked: AgentMessage = {
      ...message,
      id: 'message-linked',
      conversation: {
        id: 'conversation-one', replyToId: null, turnIndex: 1, turnLimit: 8,
        remainingTurns: 7, status: 'open', closedReason: null, lastMessageId: 'message-linked',
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/agents/presence?')) return jsonResponse({ agents: [agent] });
      if (String(input).startsWith('/api/agents/message?')) return jsonResponse({ messages: [linked] });
      if (init?.method === 'POST') return jsonResponse({ error: { message: 'Conversation already closed.' } }, 409);
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    await act(async () => root.render(createElement(O8HandoffsPane, {
      active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: false,
    })));
    await vi.waitFor(() => expect(host.textContent).toContain('7 turns left'));
    expect(host.querySelector('#o8-handoff-message')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-conversation-id="conversation-one"]')?.click());
    await act(async () => Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Stop')?.click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe('Conversation already closed.'));
  });

  it('restores a selected exchange after remount and reopens an exact transcript link', async () => {
    const linked: AgentMessage = {
      ...message,
      conversation: {
        id: 'conversation-restore', replyToId: null, turnIndex: 1, turnLimit: 8,
        remainingTurns: 7, status: 'open', closedReason: null, lastMessageId: message.id,
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/agents/presence?')) return jsonResponse({ agents: [agent] });
      if (String(input).startsWith('/api/agents/message?')) return jsonResponse({ messages: [linked] });
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    const props = { active: true, repoPath: repo.localPath, registeredRepos: [repo], allRepos: false };
    await act(async () => root.render(createElement(O8HandoffsPane, props)));
    await vi.waitFor(() => expect(host.querySelector('[data-agent-conversation-id="conversation-restore"]')).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-conversation-id="conversation-restore"]')?.click());
    expect(document.body.querySelector('[data-agent-conversation-detail="conversation-restore"]')).not.toBeNull();

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(O8HandoffsPane, props)));
    await vi.waitFor(() => expect(document.body.querySelector('[data-agent-conversation-detail="conversation-restore"]')).not.toBeNull());
    await act(async () => Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Back to Handoffs')?.click());
    expect(document.body.querySelector('[data-agent-conversation-detail="conversation-restore"]')).toBeNull();
    await act(async () => root.render(createElement(O8HandoffsPane, {
      ...props, selection: { id: 'conversation-restore', request: 1, repoPath: repo.localPath },
    })));
    expect(document.body.querySelector('[data-agent-conversation-detail="conversation-restore"]')).not.toBeNull();
  });
});
