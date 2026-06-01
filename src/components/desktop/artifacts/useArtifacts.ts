'use client';

import { useCallback, useEffect, useState } from 'react';
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
    try {
      setLoading(true);
      const res = await fetch(`/api/panel/artifacts?${params.toString()}`);
      if (!res.ok) return;
      const json = (await res.json()) as { artifacts?: ArtifactRef[] };
      setArtifacts(Array.isArray(json.artifacts) ? json.artifacts : []);
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
    void fetchOnce();
    if (!pollMs || pollMs <= 0) return;
    const id = window.setInterval(() => { void fetchOnce(); }, pollMs);
    return () => window.clearInterval(id);
  }, [key, enabled, hasFilter, pollMs, fetchOnce]);

  return { artifacts, loading, refetch: fetchOnce };
}
