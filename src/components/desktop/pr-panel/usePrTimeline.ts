'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getSWR, refreshSWR, subscribeSWR } from '@/lib/panel/fetch-cache';
import type { PrTimelinePage } from './types';
import { readPrJson } from './read-pr-json';

type Snapshot = PrTimelinePage & { loadedAt: number };

export function usePrTimeline(number: number, repo: string | null | undefined, active: boolean) {
  const key = `pr-timeline:${repo || ''}:${number}`;
  const subscribe = useCallback((listener: () => void) => subscribeSWR(key, listener), [key]);
  const read = useCallback(() => getSWR<Snapshot>(key).data ?? null, [key]);
  const data = useSyncExternalStore(subscribe, read, () => null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string; page: number } | null>(null);
  const empty = data === null;

  const load = useCallback(async (page = 1) => {
    setPendingKey(key); setFailure(null);
    try {
      await refreshSWR<Snapshot>(key, async () => {
        const search = new URLSearchParams({ page: String(page) });
        if (repo) search.set('repo', repo);
        const result = await readPrJson<PrTimelinePage>(`/api/panel/prs/${number}/timeline?${search}`);
        const previous = page > 1 ? getSWR<Snapshot>(key).data?.events ?? [] : [];
        const merged = new Map([...previous, ...result.events].map((event) => [event.id, event]));
        return { events: [...merged.values()], nextPage: result.nextPage, loadedAt: Date.now() };
      });
    } catch (error) {
      setFailure({ key, page, message: error instanceof Error ? error.message : 'Activity could not be loaded.' });
    } finally { setPendingKey((current) => current === key ? null : current); }
  }, [key, number, repo]);

  useEffect(() => {
    const cached = getSWR<Snapshot>(key).data;
    if (active && (!cached || Date.now() - cached.loadedAt > 60_000)) void load();
  }, [active, key, load, empty]);

  return {
    data,
    loading: pendingKey === key || Boolean(active && !data && failure?.key !== key),
    error: failure?.key === key ? failure.message : null,
    refresh: () => load(),
    retry: () => load(failure?.key === key ? failure.page : 1),
    loadMore: () => data?.nextPage ? load(data.nextPage) : Promise.resolve(),
  };
}
