'use client';

/**
 * #742 — Context Recall Card.
 *
 * 3-row hero rendered inside the expanded packet card in
 * `ThoughtsMissionPanel`, sandwiched between metadata rows and the
 * Actions / Dispatch row. Surfaces what the codebase-memory engine and
 * directive store would inject into the packet so the operator can verify
 * intent before launch.
 *
 * Rows (uppercase label / value / chevron, click to expand):
 *   1. DIRECTIVE        — top-priority directive matching this repo
 *   2. RECENT OUTCOMES  — last 3 entries from `session_outcomes`
 *   3. SYMBOL GRAPH     — `trace_path` neighbours for symbols mined from
 *                         the packet title/summary/issue body
 *
 * Data sources — all read-only:
 *   - GET  /api/cortex/directives                  (#736)
 *   - GET  /api/cortex/codebase-memory             (#741, gates the symbol row)
 *   - GET  /api/cortex/recent-outcomes?repoPath=…  (this PR)
 *   - POST /api/cortex/symbol-graph                (this PR)
 *
 * Failure policy — every fetch swallows errors and renders a quiet
 * fallback. The card never blocks dispatch, never surfaces a toast, and
 * gracefully hides the SYMBOL GRAPH row when the codebase-memory boot
 * indexer hasn't finished or has no record for the repo.
 *
 * Sub-components live in ./recall-card/ to keep this file under the 800-
 * line ceiling and make each row's chrome easy to find.
 */

import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  indexEntryForRepo,
  pickTopDirective,
  type DirectiveSummary,
  type IndexState,
  type RecentOutcome,
  type SymbolEdgeView,
} from './recall-card/shared';
import { DirectiveRow } from './recall-card/DirectiveRow';
import { OutcomesRow } from './recall-card/OutcomesRow';
import { SymbolGraphFallbackRow, SymbolGraphRow } from './recall-card/SymbolGraphRow';

type OpenRow = 'directive' | 'outcomes' | 'symbols' | null;

interface OutcomesCacheEntry {
  repoPath: string;
  rows: RecentOutcome[] | null;
  error: string | null;
}

interface EdgesCacheEntry {
  key: string;
  rows: SymbolEdgeView[] | null;
  unavailable: boolean;
}

interface ContextRecallCardProps {
  packet: OrchestratorPacket;
  /** Display name of the repo (used to pick repo-scoped directives). */
  repoName: string | null;
}

