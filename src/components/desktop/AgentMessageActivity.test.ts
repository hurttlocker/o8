// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/lib/agents/types';
import { AgentMessageActivity } from './AgentMessageActivity';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function messageFor(id: string, sequence: number, repo = '/workspace/o8'): AgentMessage {
  return {
    schema: 'o8/agents.message-event/v1', kind: 'message', sequence, id,
    from: 'sender', to: 'receiver', repo, text: id,
    refs: { laneId: null, packetId: null }, delivery: 'native',
    deliveryNote: null, timestamp: new Date().toISOString(),
  };
}

describe('AgentMessageActivity', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('starts collapsed and keeps successful delivery quiet in the message metadata', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents/message?')) {
        return jsonResponse({
          schema: 'o8/agents.exchanges/v1',
          repo: '/workspace/o8',
          messages: [{
            schema: 'o8/agents.message-event/v1',
            kind: 'message',
            sequence: 7,
            id: 'message-seven',
            from: 'Nova',
            to: 'Keen',
            repo: '/workspace/o8',
            text: 'Ping through the live-session bus.',
            refs: { laneId: null, packetId: null },
            delivery: 'native',
            deliveryNote: 'Accepted through the live session.',
            timestamp: new Date().toISOString(),
          }],
        });
      }
      return jsonResponse({
        schema: 'o8/agents.presence/v1',
        agents: [
          { agentId: 'nova', name: 'Nova', repo: '/workspace/o8' },
          { agentId: 'keen', name: 'Keen', repo: '/workspace/o8' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(AgentMessageActivity, {
        repos: [{ name: 'o8', localPath: '/workspace/o8' }],
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.querySelector<HTMLButtonElement>('button[title="Show agent messages"]')).not.toBeNull();
    });
    expect(host.textContent).not.toContain('2 agents live');
    expect(host.querySelector('[aria-label="1 agent messages"]')).toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[title="Show agent messages"]')?.click();
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain('2 agents live');
      expect(host.textContent).toContain('Nova, Keen');
      expect(host.textContent).toContain('Nova → Keen');
      expect(host.textContent).toContain('Ping through the live-session bus.');
      expect(host.textContent).toContain('Delivered');
    });
    const delivered = Array.from(host.querySelectorAll('span')).find((node) => node.textContent === 'Delivered');
    expect(delivered?.style.color).toBe('var(--t-text-faint)');
    expect(delivered?.parentElement?.textContent).toContain('o8 · now · Delivered');
    expect(host.textContent).not.toContain('Accepted through the live session.');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-agent-message-id="message-seven"]')?.click();
    });
    expect(host.querySelector('[data-agent-delivery-note="true"]')?.textContent)
      .toBe('Accepted through the live session.');
  });

  it('shows only newly arrived messages as unread and clears the count when opened', async () => {
    const messageSeven: AgentMessage = {
      schema: 'o8/agents.message-event/v1',
      kind: 'message',
      sequence: 7,
      id: 'message-seven',
      from: 'Nova',
      to: 'Keen',
      repo: '/workspace/o8',
      text: 'Initial message.',
      refs: { laneId: null, packetId: null },
      delivery: 'native',
      deliveryNote: 'Accepted through the live session.',
      timestamp: new Date().toISOString(),
    };
    const messageEight: AgentMessage = {
      ...messageSeven,
      sequence: 8,
      id: 'message-eight',
      text: 'New queued message.',
      delivery: 'poll',
      deliveryNote: 'Waiting for the session inbox.',
    };
    let messages: AgentMessage[] = [messageSeven];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/agents/message?')) {
        return jsonResponse({ schema: 'o8/agents.exchanges/v1', repo: '/workspace/o8', messages });
      }
      return jsonResponse({ schema: 'o8/agents.presence/v1', agents: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(AgentMessageActivity, {
        repos: [{ name: 'o8', localPath: '/workspace/o8' }],
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(window.localStorage.getItem('o8:agent-panel:agent-messages-seen')).toContain('7');
    });
    expect(host.querySelector('[aria-label="1 agent messages"]')).toBeNull();

    messages = [messageEight, messageSeven];
    await act(async () => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[aria-label="1 agent messages"]')?.textContent).toBe('1');
    });
    expect(host.querySelector<HTMLElement>('[aria-label="1 agent messages"]')?.style.color).toBe('var(--t-accent)');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[title="Show agent messages"]')?.click();
    });
    expect(host.querySelector('[aria-label="1 agent messages"]')).toBeNull();
    const queued = Array.from(host.querySelectorAll('span')).find((node) => node.textContent === 'Queued');
    expect(queued?.style.color).toBe('var(--t-warning)');
  });

  it('uses two fleet reads instead of polling every repository', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents/message?')) {
        return jsonResponse({ schema: 'o8/agents.exchanges/v1', messages: [] });
      }
      return jsonResponse({ schema: 'o8/agents.presence/v1', agents: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(AgentMessageActivity, {
        repos: Array.from({ length: 250 }, (_, index) => ({
          name: `repo-${index}`,
          localPath: `/workspace/repo-${index}`,
        })),
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/agents/message?scope=all&limit=8',
      '/api/agents/presence?scope=all',
    ]);
  });

  it('does not overlap a lifecycle refresh with an active fleet read', async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      releases.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(AgentMessageActivity, {
        repos: [{ name: 'o8', localPath: '/workspace/o8' }],
      }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      releases[0]?.(jsonResponse({ schema: 'o8/agents.exchanges/v1', messages: [] }));
      releases[1]?.(jsonResponse({ schema: 'o8/agents.presence/v1', agents: [] }));
      await Promise.resolve();
    });
  });

  describe('response-body failures', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      window.localStorage.setItem('o8:agent-panel:agent-messages-collapsed', '0');
    });

    async function mount() {
      await act(async () => {
        root.render(createElement(AgentMessageActivity, {
          repos: [{ name: 'o8', localPath: '/workspace/o8' }],
        }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    }

    it.each(['messages', 'agents'])('retains %s after a bad body while updating the healthy endpoint', async (failed) => {
      let phase: 'initial' | 'invalid' | 'empty' = 'initial';
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const field = String(input).startsWith('/api/agents/message?') ? 'messages' : 'agents';
        if (phase === 'invalid' && field === failed) return new Response('{');
        if (phase === 'empty') return jsonResponse({ [field]: [] });
        return jsonResponse({ [field]: field === 'messages'
          ? [messageFor(`${phase}-message`, phase === 'initial' ? 1 : 2)]
          : [{ agentId: phase, name: `${phase}-agent`, repo: '/workspace/o8' }] });
      }));
      await mount();
      expect(host.textContent).toContain('initial-message');
      expect(host.textContent).toContain('initial-agent');

      phase = 'invalid';
      await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
      expect(host.textContent).toContain(failed === 'messages' ? 'initial-message' : 'invalid-message');
      expect(host.textContent).toContain(failed === 'agents' ? 'initial-agent' : 'invalid-agent');

      phase = 'empty';
      await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
      expect(host.textContent).toBe('');
    });

    it.each(['collection', 'entry'])('retains good data when both payloads have an invalid %s shape and recovers', async (shape) => {
      let valid = true;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('/api/agents/message?')) {
          return jsonResponse(valid ? { messages: [messageFor('saved-message', 1)] } : { messages: shape === 'collection' ? {} : [null] });
        }
        return jsonResponse(valid ? { agents: [] } : shape === 'collection' ? null : { agents: [{ repo: {} }] });
      }));
      await mount();
      valid = false;
      await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
      expect(host.textContent).toContain('saved-message');
      valid = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(host.textContent).toContain('saved-message');
    });

    it.each(['network', 'unavailable', 'unauthorized', 'forbidden'])('handles %s responses without treating failure as a successful empty snapshot', async (failure) => {
      let failed = false;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        if (failed) {
          if (failure === 'network') throw new TypeError('Network unavailable');
          return new Response('', { status: failure === 'unavailable' ? 503 : failure === 'unauthorized' ? 401 : 403 });
        }
        return jsonResponse(String(input).startsWith('/api/agents/message?')
          ? { messages: [messageFor('saved-message', 1)] }
          : { agents: [{ agentId: 'saved', name: 'saved-agent', repo: '/workspace/o8' }] });
      }));
      await mount();
      failed = true;
      await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
      if (failure === 'unauthorized' || failure === 'forbidden') expect(host.textContent).toBe('');
      else {
        expect(host.textContent).toContain('saved-message');
        expect(host.textContent).toContain('saved-agent');
      }
      failed = false;
      await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
      expect(host.textContent).toContain('saved-message');
    });

    it('settles an aborted body read at the deadline and permits the next poll', async () => {
      let stall = false;
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (stall) {
          const signal = init?.signal as AbortSignal;
          signals.push(signal);
          return new Response(new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => {
                controller.error(new DOMException('The body read was aborted', 'AbortError'));
              }, { once: true });
            },
          }));
        }
        return jsonResponse(String(input).startsWith('/api/agents/message?')
          ? { messages: [messageFor('saved-message', 1)] } : { agents: [] });
      });
      vi.stubGlobal('fetch', fetchMock);
      await mount();
      stall = true;
      await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(host.textContent).toContain('saved-message');
      stall = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(host.textContent).toContain('saved-message');
    });

    it('discards a late body from a disposed request without releasing the new request lock', async () => {
      const pending: Array<(body: string) => void> = [];
      const fetchMock = vi.fn(async () => new Response(new ReadableStream({
        start(controller) {
          pending.push((body) => {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          });
        },
      })));
      vi.stubGlobal('fetch', fetchMock);
      await mount();
      await act(async () => {
        root.render(createElement(AgentMessageActivity, {
          repos: [{ name: 'next', localPath: '/workspace/next' }],
        }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await act(async () => {
        pending[0](JSON.stringify({ messages: [messageFor('late-message', 1)] }));
        pending[1](JSON.stringify({ agents: [] }));
      });
      expect(host.textContent).not.toContain('late-message');
      await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await act(async () => {
        pending[2](JSON.stringify({ messages: [messageFor('current-message', 2, '/workspace/next')] }));
        pending[3](JSON.stringify({ agents: [] }));
      });
      expect(host.textContent).toContain('current-message');
    });
  });
});
