// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/entitlement/context', () => ({
  useEntitlement: () => ({ founder: null }),
}));

vi.mock('./RecallHealthSection', () => ({ RecallHealthSection: () => null }));
vi.mock('./LoopStatusSection', () => ({ LoopStatusSection: () => null }));
vi.mock('./DemoRunSection', () => ({ DemoRunSection: () => null }));
vi.mock('./ShippedDarkAuditSection', () => ({ ShippedDarkAuditSection: () => null }));

import { DiagnosticsTab } from './DiagnosticsTab';
import { LocalModelsSection } from './LocalModelsSection';

const ollamaTool = {
  id: 'ollama',
  detected: true,
  ready: true,
  version: '0.11.4',
};

const ollamaPayload = {
  tools: [ollamaTool],
  running: ollamaTool.detected && ollamaTool.ready,
  models: ['qwen2.5-coder:7b'],
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('DiagnosticsTab Ollama visibility', () => {
  let diagnosticsContainer: HTMLDivElement;
  let diagnosticsRoot: Root;
  let localModelsContainer: HTMLDivElement;
  let localModelsRoot: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    diagnosticsContainer = document.createElement('div');
    localModelsContainer = document.createElement('div');
    document.body.append(diagnosticsContainer, localModelsContainer);
    diagnosticsRoot = createRoot(diagnosticsContainer);
    localModelsRoot = createRoot(localModelsContainer);
  });

  afterEach(() => {
    act(() => {
      diagnosticsRoot.unmount();
      localModelsRoot.unmount();
    });
    diagnosticsContainer.remove();
    localModelsContainer.remove();
    vi.unstubAllGlobals();
  });

  it('shows Ollama as healthy in Diagnostics and Local Models from the same payload', async () => {
    const fetchMock = vi.fn(async () => Response.json(ollamaPayload));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      diagnosticsRoot.render(createElement(DiagnosticsTab));
      localModelsRoot.render(createElement(LocalModelsSection, {
        values: {
          defaultDispatchModel: 'ollama:qwen2.5-coder:7b',
          localInferenceBaseUrl: 'http://localhost:11434',
          localEmbedModel: 'nomic-embed-text',
          localChatModel: 'qwen2.5-coder:7b',
        },
        sources: {
          defaultDispatchModel: 'file',
          localInferenceBaseUrl: 'file',
          localEmbedModel: 'file',
          localChatModel: 'file',
        },
        busyField: null,
        envDisabledReason: '',
        onCommit: vi.fn(),
      }));
      await settle();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/setup/detect');
    expect(fetchMock).toHaveBeenCalledWith('/api/setup/local-inference/probe', { cache: 'no-store' });

    const diagnosticsText = diagnosticsContainer.textContent ?? '';
    const localModelsText = localModelsContainer.textContent ?? '';
    const diagnosticsShowsOllama = diagnosticsText.includes('Ollama');
    const localModelsShowsOllama = localModelsText.includes('Ollama');
    const diagnosticsShowsHealthyOllama = diagnosticsText.includes('0.11.4')
      && !diagnosticsText.includes('Missing');
    const localModelsShowsHealthyOllama = localModelsText.includes('running / 1 models')
      && !localModelsText.includes('offline');

    expect(diagnosticsShowsOllama).toBe(true);
    expect(diagnosticsShowsOllama).toBe(localModelsShowsOllama);
    expect(diagnosticsShowsHealthyOllama).toBe(true);
    expect(diagnosticsShowsHealthyOllama).toBe(localModelsShowsHealthyOllama);
  });
});