export function ContextRecallCard({ packet, repoName }: ContextRecallCardProps) {
  const [openRow, setOpenRow] = useState<OpenRow>(null);

  const [directives, setDirectives] = useState<DirectiveSummary[] | null>(null);
  const [outcomesByRepo, setOutcomesByRepo] = useState<OutcomesCacheEntry>({
    repoPath: '',
    rows: null,
    error: null,
  });
  const [indexState, setIndexState] = useState<IndexState | null>(null);
  const [edgesByKey, setEdgesByKey] = useState<EdgesCacheEntry>({
    key: '',
    rows: null,
    unavailable: false,
  });

  const repoPath = packet.workspaceTargetPath;

  const symbolText = useMemo(() => {
    const parts: string[] = [];
    if (packet.title) parts.push(packet.title);
    if (packet.summary) parts.push(packet.summary);
    if (packet.issue?.body) parts.push(packet.issue.body);
    return parts.join('\n\n');
  }, [packet.title, packet.summary, packet.issue]);

  // ── Directives — load once, share across packets ────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/cortex/directives', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as { directives?: DirectiveSummary[] };
        if (cancelled) return;
        setDirectives(payload.directives ?? []);
      } catch {
        if (!cancelled) setDirectives([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Recent outcomes — keyed on repoPath ─────────────────────────────
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/cortex/recent-outcomes?repoPath=${encodeURIComponent(repoPath)}&limit=3`;
        const response = await fetch(url, { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) {
          setOutcomesByRepo({ repoPath, rows: [], error: `HTTP ${response.status}` });
          return;
        }
        const payload = (await response.json()) as { ok?: boolean; outcomes?: RecentOutcome[] };
        setOutcomesByRepo({ repoPath, rows: payload.outcomes ?? [], error: null });
      } catch (error) {
        if (cancelled) return;
        setOutcomesByRepo({
          repoPath,
          rows: [],
          error: error instanceof Error ? error.message : 'load failed',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  // ── Index state — gates the SYMBOL GRAPH row ────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/cortex/codebase-memory', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as IndexState;
        if (!cancelled) setIndexState(payload);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Symbol graph — trace_path for top 3 symbols. Debounced 200 ms ──
  // We compute a "live" symbol key synchronously so the effect only fires
  // when we actually have prerequisites. Render-side reads then validate
  // that edgesByKey.key still matches the live key — this avoids
  // setEdges([]) calls in effects that the React Compiler flags.
  const repoEntryReady = (() => {
    const e = indexEntryForRepo(indexState, repoPath);
    if (!e) return false;
    return e.status === 'ready' || e.status === 'cached';
  })();
  const symbolKey = repoEntryReady && repoPath && symbolText.trim() ? `${repoPath}::${symbolText}` : '';

  useEffect(() => {
    if (!symbolKey) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch('/api/cortex/symbol-graph', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ repoPath, text: symbolText, limit: 3 }),
          });
          if (cancelled) return;
          if (!response.ok) {
            setEdgesByKey({ key: symbolKey, rows: [], unavailable: false });
            return;
          }
          const payload = (await response.json()) as {
            ok?: boolean;
            edges?: SymbolEdgeView[];
            unavailable?: boolean;
          };
          if (cancelled) return;
          // Filter out edges with no neighbours AND no file — they add noise.
          const cleaned = (payload.edges ?? []).filter(
            (e) => e.neighbours.length > 0 || e.file,
          );
          setEdgesByKey({ key: symbolKey, rows: cleaned, unavailable: Boolean(payload.unavailable) });
        } catch {
          if (!cancelled) setEdgesByKey({ key: symbolKey, rows: [], unavailable: false });
        }
      })();
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [symbolKey, repoPath, symbolText]);

  // ── Derived ─────────────────────────────────────────────────────────
  const topDirective = useMemo(
    () => pickTopDirective(directives ?? [], repoName),
    [directives, repoName],
  );
  const otherDirectiveCount = (directives?.length ?? 0) - (topDirective ? 1 : 0);

  // Outcomes are stored alongside the repoPath they were fetched for so a
  // mid-flight repo switch shows "loading" rather than stale data.
  const outcomesForCurrentRepo =
    repoPath && outcomesByRepo.repoPath === repoPath ? outcomesByRepo.rows : null;
  const outcomesError =
    repoPath && outcomesByRepo.repoPath === repoPath ? outcomesByRepo.error : null;

  // Same idea for the symbol-graph rows: only trust them if they were
  // fetched against the live (repoPath, symbolText) tuple.
  const liveEdges = edgesByKey.key === symbolKey && symbolKey ? edgesByKey.rows : null;
  const liveEdgesUnavailable =
    edgesByKey.key === symbolKey && symbolKey && edgesByKey.unavailable;

  const repoEntry = indexEntryForRepo(indexState, repoPath);
  const showSymbolRow = repoEntryReady && !liveEdgesUnavailable;
  const symbolStatusHint = (() => {
    if (!repoPath) return 'no repo set';
    if (!repoEntry) return 'repo not indexed';
    if (repoEntry.status === 'indexing' || repoEntry.status === 'pending') return 'indexing…';
    if (repoEntry.status === 'deferred') return 'deferred (large repo)';
    if (repoEntry.status === 'skipped') return 'skipped';
    if (repoEntry.status === 'error') return 'index error';
    return null;
  })();

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        background: 'var(--t-panel)',
      }}
    >
      <DirectiveRow
        open={openRow === 'directive'}
        onToggle={() => setOpenRow(openRow === 'directive' ? null : 'directive')}
        loading={directives === null}
        topDirective={topDirective}
        otherCount={otherDirectiveCount > 0 ? otherDirectiveCount : 0}
        allDirectives={directives ?? []}
      />
      <OutcomesRow
        open={openRow === 'outcomes'}
        onToggle={() => setOpenRow(openRow === 'outcomes' ? null : 'outcomes')}
        loading={outcomesForCurrentRepo === null && !outcomesError}
        error={outcomesError}
        outcomes={outcomesForCurrentRepo ?? []}
      />
      {showSymbolRow ? (
        <SymbolGraphRow
          open={openRow === 'symbols'}
          onToggle={() => setOpenRow(openRow === 'symbols' ? null : 'symbols')}
          loading={liveEdges === null}
          edges={liveEdges ?? []}
        />
      ) : (
        <SymbolGraphFallbackRow
          repoEntry={repoEntry}
          repoPath={repoPath}
          hint={symbolStatusHint}
          onIndexStateChange={setIndexState}
        />
      )}
    </div>
  );
}
