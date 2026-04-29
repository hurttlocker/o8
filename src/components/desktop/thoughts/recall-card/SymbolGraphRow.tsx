'use client';

/**
 * #742 — SYMBOL GRAPH row of the Context Recall Card.
 *
 * Collapsed: shows the first symbol traced + an "+N more" tail.
 * Expanded: per-symbol entry with file:line + neighbour chips, or a quiet
 * fallback line when the graph yielded nothing.
 *
 * The fallback variant of this row (when the codebase-memory boot indexer
 * isn't ready) lives in SymbolGraphFallbackRow.tsx.
 */

import { useState } from 'react';
import {
  Chevron,
  expandedSurfaceStyle,
  FONT_FAMILY,
  MONO_FAMILY,
  rowChromeStyle,
  rowLabelStyle,
  rowValueStyle,
  type IndexEntry,
  type IndexState,
  type SymbolEdgeView,
} from './shared';

interface SymbolGraphRowProps {
  open: boolean;
  onToggle: () => void;
  loading: boolean;
  edges: SymbolEdgeView[];
}

export function SymbolGraphRow({ open, onToggle, loading, edges }: SymbolGraphRowProps) {
  const summary = (() => {
    if (loading) return 'Tracing call paths…';
    if (edges.length === 0) return 'No symbols matched the index';
    const first = edges[0];
    const extra = edges.length - 1;
    return extra > 0 ? `${first.symbol} + ${extra} more` : first.symbol;
  })();

  return (
    <div data-packet-row>
      <button
        type="button"
        onClick={onToggle}
        style={{
          ...rowChromeStyle,
          background: open ? 'var(--t-divider-subtle)' : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = 'var(--t-divider-subtle)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={rowLabelStyle}>symbols</span>
        <span
          style={{
            ...rowValueStyle,
            color: edges.length > 0 ? 'var(--t-text)' : 'var(--t-text-muted)',
            fontFamily: edges.length > 0 ? MONO_FAMILY : FONT_FAMILY,
            fontSize: edges.length > 0 ? 11 : 11.5,
          }}
        >
          {summary}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div style={{ ...expandedSurfaceStyle, paddingTop: 6 }}>
          {edges.length === 0 ? (
            <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
              No call-path data for the symbols extracted from this packet.
            </div>
          ) : (
            edges.map((edge) => (
              <div
                key={edge.symbol}
                style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: FONT_FAMILY }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: MONO_FAMILY,
                      fontSize: 11,
                      color: 'var(--t-text)',
                      fontWeight: 600,
                    }}
                  >
                    {edge.symbol}
                  </span>
                  {edge.file ? (
                    <span
                      style={{
                        fontSize: 9.5,
                        color: 'var(--t-text-faint)',
                        fontFamily: MONO_FAMILY,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {edge.file}
                      {edge.line ? `:${edge.line}` : ''}
                    </span>
                  ) : null}
                </div>
                {edge.neighbours.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {edge.neighbours.slice(0, 6).map((n) => (
                      <span
                        key={`${edge.symbol}-${n}`}
                        style={{
                          fontFamily: MONO_FAMILY,
                          fontSize: 10,
                          color: 'var(--t-text-muted)',
                          paddingTop: 2,
                          paddingRight: 6,
                          paddingBottom: 2,
                          paddingLeft: 6,
                          borderRadius: 6,
                          background: 'rgba(148, 163, 184, 0.10)',
                          borderWidth: 1,
                          borderStyle: 'solid',
                          borderColor: 'rgba(148, 163, 184, 0.20)',
                        }}
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                ) : edge.error ? (
                  <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>{edge.error}</div>
                ) : (
                  <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
                    No neighbours recorded.
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

interface SymbolGraphFallbackRowProps {
  repoEntry: IndexEntry | null;
  repoPath: string | null;
  hint: string | null;
  onIndexStateChange: (state: IndexState) => void;
}

export function SymbolGraphFallbackRow({
  repoEntry,
  repoPath,
  hint,
  onIndexStateChange,
}: SymbolGraphFallbackRowProps) {
  const [reindexing, setReindexing] = useState(false);

  const canReindex = Boolean(
    repoPath &&
      repoEntry &&
      (repoEntry.status === 'error' ||
        repoEntry.status === 'deferred' ||
        repoEntry.status === 'skipped'),
  );

  const triggerReindex = async () => {
    if (!canReindex || reindexing) return;
    setReindexing(true);
    try {
      // Re-poll the codebase-memory route — it triggers
      // ensureCodebaseMemoryBootIndex() which is idempotent and will retry
      // the boot pass if it errored. There's no dedicated "reindex one repo"
      // endpoint yet (#742 ships render-only) so we kick the boot pass.
      const response = await fetch('/api/cortex/codebase-memory', { cache: 'no-store' });
      if (response.ok) {
        const next = (await response.json()) as IndexState;
        onIndexStateChange(next);
      }
    } catch {
      /* ignore */
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div data-packet-row>
      <div style={{ ...rowChromeStyle, cursor: 'default' }}>
        <span style={rowLabelStyle}>symbols</span>
        <span
          style={{
            ...rowValueStyle,
            color: 'var(--t-text-muted)',
            fontStyle: 'italic',
          }}
        >
          {hint ?? 'unavailable'}
        </span>
        {canReindex ? (
          <button
            type="button"
            onClick={triggerReindex}
            disabled={reindexing}
            style={{
              flexShrink: 0,
              borderWidth: 0,
              background: 'transparent',
              color: '#2563eb',
              paddingTop: 3,
              paddingRight: 8,
              paddingBottom: 3,
              paddingLeft: 8,
              borderRadius: 6,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              cursor: reindexing ? 'wait' : 'pointer',
              fontFamily: FONT_FAMILY,
            }}
            onMouseEnter={(e) => {
              if (!reindexing) e.currentTarget.style.background = 'rgba(37, 99, 235, 0.08)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {reindexing ? 'Re-indexing…' : 'Re-index'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
