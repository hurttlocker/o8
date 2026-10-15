// @vitest-environment jsdom

import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSessionTiles } from './use-session-tiles';
import { SessionTileSurface } from './SessionTileSurface';
import { AgentTilePane } from './AgentTilePane';
import { AgentPanelExtraAgents, type LaneSummary } from '../AgentPanelExtraAgents';

vi.mock('@/lib/transcripts/useTranscript', () => ({ useTranscript: () => ({ messages: [{ id: 'worker-reply', role: 'assistant', text: 'Worker progress stays here.' }], status: 'fresh', error: null }) }));
vi.mock('./SessionTransformMenu', () => ({ SessionTransformMenu: () => null }));
vi.mock('./use-packet-transcript-poll', () => ({ usePacketTranscriptPoll: () => ({ entries: [], activity: null }) }));
vi.mock('./WorkspaceTranscript', () => ({ WorkspaceTranscript: () => createElement('p', null, 'Worker progress stays here.') }));

const sessionKey = 'codex-owned:visibility-fixture';
const lane: LaneSummary = { id: 'visibility-fixture', label: 'Fixture worker', repoPath: '/workspace/fixture', branch: 'worker',
  runtime: 'codex', sessionKey, packetId: 'packet-fixture', status: 'running', ownership: 'managed', lastEventAt: new Date().toISOString(), lastEventLabel: null };
const liveSessions = [sessionKey];

function Workspace() {
  const tiles = useSessionTiles({ tabId: 'visibility-fixture-tab', repoPath: '/workspace/fixture', liveSessionKeys: liveSessions, active: true });
  // The outer dashboard receives this lane-navigation event. Keep that router
  // boundary local to the fixture while exercising the real row and pane hooks.
  useEffect(() => {
    const select = (event: Event) => {
      if ((event as CustomEvent<{ laneId?: string }>).detail?.laneId === lane.id) tiles.toggleTileSession(sessionKey);
    };
    window.addEventListener('o8:focus-spawned-agent-lane', select);
    return () => window.removeEventListener('o8:focus-spawned-agent-lane', select);
  }, [tiles.toggleTileSession]);
  return createElement(Fragment, null,
    createElement(AgentPanelExtraAgents, { onSelectSession: tiles.toggleTileSession }),
    createElement(SessionTileSurface, { layout: tiles.layout, chatSlot: createElement('p', null, 'Orchestrator'), focusedSessionKey: tiles.focusedSessionKey,
      onResizeSplit: tiles.resizeSplit, onCloseLeaf: tiles.closeSessionLeafById, onFocusSession: tiles.setFocusedSessionKey,
      renderSessionPane: leaf => createElement(AgentTilePane, { sessionKey, agent: { name: 'Fixture worker', status: 'running', runtime: 'codex' },
        focused: false, onFocus: tiles.setFocusedSessionKey, onClose: () => tiles.closeSessionLeafById(leaf.id) }),
    }),
  );
}

it('hides and reopens the same running worker from Agents without a lifecycle request', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const fetcher = vi.fn(async (input: RequestInfo | URL, _options?: RequestInit) => Response.json(String(input).includes('/api/lanes') ? { lanes: [lane] } : {}));
  vi.stubGlobal('fetch', fetcher);
  localStorage.clear();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Workspace)));
    const workerRow = () => host.querySelector<HTMLButtonElement>('[role="list"][aria-label="Agents"] button[title*="Fixture worker"]')
      ?? [...host.querySelectorAll<HTMLButtonElement>('[role="list"][aria-label="Agents"] button')].find(button => button.textContent?.includes('Fixture worker'))!;
    expect(workerRow()).toBeDefined();
    for (let repeat = 0; repeat < 2; repeat++) {
      await act(async () => workerRow().click());
      expect(host.textContent).toContain('Worker progress stays here.');
      const hide = host.querySelector<HTMLButtonElement>('[aria-label="Hide Fixture worker pane"]')!;
      expect(hide.title).toContain('available in Agents');
      await act(async () => hide.click());
      expect(host.textContent).not.toContain('Worker progress stays here.');
      expect(workerRow()).toBeDefined();
      expect(host.querySelector('[aria-label="1 agent working"]')).not.toBeNull();
      expect(localStorage.getItem('o8:orchestrator:session-tiles:tab:visibility-fixture-tab')).toBeNull();
    }
    expect(fetcher.mock.calls.every(([, options]) => !(options as RequestInit | undefined)?.method || (options as RequestInit).method === 'GET')).toBe(true);
    expect(lane.status).toBe('running');
  } finally {
    await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals();
  }
});
