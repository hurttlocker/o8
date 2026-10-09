'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageHistorySummary } from '@/lib/usage/history-types';

export function useUsageHistory(active: boolean, days: 1 | 7 | 30 | 90) {
  const [snapshot, setSnapshot] = useState<UsageHistorySummary | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async (fresh = false) => {
    if (poll.current) clearTimeout(poll.current); poll.current = null;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response = await fetch(`/api/runtime/usage?days=${days}&timeZone=${encodeURIComponent(timeZone)}${fresh ? '&fresh=1' : ''}`,
        { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (response.status === 202 && data?.status === 'scanning') {
        setLoading(true); setError(null); poll.current = setTimeout(() => { void refresh(); }, 2_000); return;
      }
      if (!response.ok || data?.schema !== 'o8/usage-history/v1') throw new Error('Usage unavailable');
      if (!controller.signal.aborted) { setSnapshot(data); setError(data.refreshFailed ? 'Could not refresh local history. Previous observations remain visible.' : null);
        if (data.refreshing) poll.current = setTimeout(() => { void refresh(); }, 2_000); }
    } catch { if (!controller.signal.aborted) setError('Could not refresh local history. Previous observations remain visible.'); }
    finally { if (!controller.signal.aborted && !poll.current) setLoading(false); if (request.current === controller) request.current = null; }
  }, [days]);
  useEffect(() => {
    if (!active) return;
    void refresh(); const timer = window.setInterval(() => { if (!document.hidden && !request.current) void refresh(); }, 60_000);
    return () => { request.current?.abort(); if (poll.current) clearTimeout(poll.current); poll.current = null; window.clearInterval(timer); };
  }, [active, refresh]);
  return { snapshot, loading, error, refresh };
}
