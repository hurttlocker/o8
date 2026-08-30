'use client';

import { useEffect, useState } from 'react';

/**
 * useMergePreview — dry-run the merge gate for one comparison candidate so its
 * column can show a GATE VERDICT (passes / blocked-by) before the operator picks.
 * Fetches GET /api/orchestrator/merge-preview only when `enabled` (the candidate is
 * complete); idle otherwise. This is the governance signal a plain diff view lacks.
 */
export interface MergePreviewState {
  loading: boolean;
  /** true = passes the gate, false = blocked, null = not evaluated / errored. */
  wouldMerge: boolean | null;
  /** Names of the failing gate checks when blocked. */
  blockers: string[];
  error: string | null;
}

const IDLE: MergePreviewState = { loading: false, wouldMerge: null, blockers: [], error: null };
const LOADING: MergePreviewState = { loading: true, wouldMerge: null, blockers: [], error: null };

export function useMergePreview(packetId: string | null, enabled: boolean): MergePreviewState {
  const requestKey = enabled && packetId ? packetId : null;
  const [result, setResult] = useState<{ key: string; state: MergePreviewState } | null>(null);
  const state = requestKey === null ? IDLE : result?.key === requestKey ? result.state : LOADING;

  useEffect(() => {
    if (!requestKey) return;
    let cancelled = false;
    fetch(`/api/orchestrator/merge-preview?packetId=${encodeURIComponent(requestKey)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          wouldMerge?: boolean;
          blockers?: unknown;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || data.error) {
          setResult({ key: requestKey, state: { loading: false, wouldMerge: null, blockers: [], error: data.error || `Preview failed (${res.status})` } });
          return;
        }
        setResult({
          key: requestKey,
          state: {
            loading: false,
            wouldMerge: data.wouldMerge === true,
            blockers: Array.isArray(data.blockers) ? data.blockers.map((b) => String(b)) : [],
            error: null,
          },
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setResult({ key: requestKey, state: { loading: false, wouldMerge: null, blockers: [], error: err instanceof Error ? err.message : 'preview failed' } });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  return state;
}
