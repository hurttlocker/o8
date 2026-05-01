'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  indexEntryForRepo,
  type DirectiveSummary,
  type IndexState,
  type RecentOutcome,
  type SymbolEdgeView,
} from '@/components/desktop/thoughts/recall-card/shared';

interface OutcomesState {
  repoPath: string;
  rows: RecentOutcome[] | null;
  error: string | null;
}

interface SymbolState {
  key: string;
  rows: SymbolEdgeView[] | null;
  unavailable: boolean;
}

export function useRepoFocusRecall(repoPath: string, symbolText: string) {
  const [directives, setDirectives] = useState<DirectiveSummary[] | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomesState>({ repoPath: '', rows: null, error: null });
  const [indexState, setIndexState] = useState<IndexState | null>(null);
  const [symbols, setSymbols] = useState<SymbolState>({ key: '', rows: null, unavailable: false });
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/cortex/directives?repoPath=${encodeURIComponent(repoPath)}`, { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) {
          setDirectives((current) => current ?? []);
          return;
        }
        const payload = await response.json() as { directives?: DirectiveSummary[] };
        setDirectives(payload.directives ?? []);
      } catch {
        if (!cancelled) setDirectives((current) => current ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath, refreshTick]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setRefreshTick((tick) => tick + 1);
      }, 250);
    };
    window.addEventListener('o8:cortex-changes', handler);
    return () => {
      window.removeEventListener('o8:cortex-changes', handler);
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/cortex/recent-outcomes?repoPath=${encodeURIComponent(repoPath)}&limit=5`, { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) {
          setOutcomes({ repoPath, rows: [], error: `HTTP ${response.status}` });
          return;
        }
        const payload = await response.json() as { outcomes?: RecentOutcome[] };
        setOutcomes({ repoPath, rows: payload.outcomes ?? [], error: null });
      } catch (error) {
        if (!cancelled) {
          setOutcomes({ repoPath, rows: [], error: error instanceof Error ? error.message : 'load failed' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath, refreshTick]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/cortex/codebase-memory', { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) {
          setIndexState((current) => current ?? { bootRan: false, inFlight: false, entries: [] });
          return;
        }
        const payload = await response.json() as IndexState;
        setIndexState(payload);
      } catch {
        if (!cancelled) setIndexState((current) => current ?? { bootRan: false, inFlight: false, entries: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const repoEntry = indexEntryForRepo(indexState, repoPath);
  const repoReady = repoEntry?.status === 'ready' || repoEntry?.status === 'cached';
  const symbolKey = repoReady && repoPath && symbolText.trim() ? `${repoPath}::${symbolText}` : '';

  useEffect(() => {
    if (!symbolKey) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch('/api/cortex/symbol-graph', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ repoPath, text: symbolText, limit: 10 }),
          });
          if (cancelled) return;
          if (!response.ok) {
            setSymbols({ key: symbolKey, rows: [], unavailable: false });
            return;
          }
          const payload = await response.json() as { edges?: SymbolEdgeView[]; unavailable?: boolean };
          const rows = (payload.edges ?? []).filter((edge) => edge.neighbours.length > 0 || edge.file);
          setSymbols({ key: symbolKey, rows, unavailable: Boolean(payload.unavailable) });
        } catch {
          if (!cancelled) setSymbols({ key: symbolKey, rows: [], unavailable: false });
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repoPath, symbolKey, symbolText]);

  const symbolHint = useMemo(() => {
    if (!repoPath) return 'no repo set';
    if (!indexState) return null;
    if (!repoEntry) return 'repo not indexed';
    if (repoEntry.status === 'indexing' || repoEntry.status === 'pending') return 'indexing';
    if (repoEntry.status === 'deferred') return 'deferred';
    if (repoEntry.status === 'skipped') return 'skipped';
    if (repoEntry.status === 'error') return 'index error';
    if (symbols.key === symbolKey && symbols.unavailable) return 'symbol graph unavailable';
    return null;
  }, [indexState, repoEntry, repoPath, symbolKey, symbols.key, symbols.unavailable]);

  return {
    directives,
    outcomes: outcomes.repoPath === repoPath ? outcomes.rows : null,
    outcomesError: outcomes.repoPath === repoPath ? outcomes.error : null,
    symbols: symbols.key === symbolKey && symbolKey ? symbols.rows : null,
    symbolHint,
  };
}
