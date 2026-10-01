// @vitest-environment jsdom

vi.mock('@/components/desktop/onboarding/useRuntimeInventory', async () => {
  const { listDispatchableRuntimes } = await import('@/lib/orchestrator/runtime-capabilities');
  return { useRuntimeInventory: () => ({
    inventory: listDispatchableRuntimes().map((id) => ({ id, label: id, available: true, unavailableReason: null, detail: '', fix: '' })),
    loading: false, error: null, refresh: () => {},
  }) };
});

const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('./shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('./shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));
vi.mock('../chat-panel/ProfiledChatMessageList', async () => {
  const { createElement, forwardRef } = await import('react');
  return { ProfiledChatMessageList: forwardRef<HTMLDivElement, { displayMessages: Array<{ text?: string }> }>(
    function MessageList(props, ref) {
      return createElement('div', { ref, 'data-testid': 'messages' }, props.displayMessages.map((entry) => entry.text).join('|'));
    },
  ) };
});

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasQueuedOrchestratorSessionPrelude } from '@/lib/orchestrator/store';
import { ThoughtsChatPanel, type ThoughtsChatPanelHandle } from '../ThoughtsChatPanel';

const repoPath = '/repo/handoff-race';
let host: HTMLDivElement;
let root: Root;
let panelRef: ReturnType<typeof createRef<ThoughtsChatPanelHandle>>;
let releaseCompact: () => void;
let compactStarted: Promise<void>;
let markCompactStarted: () => void;
let compactStatus = 200;
let resetStatus = 200;
let resetGate: Promise<void> | null = null;
let releaseReset: () => void = () => {};
let resetStarted: Promise<void>;
let markResetStarted: () => void;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  compactStarted = new Promise<void>((resolve) => { markCompactStarted = resolve; });
  const compactGate = new Promise<void>((resolve) => { releaseCompact = resolve; });
  compactStatus = 200;
  resetStatus = 200;
  resetGate = null;
  resetStarted = new Promise<void>((resolve) => { markResetStarted = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/v2/chat-history?')) {
      const id = new URL(url, 'http://localhost').searchParams.get('tabId');
      return new Response(JSON.stringify({ messages: [
        { id: `${id}-user`, role: 'user', content: id === 'thoughts-a' ? 'A_SECRET' : 'B_CURRENT', timestamp: 1 },
      ] }), { status: 200 });
    }
    if (url === '/api/orchestrator/compact') {
      markCompactStarted();
      await compactGate;
      return new Response(JSON.stringify({
        ok: compactStatus === 200, applied: true, tokensAfter: 0, resumePrelude: 'A_PRELUDE',
        transcript: [{ id: 'a-compacted', role: 'assistant', text: 'A_COMPACTED' }],
      }), { status: compactStatus });
    }
    if (url === '/api/orchestrator/reset-session') {
      markResetStarted();
      if (resetGate) await resetGate;
      return new Response('{}', { status: resetStatus });
    }
    return new Response('{}', { status: 200 });
  }));
  transport.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  panelRef = createRef<ThoughtsChatPanelHandle>();
  await act(async () => root.render(createElement(ThoughtsChatPanel, {
    ref: panelRef,
    open: true,
    agents: [],
    missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() },
    preferredRuntime: 'codex',
    sessionTargets: [],
    workspaceTargets: [],
    repoPath,
    initialMode: 'fleet',
    onModePersist: () => {},
    suppressAutoRestore: true,
    suppressRuntimePrewarm: true,
    thoughtsBodyBackground: 'var(--t-bg)',
    thoughtsElevatedSurface: 'var(--t-panel)',
    thoughtsElevatedBorder: 'var(--t-border)',
    thoughtsElevatedShadow: 'var(--t-panel-shadow)',
    thoughtsMutedGlass: 'var(--t-muted)',
    onMissionStateChange: () => {},
    onChromeChange: () => {},
  })));
  await act(async () => {
    panelRef.current!.loadThread('thoughts-a');
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

afterEach(async () => {
  releaseCompact();
  releaseReset();
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  transport.socket = null;
  vi.unstubAllGlobals();
});

describe('slash command thread binding', () => {
  for (const [command, failed] of [['/handoff claude-sonnet-5', false], ['/handoff claude-sonnet-5', true], ['/compact', true]] as const) {
    it(`does not apply ${command} to B after A's ${failed ? 'failed' : 'completed'} compaction`, async () => {
      compactStatus = failed ? 500 : 200;
      act(() => { expect(panelRef.current!.sendNow(command)).toBe(true); });
      await compactStarted;
      await act(async () => {
        panelRef.current!.loadThread('thoughts-b');
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => {
        releaseCompact();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const resets = (fetch as ReturnType<typeof vi.fn>).mock.calls
        .filter(([url]) => String(url) === '/api/orchestrator/reset-session')
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { threadId?: string });
      expect(resets).toEqual([]);
      expect(hasQueuedOrchestratorSessionPrelude(repoPath, 'thoughts-b')).toBe(false);
      expect(host.querySelector('[data-testid="messages"]')?.textContent).toBe('B_CURRENT');
    });
  }

  it('keeps an in-flight handoff reset and its completion on A after switching to B', async () => {
    compactStatus = 500;
    resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
    act(() => { expect(panelRef.current!.sendNow('/handoff claude-sonnet-5')).toBe(true); });
    await compactStarted;
    releaseCompact();
    await resetStarted;
    await act(async () => {
      panelRef.current!.loadThread('thoughts-b');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      releaseReset();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const resets = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url) === '/api/orchestrator/reset-session')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { threadId?: string });
    expect(resets).toEqual([{ repoPath, threadId: 'thoughts-a' }]);
    expect(hasQueuedOrchestratorSessionPrelude(repoPath, 'thoughts-b')).toBe(false);
    expect(host.querySelector('[data-testid="messages"]')?.textContent).toBe('B_CURRENT');
  });

  it('reports a reset failure without queuing a handoff prelude', async () => {
    compactStatus = 500;
    resetStatus = 503;
    act(() => { expect(panelRef.current!.sendNow('/handoff claude-sonnet-5')).toBe(true); });
    await compactStarted;
    await act(async () => {
      releaseCompact();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hasQueuedOrchestratorSessionPrelude(repoPath, 'thoughts-a')).toBe(false);
    expect(host.querySelector('[data-testid="messages"]')?.textContent).toContain('Unable to reset the remote session for handoff.');
  });
});
