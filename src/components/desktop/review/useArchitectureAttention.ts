'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ArchitectureAttentionResult } from '@/lib/review/architecture-attention-types';
import type { ArchitectureDeltaResult } from '@/lib/review/architecture-delta-types';

interface UseArchitectureAttentionOptions {
  repoPath?: string | null;
  laneId?: string | null;
  analysis: ArchitectureDeltaResult | null;
  scopePaths: string[];
  enabled: boolean;
}

export interface ArchitectureAttentionState {
  result: ArchitectureAttentionResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useArchitectureAttention({
  repoPath,
  laneId,
  analysis,
  scopePaths,
  enabled,
}: UseArchitectureAttentionOptions): ArchitectureAttentionState {
  const requestVersion = useRef(0);
  const [result, setResult] = useState<ArchitectureAttentionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = scopePaths.join('\0');

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!enabled || !analysis?.analysisId || analysis.status !== 'ready' || (!laneId && !repoPath)) {
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }

    setResult(null);
    setLoading(true);
    setError(null);
    try {
      const requestedScopePaths = scopeKey.length > 0 ? scopeKey.split('\0') : [];
      const query = laneId
        ? `lane=${encodeURIComponent(laneId)}`
        : `workspace=${encodeURIComponent(repoPath ?? '')}`;
      const response = await fetch(`/api/review/architecture-attention?${query}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedAnalysisId: analysis.analysisId,
          scopePaths: requestedScopePaths,
        }),
      });
      const body = await response.json().catch(() => null) as (ArchitectureAttentionResult & { error?: string }) | null;
      if (version !== requestVersion.current) return;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? 'Unable to load the advisory review lens.');
      }
      if (body.analysisId && body.analysisId !== analysis.analysisId) return;
      setResult(body);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setResult(null);
      setError(err instanceof Error ? err.message : 'Unable to load the advisory review lens.');
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [analysis, enabled, laneId, repoPath, scopeKey]);

  useEffect(() => {
    void refresh();
    return () => { requestVersion.current += 1; };
  }, [refresh]);

  return { result, loading, error, refresh };
}
