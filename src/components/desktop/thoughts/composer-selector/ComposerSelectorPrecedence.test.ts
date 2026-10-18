// @vitest-environment jsdom

vi.mock('@/components/desktop/onboarding/useRuntimeInventory', async () => {
  const { listDispatchableRuntimes } = await import('@/lib/orchestrator/runtime-capabilities');
  return { useRuntimeInventory: () => ({
    inventory: listDispatchableRuntimes().map((id) => ({ id, label: id, available: true, unavailableReason: null, detail: '', fix: '' })),
    loading: false, error: null, refresh: () => {},
  }) };
});

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { ComposerArea } from '../chat-panel/ComposerArea';
import { writeStoredComposerMode } from '../composer-mode-storage';
import type { ComposerSelectorMode } from './state';
import type { ComposerWorkerDefaults } from './worker-settings';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function RealComposerHarness({ tabId, threadId }: { tabId: string; threadId: string }) {
  const [input, setInput] = useState('Build it');
  const [mode, setMode] = useState<ComposerSelectorMode>('solo');
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const [model, setModel] = useState('gpt-5.6-sol');
  return createElement('div', null,
    createElement('span', { 'data-testid': 'composer-selector-test-lead' }, model),
    createElement(ComposerArea, {
    activeComposer: true,
    input,
    onInputChange: setInput,
    isOrchestratorMode: true,
    displayWaiting: false,
    chatMessages: [],
    activeTargetLabel: 'Orchestrator',
    targetAgentExists: true,
    thoughtsBodyBackground: 'var(--t-chat-surface-bg)',
    enhancing: false,
    preEnhanceInput: null,
    onEnhance: () => {},
    onUndoEnhance: () => {},
    onSubmit: () => {},
    onSlashCommand: () => {},
    modelLabel: 'Sol',
    modelId: model,
    onModelRestore: setModel,
    onModelChange: setModel,
    activeBackend: 'codex',
    effort,
    operatorDefaultEffort: 'high',
    onEffortChange: setEffort,
    adaptiveEnabled: true,
    displayMessagesCount: 0,
    hasAssistantActivity: false,
    composerMode: mode,
    onComposerModeChange: setMode,
    composerModeStorageId: tabId,
    sessionRulesThreadId: threadId,
      repoPath: '/repo/selector-precedence',
    }),
  );
}

describe('composer selector real-path precedence', () => {
  let container: HTMLDivElement;
  let root: Root;
  let operatorValues: ComposerWorkerDefaults;
  let postBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    localStorage.clear();
    operatorValues = {
      defaultDispatchRuntime: 'gemini',
      defaultDispatchModel: '',
      opencodeWorkerModel: null,
      threecodeWorkerModel: null,
      workerStartMode: 'huddle',
    };
    postBodies = [];
    invalidateOperatorDefaultsValuesSnapshot();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = typeof init.body === 'string'
          ? JSON.parse(init.body) as Record<string, unknown>
          : {};
        postBodies.push(body);
        operatorValues = { ...operatorValues, ...body } as ComposerWorkerDefaults;
      }
      return new Response(JSON.stringify({ values: operatorValues, sources: {} }), { status: 200 });
    }));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    invalidateOperatorDefaultsValuesSnapshot();
    vi.unstubAllGlobals();
  });

  it('restores each tab mode while keeping the worker pool out of every composer mode', async () => {
    writeStoredComposerMode('tab-a', 'moa');
    for (const [tabId, label] of [['tab-a', 'Mode: Compare plans'], ['tab-b', 'Mode: Solo'], ['tab-a', 'Mode: Compare plans']]) {
      await act(async () => {
        root.render(createElement(RealComposerHarness, { key: tabId, tabId, threadId: `thread-${tabId}` }));
        await new Promise(resolve => setTimeout(resolve, 30));
      });
      expect(container.querySelector('[data-testid="composer-selector-mode"]')?.getAttribute('aria-label')).toBe(label);
      expect(container.querySelector('[data-testid="composer-selector-workers"]')).toBeNull();
    }
    expect(postBodies).toEqual([]);
    expect(operatorValues.defaultDispatchRuntime).toBe('gemini');
  });

  it('changes the lead without rewriting the configured worker or its effort', async () => {
    writeStoredComposerMode('tab-lead', 'multitask');
    const before = { ...operatorValues };
    await act(async () => { root.render(createElement(RealComposerHarness, { tabId: 'tab-lead', threadId: 'thread-lead' })); await new Promise(resolve => setTimeout(resolve, 30)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="lead-row-gpt-6-luna"]')!.click(); });
    expect(container.querySelector('[data-testid="composer-selector-test-lead"]')?.textContent).toBe('gpt-6-luna');
    expect(operatorValues).toEqual(before);
    expect(postBodies).toEqual([]);
  });
});
