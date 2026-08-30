'use client';

import { useEffect, useRef, useState } from 'react';
import { getSWR, refreshSWR, subscribeSWR } from '@/lib/panel/fetch-cache';
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
  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    if (!prNumber) {
      setDetail(null);
      setError(null);
      return;
    }

    let active = true;
    const repoQuery = repoSlug ? `?repo=${encodeURIComponent(repoSlug)}` : '';
    const url = `/api/panel/prs/${prNumber}${repoQuery}`;

    const key = `pr-detail:${repoSlug ?? ''}:${prNumber}`;
    const fetchDetail = async () => {
      const res = await fetch(url);
      const data = await res.json() as PrDetailResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
      return data.pr;
    };
    const applySnapshot = () => {
      const snapshot = getSWR<PrDetail>(key);
      if (snapshot.data) setDetail(snapshot.data);
      setLoading(!snapshot.data && snapshot.stale);
    };
    async function fetchOnce() {
      try {
        await refreshSWR(key, fetchDetail);
        if (!active) return;
        applySnapshot();
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load PR');
      }
    }

    applySnapshot();
    const unsubscribe = subscribeSWR(key, () => {
      if (active) applySnapshot();
    });
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
      unsubscribe();
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
