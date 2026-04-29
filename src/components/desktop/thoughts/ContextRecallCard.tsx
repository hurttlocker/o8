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
import type { ProjectPulse } from '@/lib/projects/pulse';
import {
  indexEntryForRepo,
  pickTopDirective,
  type DirectiveSummary,
  type IndexState,
  type RecentOutcome,
  type SymbolEdgeView,
} from './recall-card/shared';
import { AskAnythingRow } from './recall-card/AskAnythingRow';
import { DirectiveRow } from './recall-card/DirectiveRow';
import { OutcomesRow } from './recall-card/OutcomesRow';
import { ProjectPulseRow } from './recall-card/ProjectPulseRow';
import { SymbolGraphFallbackRow, SymbolGraphRow } from './recall-card/SymbolGraphRow';

type OpenRow = 'directive' | 'outcomes' | 'symbols' | 'pulse' | 'ask' | null;

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

interface PulseCacheEntry {
  repoPath: string;
  pulses: ProjectPulse[] | null;
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
  // #899 wave 2 — peer-repo activity, keyed on repoPath so a mid-flight
  // packet switch shows "loading" rather than stale data.
  const [pulseByRepo, setPulseByRepo] = useState<PulseCacheEntry>({
    repoPath: '',
    pulses: null,
  });

  // #840 — Bumped when a Cortex memory write (e.g. directive trailer append
  // after a merge) fires the `o8:cortex-changes` window event. The directive
  // fetch effect uses this as a dependency so the card re-fetches in place
  // without a manual collapse/reopen.
  const [directiveRefreshTick, setDirectiveRefreshTick] = useState(0);
  // #899 — Same WS bridge also bumps this so the project-pulse row refreshes
  // on directive changes (a new directive may shift which projects matter).
  const [pulseRefreshTick, setPulseRefreshTick] = useState(0);

  const repoPath = packet.workspaceTargetPath;

  const symbolText = useMemo(() => {
    const parts: string[] = [];
    if (packet.title) parts.push(packet.title);
    if (packet.summary) parts.push(packet.summary);
    if (packet.issue?.body) parts.push(packet.issue.body);
    return parts.join('\n\n');
  }, [packet.title, packet.summary, packet.issue]);

  // ── Directives — load once, share across packets ────────────────────
  // Re-runs whenever `directiveRefreshTick` is bumped by the
  // `o8:cortex-changes` listener below, so a merge that appends a `[merged]`
  // trailer is reflected in the open card within ~ws-roundtrip latency.
  //
  // #897 — Always settle to a concrete state. Previously a non-OK response
  // returned silently, leaving `directives === null` and pinning the row at
  // "Loading…" forever. We now treat any non-OK response as "no data
  // available right now" and render the empty/last-known state instead of
  // hanging.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/cortex/directives', { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) {
          setDirectives((prev) => prev ?? []);
          return;
        }
        const payload = (await response.json()) as { directives?: DirectiveSummary[] };
        if (cancelled) return;
        setDirectives(payload.directives ?? []);
      } catch {
        if (!cancelled) setDirectives((prev) => prev ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [directiveRefreshTick]);

  // #840 — Listen for cortex-changes pushed from the server after a merge
  // appends a directive trailer. Bridge already converts the WS message
  // into an `o8:cortex-changes` window event in DesktopWebSocketContext.
  //
  // #897 — Coalesce bursts. If the WS bridge fans out spuriously (or the
  // external-merge-watcher writes multiple trailers in one tick) we don't
  // want to restart the fetch faster than it can resolve. Debounce the
  // refresh-tick bump to a single trailing edge per 250 ms window.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        data?: { scope?: string };
      } | undefined;
      const scope = detail?.data?.scope;
      // Only directive scope triggers a directive re-fetch — outcomes and
      // codebase-memory will hook in here later if/when they need it.
      if (scope !== 'directive' && scope) return;
      pending = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          pending = false;
          setDirectiveRefreshTick((tick) => tick + 1);
          // #899 wave 2 — directive change may shift project membership /
          // priorities, so refresh the pulse on the same debounced edge.
          setPulseRefreshTick((tick) => tick + 1);
        }
      }, 250);
    };
    window.addEventListener('o8:cortex-changes', handler);
    return () => {
      window.removeEventListener('o8:cortex-changes', handler);
      if (timer) clearTimeout(timer);
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

  // ── Project pulse — keyed on repoPath, refreshes on cortex-changes ──
  // #899 wave 2. Failure modes — non-OK, throw, or repo not in any project —
  // all settle to an empty list so the row can hide gracefully.
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/cortex/project-pulse?repoPath=${encodeURIComponent(repoPath)}`;
        const response = await fetch(url, { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) {
          setPulseByRepo({ repoPath, pulses: [] });
          return;
        }
        const payload = (await response.json()) as { ok?: boolean; pulses?: ProjectPulse[] };
        if (cancelled) return;
        setPulseByRepo({ repoPath, pulses: payload.pulses ?? [] });
      } catch {
        if (!cancelled) setPulseByRepo({ repoPath, pulses: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath, pulseRefreshTick]);

  // ── Index state — gates the SYMBOL GRAPH row ────────────────────────
  // #897 — On a non-OK response (or thrown error) we used to silently
  // return, leaving `indexState === null`. We now settle to an empty
  // sentinel so the symbol-graph row renders the fallback "repo not indexed"
  // hint instead of cascading the directives row's "Loading…" failure.
  // (Last-known good state is preserved by the `prev ??` guard.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/cortex/codebase-memory', { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) {
          setIndexState((prev) => prev ?? { bootRan: false, inFlight: false, entries: [] });
          return;
        }
        const payload = (await response.json()) as IndexState;
        if (!cancelled) setIndexState(payload);
      } catch {
        if (!cancelled) setIndexState((prev) => prev ?? { bootRan: false, inFlight: false, entries: [] });
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

  // #899 wave 2 — same repoPath fence as outcomes; mid-flight repo switches
  // show loading instead of stale peer activity.
  const livePulses =
    repoPath && pulseByRepo.repoPath === repoPath ? pulseByRepo.pulses : null;
  const showPulseRow = (livePulses?.length ?? 0) > 0;

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
      {showPulseRow ? (
        <ProjectPulseRow
          open={openRow === 'pulse'}
          onToggle={() => setOpenRow(openRow === 'pulse' ? null : 'pulse')}
          loading={livePulses === null}
          pulses={livePulses ?? []}
        />
      ) : null}
      {/* #915 sub-4 — Ask Anything chat input + streaming citations.
          Sits after PROJECT PULSE and before SPEC (Wave B). Always renders. */}
      <AskAnythingRow
        open={openRow === 'ask'}
        onToggle={() => setOpenRow(openRow === 'ask' ? null : 'ask')}
        repoPath={repoPath}
      />
    </div>
  );
}
