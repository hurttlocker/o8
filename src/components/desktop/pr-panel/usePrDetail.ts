'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrDetail } from './types';
import { PrReadDeferredError } from './read-pr-json';
import { prPanelDetailQuery, refreshPrPanelDetail } from './detail-query';

function hasRunningChecks(detail: PrDetail | undefined): boolean {
  return Boolean(detail?.statusCheckRollup.some(check => ['in_progress', 'queued', 'pending', 'waiting'].includes((check.status ?? '').toLowerCase())));
}

export function usePrDetail(prNumber: number | null, repoSlug?: string | null, visible = true) {
  const client = useQueryClient();
  const options = useMemo(() => prPanelDetailQuery(repoSlug, prNumber ?? 0), [repoSlug, prNumber]);
  const query = useQuery({ ...options, enabled: Boolean(visible && prNumber) });

  useEffect(() => {
    if (!visible || !prNumber) return;
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    function retryAt() {
      const state = client.getQueryState(options.queryKey);
      return state?.error instanceof PrReadDeferredError ? state.errorUpdatedAt + state.error.retryAfterMs : 0;
    }
    async function backgroundRead(scheduled = false) {
      if (!active || document.visibilityState === 'hidden' || Date.now() < retryAt()) return;
      const state = client.getQueryState(options.queryKey);
      const cadence = state?.data?.state.toLowerCase() === 'open' && hasRunningChecks(state.data) ? 30_000 : 120_000;
      // Staggered observers may fire after a sibling's read has already settled.
      if (scheduled && state && Date.now() - Math.max(state.dataUpdatedAt, state.errorUpdatedAt) < cadence) return;
      try {
        await client.fetchQuery({ ...prPanelDetailQuery(repoSlug, prNumber!, true), staleTime: 0 });
      } catch { /* The shared query retains detail and exposes recovery to all observers. */ }
    }
    function scheduleNext() {
      if (!active) return;
      if (timeoutId) clearTimeout(timeoutId);
      const current = client.getQueryData(options.queryKey);
      const fast = current?.state.toLowerCase() === 'open' && hasRunningChecks(current);
      timeoutId = setTimeout(() => { void backgroundRead(true).finally(scheduleNext); }, Math.max(fast ? 30_000 : 120_000, retryAt() - Date.now()));
    }
    const cache = client.getQueryCache();
    const tracked = cache.find({ queryKey: options.queryKey, exact: true });
    const unsubscribe = cache.subscribe(event => {
      if (event.type === 'updated' && event.query === tracked && (event.action.type === 'success' || event.action.type === 'error')) scheduleNext();
    });
    // Join the initial read (or reuse a warm snapshot) before choosing the check cadence.
    void client.fetchQuery(options).catch(() => {}).finally(scheduleNext);
    const onVisible = () => { if (document.visibilityState !== 'hidden') void backgroundRead(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      unsubscribe();
      if (timeoutId) clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, options, prNumber, repoSlug, visible]);

  const refresh = useCallback(() => {
    if (prNumber) void refreshPrPanelDetail(client, repoSlug, prNumber).catch(() => {});
  }, [client, prNumber, repoSlug]);
  return {
    detail: query.data ?? null,
    loading: Boolean(prNumber && !query.data && (!query.error || query.isFetching)),
    error: query.isFetching ? null : query.error?.message ?? null,
    refresh,
  };
}
