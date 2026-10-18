// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ExtraAgentRowView, type ExtraAgentRow } from './AgentPanelExtraAgentRow';
import { AgentPanelExtraAgents, type LaneSummary } from './AgentPanelExtraAgents';
const review = vi.fn();
it('opens the exact sidebar chat review without selecting another chat or issuing a merge', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('fetch', vi.fn());
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const select = vi.fn();
  const row = { key: 'lane:review-target', name: 'Review target', status: 'waiting', runtime: 'Codex', origin: 'CLI', model: null, subtitle: '', lastActivityAt: Date.now(), sessionKey: 'session-target', repoPath: '/preview/target', packetId: 'packet-target', laneId: 'lane-target', laneStatus: 'reviewing', outcome: null, outcomeNote: null, lastEventLabel: null } satisfies ExtraAgentRow;
  try {
    await act(async () => root.render(createElement(ExtraAgentRowView, { row, active: false, busy: false, band: 'review', onSelectSession: select, onOpenReview: review })));
    const action = host.querySelector<HTMLButtonElement>('[data-worker-open-review]'); expect(action).not.toBeNull();
    expect(action!.closest('button')!.querySelector('button')).toBeNull();
    await act(async () => action!.click());
    expect(review).toHaveBeenCalledExactlyOnceWith('lane-target', '/preview/target');
    expect(select).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await act(async () => host.querySelector('[data-o8-agent-row]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(select).toHaveBeenCalledExactlyOnceWith('session-target');
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it('carries the sidebar host callback through the actual lane inventory to the matching row', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const open = vi.fn();
  const lanes: LaneSummary[] = ['alpha', 'beta'].map(id => ({ id: `lane-${id}`, label: `Work ${id}`, repoPath: `/preview/${id}`, branch: `work/${id}`, runtime: 'codex', sessionKey: `codex-owned:${id}`, packetId: `packet-${id}`, status: id === 'alpha' ? 'running' : 'reviewing', ownership: 'managed', lastEventAt: new Date().toISOString(), lastEventLabel: 'awaiting_review' }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/api/lanes') ? { lanes } : {})));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AgentPanelExtraAgents, { onOpenChatReview: open })));
    expect(host.querySelector('[data-o8-agent-row="lane:lane-alpha"] [data-worker-open-review]')).toBeNull();
    const button = host.querySelector<HTMLButtonElement>('[data-o8-agent-row="lane:lane-beta"] [data-worker-open-review]');
    expect(button).not.toBeNull(); await act(async () => button!.click());
    expect(open).toHaveBeenCalledExactlyOnceWith('lane-beta', '/preview/beta');
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/merge'))).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
