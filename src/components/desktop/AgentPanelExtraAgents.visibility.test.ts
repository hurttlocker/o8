// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import { AgentPanelExtraAgents } from './AgentPanelExtraAgents';

const native = vi.hoisted(() => ({
  visible: false,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isVisible: async () => native.visible,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('agent rail inventory polling in a native window', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    native.visible = false;
    Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } } } });
    expect(canUseTauriEvents()).toBe(true);
    expect(document.visibilityState).toBe('visible');
    fetcher = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input).includes('/api/lanes') ? { lanes: [] } : { agents: [], meta: { mode: 'live' } },
    }));
    vi.stubGlobal('fetch', fetcher);
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(AgentPanelExtraAgents, { packets: [] }));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('skips forced discovery while hidden and refreshes when the window regains focus', async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/runtime/inventory?fresh=1'))).toHaveLength(0);

    native.visible = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/runtime/inventory?fresh=1'))).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/runtime/inventory?fresh=1'))).toHaveLength(2);

    native.visible = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/runtime/inventory?fresh=1'))).toHaveLength(2);
  });
});
