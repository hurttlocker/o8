// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentPresence } from '@/lib/agents/types';
import { selectPeerMessages, useAgentPeerMessages } from './useAgentPeerMessages';

const self: AgentPresence = {
  agentId: 'session:codex:one', name: 'Nova', repo: '/repo/one',
  worktreePath: null, runtime: 'codex', sessionKey: 'codex:one',
  laneId: null, packetId: null, lastSeen: new Date().toISOString(),
};

function message(id: string, from: string, to: string, repo = self.repo): AgentMessage {
  return {
    schema: 'o8/agents.message-event/v1', kind: 'message', sequence: 1,
    id, from, to, repo, text: id, refs: { laneId: null, packetId: null },
    delivery: 'poll', deliveryNote: null, timestamp: new Date().toISOString(),
  };
}

describe('agent peer message selection', () => {
  it('includes both directions for the exact repo and codename', () => {
    expect(selectPeerMessages([
      message('received', 'Sage', 'Nova'),
      message('sent', 'Nova', 'Sage'),
      message('other', 'Sage', 'Comet'),
      message('other-repo', 'Sage', 'Nova', '/repo/two'),
    ], self).map((entry) => entry.id)).toEqual(['received', 'sent']);
  });

  it('rejects recorded participant identities from another session or runtime', () => {
    const bound = (id: string, from: string, to: string, runtime: string, sessionKey: string) => ({
      ...message(id, from, to), refs: { laneId: null, packetId: null, identities: {
        from: from === 'Nova' ? { runtime, sessionKey } : null,
        to: to === 'Nova' ? { runtime, sessionKey } : null,
      } },
    });
    expect(selectPeerMessages([
      bound('right-in', 'Sage', 'Nova', self.runtime, self.sessionKey!),
      bound('right-out', 'Nova', 'Sage', self.runtime, self.sessionKey!),
      bound('old-in', 'Sage', 'Nova', self.runtime, 'codex:old'),
      bound('old-out', 'Nova', 'Sage', self.runtime, 'codex:old'),
      bound('wrong-runtime', 'Sage', 'Nova', 'claude-code', self.sessionKey!),
    ], self).map(entry => entry.id)).toEqual(['right-in', 'right-out']);
  });

  it('distinguishes absent legacy identity records from explicit unknown identities', () => {
    const unknown = { ...message('unknown', 'Sage', 'Nova'), refs: { laneId: null, packetId: null, identities: { from: null, to: null } } };
    expect(selectPeerMessages([message('legacy', 'Sage', 'Nova'), unknown], self).map(entry => entry.id)).toEqual(['legacy']);
  });

  it('uses a session-derived agent id only when presence has no session key', () => {
    const entry = { ...message('bound', 'Sage', 'Nova'), refs: { laneId: null, packetId: null, identities: {
      from: null, to: { runtime: self.runtime, sessionKey: self.sessionKey },
    } } };
    expect(selectPeerMessages([entry], { ...self, sessionKey: null })).toEqual([entry]);
    expect(selectPeerMessages([entry], { ...self, sessionKey: 'codex:replacement' })).toEqual([]);
  });

  it('keeps hidden split panes idle and loads stored identities when visible', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/agents/presence?scope=stored') {
        return new Response(JSON.stringify({ agents: [self] }), { status: 200 });
      }
      if (url.startsWith('/api/agents/message?repo=')) {
        return new Response(JSON.stringify({ messages: [message('received', 'Sage', 'Nova')] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    function Probe() {
      const { messages } = useAgentPeerMessages('codex:one');
      return createElement('div', null, String(messages.length));
    }

    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(fetchMock).not.toHaveBeenCalled();

      visibility.mockReturnValue('visible');
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        '/api/agents/presence?scope=stored',
        `/api/agents/message?repo=${encodeURIComponent(self.repo)}&limit=50`,
      ]);
      expect(host.textContent).toBe('1');
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
