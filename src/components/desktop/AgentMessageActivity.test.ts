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
          { agentId: 'nova', name: 'Nova' },
          { agentId: 'keen', name: 'Keen' },
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
});
