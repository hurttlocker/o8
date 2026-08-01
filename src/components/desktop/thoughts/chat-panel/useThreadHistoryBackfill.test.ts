// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadHistoryBackfill } from './useThreadHistoryBackfill';

describe('useThreadHistoryBackfill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('stops requesting pages when the bounded history window fills', async () => {
    const fetchPage = vi.fn(async () => ({
      messages: ['older'],
      page: { hasMore: true, beforeCursor: 'next-page' },
    }));

    function Harness() {
      const { startBackfill } = useThreadHistoryBackfill({
        fetchPage,
        getScrollContainer: () => null,
        onPrepend: () => false,
      });
      useEffect(() => startBackfill('thread-1', { hasMore: true, beforeCursor: 'first-page' }), [startBackfill]);
      return null;
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
