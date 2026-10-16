'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getSWR, refreshSWR, subscribeSWR } from '@/lib/panel/fetch-cache';
import type { PrDetail, PrDetailResponse } from './types';
import { PrReadDeferredError, readPrJson } from './read-pr-json';

type Snapshot = PrDetail & { loadedAt: number };

interface UsePrDetailResult {
  detail: PrDetail | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function hasRunningChecks(detail: PrDetail | null): boolean {
  if (!detail) return false;
  return detail.statusCheckRollup.some((check) => {
    const status = (check.status ?? '').toLowerCase();
    return status === 'in_progress' || status === 'queued' || status === 'pending' || status === 'waiting';
  });
}

export function usePrDetail(prNumber: number | null, repoSlug?: string | null, visible = true): UsePrDetailResult {
  const key = prNumber ? `pr-detail:${repoSlug ?? ''}:${prNumber}` : null;
  const [reloadNonce, setReloadNonce] = useState(0);
  const [failure, setFailure] = useState<{ key: string; nonce: number; message: string } | null>(null);
  // Read only this selection's snapshot during render. A new PR must never
  // inherit the previous PR's content while its request is in flight.
  const subscribe = useCallback((listener: () => void) => key ? subscribeSWR(key, listener) : () => {}, [key]);
  const readSnapshot = useCallback(() => key ? getSWR<Snapshot>(key).data ?? null : null, [key]);
  const detail = useSyncExternalStore(subscribe, readSnapshot, () => null);
  const error = failure?.key === key && failure.nonce === reloadNonce ? failure.message : null;

  useEffect(() => {
    if (!visible || !prNumber || !key) return;
    const selectionKey = key;

    let active = true;
    const repoQuery = repoSlug ? `?repo=${encodeURIComponent(repoSlug)}` : '';
    const url = `/api/panel/prs/${prNumber}${repoQuery}`;

    let retryAt = 0;
    const fetchDetail = async (background: boolean) => {
      const data = await readPrJson<PrDetailResponse>(`${url}${background ? `${repoQuery ? '&' : '?'}poll=1` : ''}`);
      return { ...data.pr, loadedAt: Date.now() };
    };
    async function fetchOnce(background = false) {
      if (!active) return;
      if (background && (document.visibilityState === 'hidden' || Date.now() < retryAt)) return;
      setFailure(null);
      try {
        await refreshSWR(selectionKey, () => fetchDetail(background));
      } catch (err) {
        if (!active) return;
        if (err instanceof PrReadDeferredError) retryAt = Date.now() + err.retryAfterMs;
        setFailure({ key: selectionKey, nonce: reloadNonce, message: err instanceof Error ? err.message : 'Failed to load PR' });
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    function scheduleNext() {
      if (!active) return;
      const current = getSWR<PrDetail>(selectionKey).data ?? null;
      const isOpen = (current?.state ?? '').toLowerCase() === 'open';
      const fast = isOpen && hasRunningChecks(current);
      const intervalMs = Math.max(fast ? 30_000 : 120_000, retryAt - Date.now());
      timeoutId = setTimeout(() => {
        void fetchOnce(true).finally(scheduleNext);
      }, intervalMs);
    }
    const cached = getSWR<Snapshot>(selectionKey).data;
    // Opening a recently read PR is immediate and does not restart its read.
    // Manual Retry/Refresh and visible check polling always request fresh data.
    if (!reloadNonce && cached && Date.now() - cached.loadedAt < 20_000) scheduleNext();
    else void fetchOnce().finally(scheduleNext);

    const onVisible = () => { if (document.visibilityState !== 'hidden') void fetchOnce(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisible);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [visible, prNumber, repoSlug, key, reloadNonce]);

  return {
    detail,
    loading: Boolean(key && !detail && !error),
    error,
    refresh: () => setReloadNonce((value) => value + 1),
  };
}
