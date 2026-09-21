'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ArchitectureDeltaResult } from '@/lib/review/architecture-delta-types';

interface UseArchitectureDeltaOptions {
  repoPath?: string | null;
  laneId?: string | null;
  analysisKey: string;
  enabled: boolean;
}

export interface ArchitectureDeltaState {
  result: ArchitectureDeltaResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useArchitectureDelta({
  repoPath,
  laneId,
  analysisKey,
  enabled,
}: UseArchitectureDeltaOptions): ArchitectureDeltaState {
  const requestVersion = useRef(0);
  const [result, setResult] = useState<ArchitectureDeltaResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!enabled || (!laneId && !repoPath)) {
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const query = laneId
        ? `lane=${encodeURIComponent(laneId)}`
        : `workspace=${encodeURIComponent(repoPath ?? '')}`;
      const response = await fetch(`/api/review/architecture-delta?${query}`, { cache: 'no-store' });
      const body = await response.json().catch(() => null) as (ArchitectureDeltaResult & { error?: string }) | null;
      if (version !== requestVersion.current) return;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? 'Unable to load the architecture delta.');
      }
      setResult(body);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setResult(null);
      setError(err instanceof Error ? err.message : 'Unable to load the architecture delta.');
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [enabled, laneId, repoPath]);

  useEffect(() => {
    void refresh();
    return () => { requestVersion.current += 1; };
  }, [analysisKey, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const handler = () => { void refresh(); };
    window.addEventListener('o8:lifecycle-reconcile', handler);
    return () => window.removeEventListener('o8:lifecycle-reconcile', handler);
  }, [enabled, refresh]);

  return { result, loading, error, refresh };
}
