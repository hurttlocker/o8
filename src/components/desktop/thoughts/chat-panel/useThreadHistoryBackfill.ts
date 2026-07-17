'use client';

import { useCallback, useEffect, useRef } from 'react';

const TOP_LOAD_THRESHOLD_PX = 240;

export interface ThreadHistoryPage<T> {
  messages: T[];
  page?: {
    hasMore?: boolean;
    beforeCursor?: string | null;
  };
}

interface ThreadHistoryBackfillOptions<T> {
  fetchPage: (tabId: string, before: string) => Promise<ThreadHistoryPage<T> | null>;
  getScrollContainer: () => HTMLElement | null;
  onPrepend: (messages: T[]) => void;
}

/**
 * Pages older thread history without blocking the tail's first paint. The
 * scroll-height compensation keeps the row under the reader's eye fixed while
 * React prepends a page above it.
 */
export function useThreadHistoryBackfill<T>({
  fetchPage,
  getScrollContainer,
  onPrepend,
}: ThreadHistoryBackfillOptions<T>) {
  const stateRef = useRef<{ tabId: string; before: string | null; hasMore: boolean; generation: number } | null>(null);
  const loadingRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);

  const cancelIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const loadOlderPage = useCallback(async () => {
    const state = stateRef.current;
    if (!state?.hasMore || !state.before || loadingRef.current) return;
    loadingRef.current = true;
    const { tabId, before, generation } = state;
    const container = getScrollContainer();
    const priorHeight = container?.scrollHeight ?? 0;
    try {
      const result = await fetchPage(tabId, before);
      const current = stateRef.current;
      if (!result || !current || current.generation !== generation || current.tabId !== tabId) return;

      current.hasMore = result.page?.hasMore === true;
      current.before = result.page?.beforeCursor ?? null;
      if (result.messages.length > 0) {
        onPrepend(result.messages);
        requestAnimationFrame(() => {
          if (!container?.isConnected) return;
          container.scrollTop += container.scrollHeight - priorHeight;
        });
      }
    } finally {
      loadingRef.current = false;
    }
  }, [fetchPage, getScrollContainer, onPrepend]);

  const scheduleIdlePage = useCallback(() => {
    const state = stateRef.current;
    if (!state?.hasMore || idleTimerRef.current !== null) return;
    // Small timeout is webview-safe where requestIdleCallback is absent, and
    // gives the tail page a frame to render before history work begins.
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      void loadOlderPage().then(scheduleIdlePage);
    }, 120);
  }, [loadOlderPage]);

  const startBackfill = useCallback((tabId: string, page: ThreadHistoryPage<T>['page']) => {
    cancelIdle();
    stateRef.current = {
      tabId,
      before: page?.beforeCursor ?? null,
      hasMore: page?.hasMore === true,
      generation: (stateRef.current?.generation ?? 0) + 1,
    };
    scheduleIdlePage();
  }, [cancelIdle, scheduleIdlePage]);

  const cancelBackfill = useCallback(() => {
    cancelIdle();
    if (stateRef.current) {
      stateRef.current = { ...stateRef.current, hasMore: false, generation: stateRef.current.generation + 1 };
    }
  }, [cancelIdle]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (event.currentTarget.scrollTop <= TOP_LOAD_THRESHOLD_PX) {
      cancelIdle();
      void loadOlderPage().then(scheduleIdlePage);
    }
  }, [cancelIdle, loadOlderPage, scheduleIdlePage]);

  useEffect(() => cancelIdle, [cancelIdle]);

  return { startBackfill, cancelBackfill, onScroll };
}
