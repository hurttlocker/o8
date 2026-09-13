// @vitest-environment jsdom

import { act, createElement, createRef, useEffect, useRef, useState, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/panel/operator-defaults/route';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import { writeStoredOrchestratorModel } from '@/lib/orchestrator/store';
import { ThoughtsChatPanel, type ThoughtsChatPanelHandle } from '../ThoughtsChatPanel';
import { composerModeStorageKey, legacySwarmStorageKey } from '../composer-mode-storage';
import { THOUGHTS_OPERATOR_DEFAULTS_FALLBACK, type OrchestratorBackendSetting } from '../operator-defaults';
import { resolveFreshComposerTurnOptions } from '../useBackendSwitchChoice';
import { useOrchestratorStream } from '../useOrchestratorStream';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';

const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('./shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('./shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));
vi.mock('../chat-panel/ProfiledChatMessageList', async () => {
  const { createElement: element, forwardRef: withRef } = await import('react');
  return { ProfiledChatMessageList: withRef<HTMLDivElement>(() => element('div')) };
});

const repoPath = '/repo/live-defaults';
let root: Root;
let host: HTMLDivElement;
let freshFetchFails = false;
let freshFetchGate: Promise<void> | null = null;
let releaseFreshFetch: (() => void) | null = null;
let historyResponse: Record<string, unknown> | null = null;

interface ComposerTestWindow extends Window {
  interruptComposerTurn?: () => void;
  setComposerBackendOwnership?: (source: 'thread' | 'user') => void;
  submitComposerTurn?: () => void;
  switchComposerRepo?: () => void;
}

function composerWindow(): ComposerTestWindow {
  return window as unknown as ComposerTestWindow;
}

function invokeComposerAction(action: keyof ComposerTestWindow, ...args: unknown[]) {
  const callback = composerWindow()[action];
  if (typeof callback !== 'function') throw new Error(`Missing composer test action: ${action}`);
  Reflect.apply(callback, composerWindow(), args);
}

function blockFreshFetch() {
  freshFetchGate = new Promise<void>((resolve) => { releaseFreshFetch = resolve; });
}

async function persistDefaults(orchestratorModel: string, orchestratorBackend: 'claude' | 'codex') {
  const response = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orchestratorModel, orchestratorBackend }),
  }));
  expect(response.ok).toBe(true);
}

function ComposerSubmissionHarness() {
  const [activeRepoPath, setActiveRepoPath] = useState(repoPath);
  const [displayedModel, setDisplayedModel] = useState('gpt-5.6-sol');
  const [displayedBackend, setDisplayedBackend] = useState<OrchestratorBackendSetting>('codex');
  const backendSourceRef = useRef<'default' | 'thread' | 'user'>('default');
  const [, setOperatorDefaults] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK);
  const result = useOrchestratorStream(activeRepoPath, { threadId: 'fresh-turn-options' });

  useEffect(() => {
    composerWindow().submitComposerTurn = () => {
      result.send('operator message', {
        model: displayedModel,
        backend: displayedBackend === 'auto' ? undefined : displayedBackend,
        resolveTurnOptions: (signal) => resolveFreshComposerTurnOptions({
          repoPath: activeRepoPath,
          backend: displayedBackend,
          backendSourceRef,
          setBackend: setDisplayedBackend,
          setModel: setDisplayedModel,
          setOperatorDefaults,
        }, signal),
      });
    };
    composerWindow().interruptComposerTurn = result.interrupt;
    composerWindow().switchComposerRepo = () => setActiveRepoPath('/repo/switched');
    composerWindow().setComposerBackendOwnership = (source) => {
      backendSourceRef.current = source;
      setDisplayedBackend('codex');
    };
  }, [activeRepoPath, displayedBackend, displayedModel, result]);

  return createElement('output', { 'data-testid': 'displayed-model' }, displayedModel);
}

function RoutingThoughtsHarness({ panelRef }: { panelRef: RefObject<ThoughtsChatPanelHandle | null> }) {
  const [collideEnabled, setCollideEnabled] = useState(false);
  const missionState: OrchestratorMissionState = {
    version: 2,
    prompt: '',
    summary: '',
    packets: [],
    updatedAt: new Date(0).toISOString(),
  };
  return createElement(ThoughtsChatPanel, {
    ref: panelRef,
    open: false,
    agents: [],
    missionState,
    preferredRuntime: 'codex',
    sessionTargets: [],
    workspaceTargets: [],
    repoPath,
    initialMode: 'fleet',
    onModePersist: () => {},
    collideEnabled,
    onSetCollide: setCollideEnabled,
    suppressAutoRestore: true,
    suppressRuntimePrewarm: true,
    thoughtsBodyBackground: 'var(--t-bg)',
    thoughtsElevatedSurface: 'var(--t-panel)',
    thoughtsElevatedBorder: 'var(--t-border)',
    thoughtsElevatedShadow: 'var(--t-panel-shadow)',
    thoughtsMutedGlass: 'var(--t-muted)',
    onMissionStateChange: () => {},
    onChromeChange: () => {},
  });
}

