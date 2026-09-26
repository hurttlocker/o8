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
  let pendingThreecodeRuntimeSave: Promise<void> | null;

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
    pendingThreecodeRuntimeSave = null;
    invalidateOperatorDefaultsValuesSnapshot();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).includes('/api/runtime/threecode-models')) {
        return new Response(JSON.stringify({
          groups: [{
            provider: 'deepseek',
            models: [{ id: 'deepseek.deepseek-v4-pro', label: 'DeepSeek V4 Pro', efforts: [] }],
          }],
        }), { status: 200 });
      }
      if (init?.method === 'POST') {
        const body = typeof init.body === 'string'
          ? JSON.parse(init.body) as Record<string, unknown>
          : {};
        postBodies.push(body);
        if (body.defaultDispatchRuntime === '3code' && pendingThreecodeRuntimeSave) {
          await pendingThreecodeRuntimeSave;
        }
        operatorValues = { ...operatorValues, ...body } as ComposerWorkerDefaults;
      }
      return new Response(JSON.stringify({ values: operatorValues, sources: {} }), { status: 200 });
    }));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
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

  it('resolves tab mode and operator worker defaults across in-session and fresh tabs', async () => {
    writeStoredComposerMode('tab-a', 'moa');

    await act(async () => {
      root.render(createElement(RealComposerHarness, { key: 'tab-a', tabId: 'tab-a', threadId: 'thread-a' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    let modeChip = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    let workersChip = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(modeChip.textContent).toContain('MoA');
    expect(modeChip.getAttribute('aria-label')).toBe('Mode: Compare plans');
    expect(workersChip.textContent).toContain('2 Gemini');

    await act(async () => {
      workersChip.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[data-testid="worker-row-gemini"]')?.getAttribute('aria-pressed')).toBe('true');
    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Plan')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="worker-row-codex"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(postBodies).toContainEqual({ defaultDispatchRuntime: 'codex' });
    expect(container.querySelector('[data-testid="composer-selector-test-lead"]')?.textContent).toBe('gpt-5.6-sol');
    workersChip = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(workersChip.textContent).toContain('2 Codex');

    await act(async () => {
      root.render(createElement(RealComposerHarness, { key: 'tab-b', tabId: 'tab-b', threadId: 'thread-b' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    modeChip = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    expect(modeChip.textContent).toContain('Solo');
    expect(container.querySelector('[data-testid="composer-selector-workers"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[data-testid="composer-selector-workers-section"]')).toBeNull();
    expect(document.querySelector('[data-testid^="worker-row-"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Multitask'))!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const freshWorkersChip = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    await act(async () => {
      freshWorkersChip.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[data-testid="worker-row-codex"]')?.getAttribute('aria-pressed')).toBe('true');
    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Plan')?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      root.render(createElement(RealComposerHarness, { key: 'tab-a-remount', tabId: 'tab-a', threadId: 'thread-a' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    modeChip = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    workersChip = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(modeChip.getAttribute('aria-label')).toBe('Mode: Compare plans');
    expect(workersChip.textContent).toContain('2 Codex');
  });

  it('keeps runtime-scoped optimistic worker pins isolated while 3code switches asynchronously', async () => {
    operatorValues = {
      ...operatorValues,
      defaultDispatchRuntime: 'opencode',
      opencodeWorkerModel: 'openrouter/openai/gpt-5.6',
    };
    writeStoredComposerMode('tab-async-runtime', 'moa');
    let releaseRuntimeSave!: () => void;
    pendingThreecodeRuntimeSave = new Promise<void>((resolve) => { releaseRuntimeSave = resolve; });

    await act(async () => {
      root.render(createElement(RealComposerHarness, { tabId: 'tab-async-runtime', threadId: 'thread-async-runtime' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="worker-row-3code"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const workerChip = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(workerChip.getAttribute('aria-label')).toBe('Workers: 2 3code, runtime default');
    expect(workerChip.getAttribute('aria-label')).not.toContain('openrouter/openai/gpt-5.6');
    expect(container.querySelector('[data-testid="composer-selector-test-lead"]')?.textContent).toBe('gpt-5.6-sol');

    await act(async () => {
      releaseRuntimeSave();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  });

  it('selects a configured 3code worker model without changing the Sol lead', async () => {
    operatorValues = { ...operatorValues, defaultDispatchRuntime: 'opencode' };
    writeStoredComposerMode('tab-threecode-model', 'moa');
    await act(async () => {
      root.render(createElement(RealComposerHarness, { tabId: 'tab-threecode-model', threadId: 'thread-threecode-model' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.querySelector<HTMLButtonElement>('[data-testid="worker-row-3code"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Provider Deepseek"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.querySelector<HTMLButtonElement>('[title="deepseek.deepseek-v4-pro"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(postBodies).toContainEqual({ defaultDispatchRuntime: '3code' });
    expect(postBodies).toContainEqual({ threecodeWorkerModel: 'deepseek.deepseek-v4-pro' });
    expect(container.querySelector('[data-testid="composer-selector-test-lead"]')?.textContent).toBe('gpt-5.6-sol');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')?.getAttribute('aria-label'))
      .toBe('Workers: 2 3code, deepseek.deepseek-v4-pro');
  });
});
