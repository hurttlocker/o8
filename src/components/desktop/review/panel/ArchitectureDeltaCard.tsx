'use client';

import { useMemo, useState } from 'react';

import type { ArchitectureDeltaResult } from '@/lib/review/architecture-delta-types';
import type { ArchitectureAttentionState } from '../useArchitectureAttention';
import type { ArchitectureDeltaState } from '../useArchitectureDelta';
import { ChevronDown } from '../../lucide-shims';
import { ArchitectureAttentionStrip } from './ArchitectureAttentionStrip';
import { ArchitectureDeltaGraph } from './ArchitectureDeltaGraph';
import { filterArchitectureResult } from './architecture-delta-graph';
import { UI_FONT } from './constants';

const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const ADDED_COLOR = 'var(--t-terminal-ansi-bright-green, #22c55e)';
const REMOVED_COLOR = 'var(--t-brand-red, #ef4444)';
const EMPTY_ATTENTION: ArchitectureAttentionState = {
  result: null,
  loading: false,
  error: null,
  refresh: async () => undefined,
};

function Summary({ result }: { result: ArchitectureDeltaResult }) {
  if (result.status !== 'ready') return <span>{result.status}</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: MONO_FONT }}>
      <span>{result.summary.changedModules} modules</span>
      <span style={{ color: ADDED_COLOR }}>+{result.summary.addedEdges}</span>
      <span style={{ color: REMOVED_COLOR }}>−{result.summary.removedEdges}</span>
    </span>
  );
}

export function ArchitectureDeltaCard({
  analysis,
  attention = EMPTY_ATTENTION,
  scopePaths,
  onSelectFile,
}: {
  analysis: ArchitectureDeltaState;
  attention?: ArchitectureAttentionState;
  scopePaths: string[];
  onSelectFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const result = useMemo(() => (
    analysis.result ? filterArchitectureResult(analysis.result, scopePaths) : null
  ), [analysis.result, scopePaths]);
  const graphKey = `${result?.generatedAt ?? 'empty'}:${scopePaths.join('\0')}`;

  return (
    <section style={{ marginTop: 8, marginRight: 10, marginBottom: 8, marginLeft: 10, border: '1px solid var(--t-divider-subtle)', borderRadius: 10, background: 'var(--t-canvas-bg)', overflow: 'hidden', fontFamily: UI_FONT }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 44, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, border: 0, background: 'transparent', color: 'var(--t-text)', cursor: 'pointer', fontFamily: UI_FONT, textAlign: 'left' }}
      >
        <ChevronDown size={13} strokeWidth={1.8} style={{ flexShrink: 0, transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontSize: 12.5, fontWeight: 500, letterSpacing: '-0.1px' }}>Architecture delta</span>
          <span style={{ display: 'block', marginTop: 2, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 300 }}>Live module topology for this review scope</span>
        </span>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', whiteSpace: 'nowrap' }}>
          {analysis.loading ? 'reading structure' : analysis.error ? 'unavailable' : result ? <Summary result={result} /> : 'waiting'}
        </span>
      </button>
      {expanded ? (
        <div style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}>
          {analysis.loading ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>Reading module relationships…</p>
          ) : analysis.error ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-brand-red)', fontSize: 11, fontWeight: 300 }}>{analysis.error}</p>
          ) : !result ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>Architecture evidence is not available yet.</p>
          ) : result.status !== 'ready' ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>{result.reason}</p>
          ) : result.nodes.length === 0 ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>No supported module changes are included in the selected Review scope.</p>
          ) : (
            <>
              <ArchitectureAttentionStrip attention={attention} onSelectFile={onSelectFile} />
              <ArchitectureDeltaGraph key={graphKey} result={result} attention={attention.result} onSelectFile={onSelectFile} />
              {result.truncated ? (
                <p style={{ marginTop: 8, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-brand-orange)', fontSize: 10, fontWeight: 300 }}>
                  Bounded view: {result.omittedPaths.length || 'additional'} source module(s) were safely omitted; their outgoing dependency changes are not inferred.
                </p>
              ) : null}
              {result.resolutionWarnings.map((warning) => (
                <p key={warning} style={{ marginTop: 6, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-brand-orange)', fontSize: 10, fontWeight: 300 }}>{warning}</p>
              ))}
              {result.unsupportedPaths.length ? (
                <p style={{ marginTop: 6, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300 }}>{result.unsupportedPaths.length} changed file(s) use an unsupported format.</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
