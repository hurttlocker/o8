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

export function useMergePreview(packetId: string | null, enabled: boolean): MergePreviewState {
  const [state, setState] = useState<MergePreviewState>(IDLE);

  useEffect(() => {
    if (!enabled || !packetId) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState({ loading: true, wouldMerge: null, blockers: [], error: null });
    fetch(`/api/orchestrator/merge-preview?packetId=${encodeURIComponent(packetId)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          wouldMerge?: boolean;
          blockers?: unknown;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || data.error) {
          setState({ loading: false, wouldMerge: null, blockers: [], error: data.error || `Preview failed (${res.status})` });
          return;
        }
        setState({
          loading: false,
          wouldMerge: data.wouldMerge === true,
          blockers: Array.isArray(data.blockers) ? data.blockers.map((b) => String(b)) : [],
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, wouldMerge: null, blockers: [], error: err instanceof Error ? err.message : 'preview failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [packetId, enabled]);

  return state;
}
