'use client';

import { useEffect, useRef, useState } from 'react';
import type { PrDetail, PrDetailResponse } from './types';

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

export function usePrDetail(prNumber: number | null, repoSlug?: string | null): UsePrDetailResult {
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const detailRef = useRef<PrDetail | null>(null);
  detailRef.current = detail;

  useEffect(() => {
    if (!prNumber) {
      setDetail(null);
      setError(null);
      return;
    }

    let active = true;
    const repoQuery = repoSlug ? `?repo=${encodeURIComponent(repoSlug)}` : '';
    const url = `/api/panel/prs/${prNumber}${repoQuery}`;

    async function fetchOnce() {
      try {
        const res = await fetch(url);
        const data = await res.json() as PrDetailResponse & { error?: string };
        if (!active) return;
        if (!res.ok) {
          throw new Error(data.error || `Request failed: ${res.status}`);
        }
        setDetail(data.pr);
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load PR');
      } finally {
        if (active) setLoading(false);
      }
    }

    setLoading(true);
    void fetchOnce();

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    function scheduleNext() {
      if (!active) return;
      const current = detailRef.current;
      const isOpen = (current?.state ?? '').toLowerCase() === 'open';
      const fast = isOpen && hasRunningChecks(current);
      const intervalMs = fast ? 10_000 : 30_000;
      timeoutId = setTimeout(() => {
        void fetchOnce().finally(scheduleNext);
      }, intervalMs);
    }
    scheduleNext();

    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [prNumber, repoSlug, reloadNonce]);

  return {
    detail,
    loading,
    error,
    refresh: () => setReloadNonce((value) => value + 1),
  };
}
