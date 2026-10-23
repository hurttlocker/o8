// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OrchestratorDataValue } from '../orchestrator-data-context';
import { ThreadWorkerCard, useThreadWorkers } from '../thoughts/chat-panel/ThreadWorkerCard';
import { projectThreadWorkerGroups } from '../thoughts/chat-panel/thread-worker-groups';
import { TranscriptTurns } from '../transcript/TranscriptTurns';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { SwarmStatusCard, packetsForOrchestratorThread } from '../thoughts/chat-panel/SwarmStatusCard';
import { SessionTileSurface } from './SessionTileSurface';
import { useSessionTiles } from './use-session-tiles';
import { useWorkerCardFocus } from './use-worker-card-focus';

const realtime = vi.hoisted(() => ({ onEvent: undefined as undefined | ((event: unknown) => void) }));
vi.mock('../hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: (_key: unknown, callbacks: { onRealtimeEvent?: (event: unknown) => void }) => { realtime.onEvent = callbacks.onRealtimeEvent; } }));
const context = vi.hoisted(() => ({ value: null as OrchestratorDataValue | null }));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => context.value }));
vi.mock('@/lib/transcripts/useTranscript', () => ({ useTranscript: () => ({ messages: [], status: 'fresh', error: null }) }));
vi.mock('./use-packet-transcript-poll', () => ({ usePacketTranscriptPoll: () => ({ entries: [], activity: null }) }));
vi.mock('./SessionTransformMenu', () => ({ SessionTransformMenu: () => null }));

function packet(id: string, runtime: 'codex' | 'claude-code', threadId = 'parent'): OrchestratorPacket {
  return {
    id, title: id, referenceLabel: id, summary: id, runtime, orchestratorThreadId: threadId,
    workspaceTargetPath: '/repo', branchTarget: 'worker', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'running',
    lane: { tileId: id, tabId: id, repoPath: '/repo', runtime, laneId: id, sessionKey: `${runtime}-owned:${id}` },
  };
}

const packets = [packet('Code worker', 'codex'), packet('Review worker', 'claude-code'), packet('Unrelated worker', 'codex', 'other-parent')];
const sessionKeys = packets.map(entry => entry.lane!.sessionKey!);

function Workspace({ current = packets }: { current?: OrchestratorPacket[] }) {
  const [draft, setDraft] = useState('Keep my orchestrator draft');
  const tiles = useSessionTiles({ tabId: 'worker-card-proof', repoPath: '/repo', threadId: 'parent', liveSessionKeys: sessionKeys, active: true });
  const focus = useWorkerCardFocus({ packets: current, threadId: 'parent', openSession: tiles.splitSessionFromMenu });
  return createElement(SessionTileSurface, {
    layout: tiles.layout, focusedSessionKey: tiles.focusedSessionKey,
    onResizeSplit: tiles.resizeSplit, onCloseLeaf: tiles.closeSessionLeafById, onFocusSession: tiles.setFocusedSessionKey,
    chatSlot: createElement('section', null,
      createElement(SwarmStatusCard, { packets: packetsForOrchestratorThread(current, 'parent'), onFocusPacket: focus, defaultExpanded: true }),
      // The parent sender is outside this integration boundary. Its state must
      // survive opening real SessionTranscriptPane / AgentTilePane children.
      createElement('textarea', { 'aria-label': 'Orchestrator draft', value: draft, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value) }),
    ),
  });
}

function workerControls(host: HTMLElement, title: string) {
  const close = host.querySelectorAll<HTMLButtonElement>(`button[aria-label="Hide ${title} pane"]`);
  expect(close).toHaveLength(1);
  const pane = close[0].closest<HTMLElement>('[data-worker-pane]');
  expect(pane).not.toBeNull();
  const inputs = pane!.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message this worker"]');
  expect(inputs).toHaveLength(1);
  return { close: close[0], input: inputs[0] };
}

it('opens existing mixed-runtime worker chats beside the parent and steers only the selected worker', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let identity = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `mutation-worker-card-${++identity}` });
  const fetcher = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => Response.json(options?.method === 'POST' ? { ok: true } : { agents: [], messages: [] }));
  vi.stubGlobal('fetch', fetcher);
  context.value = { agents: packets.map(entry => ({ name: entry.title, status: 'running', runtime: entry.runtime, sessionKey: entry.lane!.sessionKey })),
    missionState: { packets }, workspaceTargets: [], onMissionStateChange: vi.fn() } as unknown as OrchestratorDataValue;
  localStorage.clear();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Workspace)));
    expect(host.textContent).not.toContain('Unrelated worker');
    const open = (title: string) => host.querySelector<HTMLButtonElement>(`[title="Open ${title}"]`)!.click();
    await act(async () => open('Code worker'));
    await act(async () => open('Code worker'));
    const codeInput = workerControls(host, 'Code worker').input;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(codeInput, 'Keep my first worker draft');
      codeInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => open('Review worker'));
    expect(host.querySelectorAll('textarea[aria-label="Message this worker"]')).toHaveLength(2);
    expect(workerControls(host, 'Code worker').input).toBe(codeInput);
    expect(host.querySelectorAll('[data-o8-composer-root]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-testid="composer-send-control"]')).toHaveLength(2);
    expect(host.textContent).not.toContain(' · Steer');
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    const input = workerControls(host, 'Review worker').input;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Review the current patch');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.closest('[data-o8-composer-root]')!.querySelector<HTMLButtonElement>('[data-testid="composer-send-control"]')!.click());
    const sends = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(sends).toHaveLength(1);
    expect(sends[0][0]).toBe('/api/runtime/action');
    expect(JSON.parse(sends[0][1]!.body as string)).toEqual({ action: 'steer', surfaceId: 'claude-code-owned:Review worker', clientMutationId: expect.stringMatching(/^mutation-worker-card-\d+$/), message: 'Review the current patch' });
    expect(host.querySelector('[data-worker-steer-receipt]')).toBeNull();
    expect(input.value).toBe('');
    expect(codeInput.value).toBe('Keep my first worker draft');
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Orchestrator draft"]')!.value).toBe('Keep my orchestrator draft');
  } finally {
    await act(async () => root.unmount()); host.remove(); localStorage.clear(); context.value = null; vi.unstubAllGlobals();
  }
});

