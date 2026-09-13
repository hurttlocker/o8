// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import { writeStoredOrchestratorModel } from '@/lib/orchestrator/store';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { ComposerArea } from '../chat-panel/ComposerArea';
import { composerModeStorageKey, writeStoredComposerMode } from '../composer-mode-storage';
import type { ComposerSelectorMode } from './state';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const STORED_MODEL_TAB_ID = 'stored-model-tab';

function StoredModelRestoreHarness({ repoPath }: { repoPath: string }) {
  const [input, setInput] = useState('Build it');
  const [mode, setMode] = useState<ComposerSelectorMode>('fusion');
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const [model, setModel] = useState('gpt-5.6-sol');
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'stored-model-mode' }, mode),
    createElement('span', { 'data-testid': 'stored-model-value' }, model),
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
      modelLabel: model,
      modelId: model,
      onModelRestore: setModel,
      onModelChange: (nextModel) => {
        setMode('solo');
        setModel(nextModel);
      },
      activeBackend: 'codex',
      effort,
      operatorDefaultEffort: 'high',
      onEffortChange: setEffort,
      adaptiveEnabled: true,
      displayMessagesCount: 0,
      hasAssistantActivity: false,
      composerMode: mode,
      onComposerModeChange: setMode,
      composerModeStorageId: STORED_MODEL_TAB_ID,
      sessionRulesThreadId: 'stored-model-thread',
      repoPath,
    }),
  );
}

describe('composer selector model restore', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    invalidateOperatorDefaultsValuesSnapshot();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      values: {
        defaultDispatchRuntime: 'codex',
        defaultDispatchModel: '',
        opencodeWorkerModel: null,
        workerStartMode: 'autonomous',
      },
      sources: {},
    }), { status: 200 })));
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

  it('restores a per-repo model without treating the restore as a user lead pick', async () => {
    writeStoredComposerMode(STORED_MODEL_TAB_ID, 'fusion');
    writeStoredOrchestratorModel('/repo/alpha', 'gpt-5.6-terra');
    writeStoredOrchestratorModel('/repo/beta', 'gpt-5.6-luna');

    await act(async () => {
      root.render(createElement(StoredModelRestoreHarness, { repoPath: '/repo/alpha' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[data-testid="stored-model-value"]')?.textContent).toBe('gpt-5.6-terra');
    expect(container.querySelector('[data-testid="stored-model-mode"]')?.textContent).toBe('fusion');
    expect(localStorage.getItem(composerModeStorageKey(STORED_MODEL_TAB_ID))).toBe('fusion');

    await act(async () => {
      root.render(createElement(StoredModelRestoreHarness, { repoPath: '/repo/beta' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[data-testid="stored-model-value"]')?.textContent).toBe('gpt-5.6-luna');
    expect(container.querySelector('[data-testid="stored-model-mode"]')?.textContent).toBe('fusion');
    expect(localStorage.getItem(composerModeStorageKey(STORED_MODEL_TAB_ID))).toBe('fusion');
  });
});
