// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/lib/agents/types';
import { AgentPeerMessageCard } from './AgentPeerMessageCard';

describe('AgentPeerMessageCard', () => {
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
  });

  it('opens the exact exchange in Handoffs and keeps inbox receipt distinct from an answer', async () => {
    const message: AgentMessage = {
      schema: 'o8/agents.message-event/v1', kind: 'message', sequence: 1,
      id: 'message-1', from: 'Nova', to: 'Sage', repo: '/repo', text: 'Please inspect this.',
      refs: { laneId: null, packetId: null }, delivery: 'poll', deliveryNote: 'Waiting for the session inbox.',
      timestamp: new Date().toISOString(), conversation: {
        id: 'conversation-1', replyToId: null, turnIndex: 1, turnLimit: 8,
        remainingTurns: 7, status: 'open', closedReason: null, lastMessageId: 'message-1',
      },
    };
    const listener = vi.fn();
    window.addEventListener('o8:open-handoffs', listener);
    await act(async () => root.render(createElement(AgentPeerMessageCard, { message, selfName: 'Nova' })));
    expect(host.textContent).toContain('Waiting in inbox');
    expect(host.textContent).not.toContain('Answered');
    await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ conversationId: 'conversation-1', repoPath: '/repo' });
    window.removeEventListener('o8:open-handoffs', listener);
  });
});
