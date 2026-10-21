'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageHistorySummary } from '@/lib/usage/history-types';

export function useUsageHistory(active: boolean, days: 1 | 7 | 30 | 90, machine = 'local') {
  const key = `${machine}:${days}`;
  const cache = useRef(new Map<string, UsageHistorySummary>());
  const [observation, setObservation] = useState<{ key: string; snapshot: UsageHistorySummary } | null>(null);
  const snapshot = observation?.key === key ? observation.snapshot : cache.current.get(key) ?? null;
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async (fresh = false) => {
    if (poll.current) clearTimeout(poll.current); poll.current = null;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError(null);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response = await fetch(`/api/runtime/usage?days=${days}&timeZone=${encodeURIComponent(timeZone)}&machine=${encodeURIComponent(machine)}${fresh ? '&fresh=1' : ''}`,
        { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (response.status === 202 && data?.status === 'scanning') {
        setLoading(true); setError(null); poll.current = setTimeout(() => { void refresh(); }, 2_000); return;
      }
      if (!response.ok || data?.schema !== 'o8/usage-history/v1' || (data.machine && data.machine.id !== machine)) throw new Error('Usage unavailable');
      if (!controller.signal.aborted) { cache.current.set(key, data); setObservation({ key, snapshot: data }); setError(data.refreshFailed ? 'Could not refresh this machine’s history. Previous observations remain visible.' : null);
        if (data.refreshing) poll.current = setTimeout(() => { void refresh(); }, 2_000); }
    } catch { if (!controller.signal.aborted) setError(cache.current.has(key) ? 'Could not refresh this machine’s history. Previous observations remain visible.'
      : machine === 'local' ? 'This machine’s history could not be read.' : 'Could not reach this machine’s usage. Check its SSH connection and Node 22.'); }
    finally { if (!controller.signal.aborted && !poll.current) setLoading(false); if (request.current === controller) request.current = null; }
  }, [days, key, machine]);
  useEffect(() => {
    if (!active) return;
    void refresh(); const timer = window.setInterval(() => { if (!document.hidden && !request.current) void refresh(); }, 60_000);
    return () => { request.current?.abort(); if (poll.current) clearTimeout(poll.current); poll.current = null; window.clearInterval(timer); };
  }, [active, refresh]);
  return { snapshot, loading, error, refresh };
}
