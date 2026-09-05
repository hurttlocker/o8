// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatgptVoiceCapability } from './use-chatgpt-voice-capability';

describe('useChatgptVoiceCapability', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('defers the passive launch probe and coalesces concurrent consumers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        capability: {
          capable: true,
          whyNot: null,
          auth: { chatgptOAuth: true },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    function Probe() {
      const capability = useChatgptVoiceCapability({ deferMs: 5_000 });
      return createElement('span', null, capability.status);
    }

    await act(async () => {
      root.render(createElement('div', null, createElement(Probe), createElement(Probe)));
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('readyready');
  });
});