it('resolves the current parent binding and never launches a stale or unrelated packet', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const openSession = vi.fn(); const navigation = vi.fn();
  window.addEventListener('o8:focus-spawned-agent-lane', navigation);
  function Harness({ current }: { current: OrchestratorPacket[] }) {
    const focus = useWorkerCardFocus({ packets: current, threadId: 'parent', openSession });
    return createElement('section', null, packets.map(entry => createElement('button', { key: entry.id, onClick: () => focus(entry) }, entry.id)));
  }
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    const rebound = { ...packets[0], lane: { ...packets[0].lane!, sessionKey: 'codex-owned:rebound' } };
    await act(async () => root.render(createElement(Harness, { current: [rebound, packets[2]] })));
    act(() => host.querySelectorAll('button').forEach(button => button.click()));
    expect(openSession.mock.calls).toEqual([['codex-owned:rebound', 'vertical']]);
    const awaitingSession = { ...rebound, lane: { ...rebound.lane!, sessionKey: undefined } };
    await act(async () => root.render(createElement(Harness, { current: [awaitingSession] })));
    act(() => host.querySelector('button')!.click());
    expect(navigation).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); window.removeEventListener('o8:focus-spawned-agent-lane', navigation); vi.unstubAllGlobals();
  }
});

it('reopens a completed Shared worker from saved membership and retains independent parent and worker inputs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('crypto', { randomUUID: () => 'shared-followup' });
  const worker = { sessionKey: 'codex-owned:shared-real', name: 'Shared worker', runtime: 'codex', status: 'completed', parentTurnId: 'assistant-shared' };
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => Response.json(
    String(input).includes('/shared-team/active?') ? { threadId: 'thoughts-parent', workers: [worker, worker] }
      : options?.method === 'POST' ? { ok: true } : { agents: [], messages: [] }));
  vi.stubGlobal('fetch', fetcher);
  context.value = { agents: [worker], missionState: { packets: [] }, workspaceTargets: [], onMissionStateChange: vi.fn() } as unknown as OrchestratorDataValue;
  const entries: MobileTranscriptEntry[] = [
    { id: 'user-shared', role: 'user', text: 'Delegate this inspection' },
    { id: 'assistant-shared', role: 'assistant', text: 'The worker inspected the code.' },
  ];
  function SharedWorkspace() {
    const sessions = useThreadWorkers({ threadId: 'thoughts-parent', repoPath: '/repo', busy: false, agents: [worker] });
    const { groups } = projectThreadWorkerGroups({ entries, sessions, packets: [], busy: false });
    const tiles = useSessionTiles({ tabId: 'shared-card-proof', repoPath: '/repo', threadId: 'thoughts-parent', liveSessionKeys: [worker.sessionKey], active: true });
    return createElement(SessionTileSurface, { layout: tiles.layout, focusedSessionKey: tiles.focusedSessionKey,
      onResizeSplit: tiles.resizeSplit, onCloseLeaf: tiles.closeSessionLeafById, onFocusSession: tiles.setFocusedSessionKey,
      chatSlot: createElement('section', null,
        createElement(TranscriptTurns, { entries, busy: false,
          nodes: entries.map(entry => createElement('div', { key: entry.id, 'data-o8-message-id': entry.id }, entry.text)),
          turnContent: new Map([...groups].map(([id, group]) => [id,
            createElement(ThreadWorkerCard, { key: id, group, onFocusSession: key => tiles.splitSessionFromMenu(key, 'vertical') }),
          ])),
        }),
        createElement('textarea', { 'aria-label': 'Parent input', defaultValue: 'Parent draft' })),
    });
  }
  localStorage.clear();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SharedWorkspace)));
    expect(host.querySelectorAll('[role="group"][aria-label="Subagents: 1"]')).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="group"][aria-label="Subagents: 1"] button')!.click());
    expect(host.querySelectorAll('[title="Open Shared worker"]')).toHaveLength(1);
    const before = fetcher.mock.calls.length;
    await act(async () => realtime.onEvent?.({ channel: 'mutation', data: { mutation: { surfaceId: 'codex-owned:unrelated' } } }));
    expect(fetcher.mock.calls.length).toBe(before);
    await act(async () => realtime.onEvent?.({ channel: 'mutation', data: { mutation: { surfaceId: worker.sessionKey } } }));
    expect(fetcher.mock.calls.length).toBe(before + 1);
    const open = () => host.querySelector<HTMLButtonElement>('[title="Open Shared worker"]')!.click();
    await act(async () => { open(); open(); });
    const { close } = workerControls(host, 'Shared worker');
    await act(async () => close.click());
    expect(host.querySelector('button[aria-label="Hide Shared worker pane"]')).toBeNull();
    expect(host.querySelector('textarea[aria-label="Message this worker"]')).toBeNull();
    await act(async () => open());
    const input = workerControls(host, 'Shared worker').input;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Follow up in the same worker');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    const sends = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0][1]!.body as string)).toMatchObject({ surfaceId: worker.sessionKey, message: 'Follow up in the same worker' });
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Parent input"]')!.value).toBe('Parent draft');
  } finally {
    await act(async () => root.unmount()); host.remove(); localStorage.clear(); context.value = null; vi.unstubAllGlobals();
  }
});
