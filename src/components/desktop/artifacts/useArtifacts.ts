'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSWR, refreshSWR, subscribeSWR } from '@/lib/panel/fetch-cache';
import type { ArtifactRef } from './types';

interface UseArtifactsArgs {
  packetId?: string | null;
  prNumber?: number | null;
  laneId?: string | null;
  /** Poll interval (ms). 0/undefined = fetch once. */
  pollMs?: number;
  enabled?: boolean;
}

/**
 * Fetch artifacts for a surface that doesn't already receive them inline (the
 * mission-complete/packet card get them from the mission-status payload; the
 * ReviewPanel / PrPanel fetch via this hook). Returns [] until loaded; never
 * throws.
 */
export function useArtifacts({ packetId, prNumber, laneId, pollMs, enabled = true }: UseArtifactsArgs) {
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([]);
  const [loading, setLoading] = useState(false);

  const key = `${packetId ?? ''}|${prNumber ?? ''}|${laneId ?? ''}`;
  const hasFilter = Boolean(packetId || laneId || (typeof prNumber === 'number'));

  const fetchOnce = useCallback(async () => {
    if (!enabled || !hasFilter) return;
    const params = new URLSearchParams();
    if (packetId) params.set('packetId', packetId);
    if (typeof prNumber === 'number') params.set('prNumber', String(prNumber));
    if (laneId) params.set('laneId', laneId);
    const cacheKey = `artifacts:${key}`;
    try {
      await refreshSWR(cacheKey, async () => {
        const res = await fetch(`/api/panel/artifacts?${params.toString()}`);
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const json = (await res.json()) as { artifacts?: ArtifactRef[] };
        return Array.isArray(json.artifacts) ? json.artifacts : [];
      });
      const snapshot = getSWR<ArtifactRef[]>(cacheKey);
      if (snapshot.data) setArtifacts(snapshot.data);
    } catch {
      /* leave prior state */
    } finally {
      setLoading(false);
    }
  }, [enabled, hasFilter, packetId, prNumber, laneId]);

  useEffect(() => {
    if (!enabled || !hasFilter) {
      setArtifacts([]);
      return;
    }
    const cacheKey = `artifacts:${key}`;
    const applySnapshot = () => {
      const snapshot = getSWR<ArtifactRef[]>(cacheKey);
      if (snapshot.data) setArtifacts(snapshot.data);
      setLoading(!snapshot.data && snapshot.stale);
    };
    applySnapshot();
    const unsubscribe = subscribeSWR(cacheKey, applySnapshot);
    void fetchOnce();

    // Live update (#1147 Phase 2): the ws-server fans out an `artifacts`
    // channel event when an agent records a still, which the desktop WS bridge
    // turns into an `o8:artifacts` window event. Refetch only when the event's
    // identifiers match THIS surface's filter, so the proof strip appears
    // without waiting for a poll/remount and we avoid redundant fetches.
    const onRecorded = (e: Event) => {
      const d = (e as CustomEvent).detail?.data as
        | { packetId?: string | null; prNumber?: number | null; laneId?: string | null }
        | undefined;
      if (!d) return;
      const matches =
        (!!packetId && d.packetId === packetId) ||
        (typeof prNumber === 'number' && d.prNumber === prNumber) ||
        (!!laneId && d.laneId === laneId);
      if (matches) void fetchOnce();
    };
    window.addEventListener('o8:artifacts', onRecorded as EventListener);

    if (!pollMs || pollMs <= 0) {
      return () => {
        unsubscribe();
        window.removeEventListener('o8:artifacts', onRecorded as EventListener);
      };
    }
    const id = window.setInterval(() => { void fetchOnce(); }, pollMs);
    return () => {
      window.removeEventListener('o8:artifacts', onRecorded as EventListener);
      unsubscribe();
      window.clearInterval(id);
    };
  }, [key, enabled, hasFilter, pollMs, fetchOnce, packetId, prNumber, laneId]);

  return { artifacts, loading, refetch: fetchOnce };
}