async function waitForPayload(count: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const payloads = sentTurnPayloads();
    if (payloads.length >= count) return payloads[count - 1]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for outbound payload ${count}`);
}

function sentTurnPayloads() {
  const sent = transport.socket!.send as ReturnType<typeof vi.fn>;
  return sent.mock.calls
    .map(([payload]) => JSON.parse(payload as string) as Record<string, unknown>)
    .filter((payload) => payload.type === 'orchestrator-send');
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/panel/operator-defaults')) {
      if (freshFetchFails) return new Response('unavailable', { status: 503 });
      if (freshFetchGate) await freshFetchGate;
      if (init?.method === 'POST') {
        return POST(new Request(`http://127.0.0.1${url}`, init));
      }
      return GET(new Request(`http://127.0.0.1${url}`));
    }
    if (url.startsWith('/api/v2/chat-history?tabId=') && historyResponse) {
      return new Response(JSON.stringify(historyResponse), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  }));
  transport.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  freshFetchFails = false;
  freshFetchGate = null;
  releaseFreshFetch = null;
  historyResponse = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ComposerSubmissionHarness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  host.remove();
  localStorage.clear();
  transport.socket = null;
  vi.unstubAllGlobals();
});

describe('composer fresh operator defaults at the send seam', () => {
  it('reaches the live resolver through the real ThoughtsChatPanel send callback', async () => {
    const composerModeStorageId = 'live-mode-tab';
    localStorage.setItem('o8:composer-selector-v1', '0');
    localStorage.setItem(legacySwarmStorageKey(composerModeStorageId), '1');
    await act(async () => root.unmount());
    root = createRoot(host);
    invalidateOperatorDefaultsValuesSnapshot();
    await persistDefaults('gpt-5.6-sol', 'codex');
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    const missionState: OrchestratorMissionState = {
      version: 2,
      prompt: '',
      summary: '',
      packets: [],
      updatedAt: new Date(0).toISOString(),
    };
    await act(async () => {
      root.render(createElement(ThoughtsChatPanel, {
        ref: panelRef,
        open: false,
        agents: [],
        missionState,
        preferredRuntime: 'codex',
        sessionTargets: [],
        workspaceTargets: [],
        repoPath,
        composerModeStorageId,
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
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await persistDefaults('gpt-5.6-terra', 'codex');
    let payload: Record<string, unknown> = {};
    await act(async () => {
      expect(panelRef.current?.sendNow('operator message')).toBe(true);
      payload = await waitForPayload(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const modelButton = [...host.querySelectorAll('button')]
      .find((button) => button.title.startsWith('Terra'));
    expect(modelButton).toBeTruthy();
    expect(payload).toMatchObject({
      model: 'gpt-5.6-terra',
      backend: 'codex',
      orchestrationMode: 'fusion',
      displayMessage: 'operator message',
    });
    expect(payload.message).toContain('[Mode: Fusion]');
    expect(localStorage.getItem(composerModeStorageKey(composerModeStorageId))).toBe('fusion');
    expect(localStorage.getItem(legacySwarmStorageKey(composerModeStorageId))).toBe('0');
  });

  for (const selectorEnabled of [true, false]) {
    it(`resets comparison mode before a ${selectorEnabled ? 'selector' : 'classic'} lead pick reaches routing`, async () => {
      localStorage.setItem('o8:composer-selector-v1', selectorEnabled ? '1' : '0');
      await act(async () => root.unmount());
      root = createRoot(host);
      invalidateOperatorDefaultsValuesSnapshot();
      await persistDefaults('gpt-5.6-sol', 'codex');
      const panelRef = createRef<ThoughtsChatPanelHandle>();
      await act(async () => {
        root.render(createElement(RoutingThoughtsHarness, { panelRef }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const modeTrigger = selectorEnabled
        ? host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')
        : host.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]');
      await act(async () => {
        modeTrigger!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const compareMode = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Compare plans'))!;
      await act(async () => {
        compareMode.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const modelTrigger = selectorEnabled
        ? host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')
        : [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.title.endsWith(' · Compare plans'));
      await act(async () => {
        modelTrigger!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (!selectorEnabled) {
        const codexHouse = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent?.trim() === 'Codex')!;
        await act(async () => {
          codexHouse.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      const pickedModel = selectorEnabled
        ? document.querySelector<HTMLButtonElement>('[data-testid="lead-row-gpt-5.6-terra"]')
        : [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent?.includes('GPT-5.6 Terra'));
      act(() => pickedModel!.click());

      const resetModeTrigger = selectorEnabled
        ? host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')
        : host.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]');
      expect(resetModeTrigger?.textContent ?? resetModeTrigger?.getAttribute('aria-label')).toContain('Solo');

      let payload: Record<string, unknown> = {};
      await act(async () => {
        expect(panelRef.current?.sendNow('route this lead')).toBe(true);
        payload = await waitForPayload(1);
      });
      expect(payload).toMatchObject({
        backend: 'codex',
        model: 'gpt-5.6-terra',
        orchestrationMode: 'single',
      });
      expect(payload.backend).not.toBe('collide');
      expect(payload.message).toContain('[Mode: Solo]');
    });
  }

  it('resets Fusion when a deferred backend handoff applies through the real panel', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    historyResponse = {
      backend: 'codex',
      messages: [
        { id: 'history-user', role: 'user', content: 'previous turn', timestamp: 1 },
        { id: 'history-assistant', role: 'assistant', content: 'previous reply', timestamp: 2, backend: 'codex', model: 'gpt-5.6-sol' },
      ],
    };
    await act(async () => root.unmount());
    root = createRoot(host);
    invalidateOperatorDefaultsValuesSnapshot();
    await persistDefaults('gpt-5.6-sol', 'codex');
    const panelRef = createRef<ThoughtsChatPanelHandle>();
    await act(async () => {
      root.render(createElement(RoutingThoughtsHarness, { panelRef }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(panelRef.current).not.toBeNull();
    await act(async () => {
      panelRef.current!.loadThread('backend-handoff-thread');
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const modeTrigger = host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => modeTrigger.click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Fusion'))!.click());
    const leadTrigger = host.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    act(() => leadTrigger.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="lead-row-claude-sonnet-5"]')!.click());

    expect(modeTrigger.textContent).toContain('Fusion');
    const handoff = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Hand off')!;
    await act(async () => {
      handoff.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(modeTrigger.textContent).toContain('Solo');

    let payload: Record<string, unknown> = {};
    await act(async () => {
      expect(panelRef.current?.sendNow('continue on picked backend')).toBe(true);
      payload = await waitForPayload(1);
    });
    expect(payload).toMatchObject({
      backend: 'claude',
      model: 'claude-sonnet-5',
      orchestrationMode: 'single',
    });
    expect(payload.backend).not.toBe('collide');
    expect(payload.message).toContain('[Mode: Solo]');
  });

  it('carries and displays each persisted default without remounting, while retaining a repo model pin', async () => {
    await persistDefaults('gpt-5.6-sol', 'codex');
    let first: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      first = await waitForPayload(1);
    });
    expect(first).toMatchObject({ model: 'gpt-5.6-sol', backend: 'codex' });
    expect(host.querySelector('[data-testid="displayed-model"]')?.textContent).toBe('gpt-5.6-sol');

    await persistDefaults('claude-sonnet-5', 'claude');
    let second: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      second = await waitForPayload(2);
    });
    expect(second).toMatchObject({ model: 'claude-sonnet-5', backend: 'claude' });
    expect(host.querySelector('[data-testid="displayed-model"]')?.textContent).toBe('claude-sonnet-5');

    writeStoredOrchestratorModel(repoPath, 'gpt-5.6-sol');
    await persistDefaults('claude-sonnet-5', 'claude');
    await act(async () => {
      invokeComposerAction('setComposerBackendOwnership', 'thread');
    });
    let pinned: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      pinned = await waitForPayload(3);
    });
    expect(pinned).toMatchObject({ model: 'gpt-5.6-sol', backend: 'codex' });
    expect(host.querySelector('[data-testid="displayed-model"]')?.textContent).toBe('gpt-5.6-sol');

    await act(async () => {
      invokeComposerAction('setComposerBackendOwnership', 'user');
    });
    let userOwned: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      userOwned = await waitForPayload(4);
    });
    expect(userOwned).toMatchObject({ model: 'gpt-5.6-sol', backend: 'codex' });

    freshFetchFails = true;
    let fallback: Record<string, unknown> = {};
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      fallback = await waitForPayload(5);
    });
    expect(fallback).toMatchObject({ model: 'gpt-5.6-sol', backend: 'codex' });
  });

  it('cancels a pending default refresh when the operator stops or changes repo context', async () => {
    await persistDefaults('claude-sonnet-5', 'claude');
    blockFreshFetch();
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      invokeComposerAction('interruptComposerTurn');
      releaseFreshFetch?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sentTurnPayloads()).toHaveLength(0);

    blockFreshFetch();
    await act(async () => {
      invokeComposerAction('submitComposerTurn');
      invokeComposerAction('switchComposerRepo');
      releaseFreshFetch?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sentTurnPayloads()).toHaveLength(0);
  });
});
