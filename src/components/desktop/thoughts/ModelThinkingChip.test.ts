// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelThinkingChip } from './ModelThinkingChip';

describe('ModelThinkingChip Claude Code carrier truth', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows the effective Codex model instead of the stale native Claude selection', async () => {
    const fetchProfile = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        profile: { source: 'codex-subscription' },
        effectiveModel: 'gpt-5.6-sol',
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchProfile);

    await act(async () => {
      root.render(createElement(ModelThinkingChip, {
        modelLabel: 'Opus 4.8',
        modelId: 'claude-opus-4-8',
        activeBackend: 'claude',
        effort: 'high',
        adaptiveEnabled: true,
        onEffortChange: () => {},
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(fetchProfile).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Sol');
    expect(container.textContent).not.toContain('Opus 4.8');
  });
});
