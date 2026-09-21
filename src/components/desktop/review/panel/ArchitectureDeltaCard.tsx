'use client';

import { useMemo, useState } from 'react';

import type {
  ArchitectureDeltaEdge,
  ArchitectureDeltaNode,
  ArchitectureDeltaResult,
  ArchitectureEdgeState,
  ArchitectureModuleState,
} from '@/lib/review/architecture-delta-types';
import type { ArchitectureDeltaState } from '../useArchitectureDelta';
import { ChevronDown } from '../../lucide-shims';
import { UI_FONT } from './constants';

const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const COMPACT_LIMIT = 12;

const STATE_COLOR: Record<ArchitectureModuleState | ArchitectureEdgeState, string> = {
  added: 'var(--t-terminal-ansi-bright-green, #22c55e)',
  removed: 'var(--t-brand-red, #ef4444)',
  changed: 'var(--t-accent, #2563eb)',
  context: 'var(--t-text-faint)',
};

function splitPath(filePath: string) {
  const parts = filePath.split('/');
  const name = parts.pop() ?? filePath;
  return { name, directory: parts.join('/') };
}

function StatusCopy({ state }: { state: ArchitectureModuleState }) {
  return (
    <span style={{ color: STATE_COLOR[state], fontSize: 9, fontWeight: 300, letterSpacing: '0.02em', textTransform: 'uppercase' }}>
      {state}
    </span>
  );
}

function ModuleRow({ node, onSelectFile }: { node: ArchitectureDeltaNode; onSelectFile: (path: string) => void }) {
  const { name, directory } = splitPath(node.path);
  const content = (
    <>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATE_COLOR[node.state], flexShrink: 0 }} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)', fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px' }}>
          {name}
        </span>
        <span style={{ display: 'block', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 9, fontWeight: 300, letterSpacing: '-0.2px' }}>
          {directory || '.'}
        </span>
      </span>
      <StatusCopy state={node.state} />
    </>
  );

  const style = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 38,
    width: '100%',
    paddingTop: 5,
    paddingRight: 8,
    paddingBottom: 5,
    paddingLeft: 8,
    border: '1px solid var(--t-divider-subtle)',
    borderRadius: 8,
    background: 'var(--t-input-bg)',
    fontFamily: UI_FONT,
    textAlign: 'left',
  } as const;

  const focusPath = node.focusPath;
  if (!focusPath) return <div title={node.path} style={style}>{content}</div>;
  return (
    <button
      type="button"
      title={`Open ${focusPath} diff`}
      onClick={() => onSelectFile(focusPath)}
      style={{ ...style, cursor: 'pointer' }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--t-input-bg)'; }}
    >
      {content}
    </button>
  );
}

function edgeMarker(state: ArchitectureEdgeState) {
  if (state === 'added') return '+';
  if (state === 'removed') return '−';
  return '·';
}

function EdgeRow({ edge, onSelectFile }: { edge: ArchitectureDeltaEdge; onSelectFile: (path: string) => void }) {
  const from = splitPath(edge.from).name;
  const to = splitPath(edge.to).name;
  const content = (
    <>
      <span style={{ color: STATE_COLOR[edge.state], fontFamily: MONO_FONT, fontSize: 12, textAlign: 'center' }}>{edgeMarker(edge.state)}</span>
      <span title={edge.from} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{from}</span>
      <span aria-hidden="true" style={{ color: 'var(--t-text-faint)' }}>→</span>
      <span title={edge.to} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{to}</span>
      <span style={{ color: STATE_COLOR[edge.state], fontSize: 9, textTransform: 'uppercase' }}>{edge.state}</span>
    </>
  );
  const style = {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) 14px minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: 6,
    width: '100%',
    minHeight: 32,
    paddingTop: 3,
    paddingRight: 8,
    paddingBottom: 3,
    paddingLeft: 6,
    border: 0,
    borderBottom: '1px solid var(--t-divider-subtle)',
    background: 'transparent',
    color: 'var(--t-text-secondary)',
    fontFamily: MONO_FONT,
    fontSize: 10,
    fontWeight: 300,
    textAlign: 'left',
  } as const;

  const focusPath = edge.focusPath;
  if (!focusPath) return <div style={style}>{content}</div>;
  return (
    <button
      type="button"
      title={`Open ${focusPath} diff`}
      onClick={() => onSelectFile(focusPath)}
      style={{ ...style, cursor: 'pointer' }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      {content}
    </button>
  );
}

function Summary({ result }: { result: ArchitectureDeltaResult }) {
  if (result.status !== 'ready') return <span>{result.status}</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: MONO_FONT }}>
      <span>{result.summary.changedModules} modules</span>
      <span style={{ color: STATE_COLOR.added }}>+{result.summary.addedEdges}</span>
      <span style={{ color: STATE_COLOR.removed }}>−{result.summary.removedEdges}</span>
    </span>
  );
}

export function ArchitectureDeltaCard({
  analysis,
  onSelectFile,
}: {
  analysis: ArchitectureDeltaState;
  onSelectFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const visibleNodes = useMemo(() => (
    showAll ? analysis.result?.nodes ?? [] : analysis.result?.nodes.slice(0, COMPACT_LIMIT) ?? []
  ), [analysis.result, showAll]);
  const visibleEdges = useMemo(() => (
    showAll ? analysis.result?.edges ?? [] : analysis.result?.edges.slice(0, COMPACT_LIMIT) ?? []
  ), [analysis.result, showAll]);
  const hiddenCount = analysis.result
    ? Math.max(0, analysis.result.nodes.length - COMPACT_LIMIT)
      + Math.max(0, analysis.result.edges.length - COMPACT_LIMIT)
    : 0;

  return (
    <section style={{ marginTop: 8, marginRight: 10, marginBottom: 8, marginLeft: 10, border: '1px solid var(--t-divider-subtle)', borderRadius: 10, background: 'var(--t-canvas-bg)', overflow: 'hidden', fontFamily: UI_FONT }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 42, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, border: 0, background: 'transparent', color: 'var(--t-text)', cursor: 'pointer', fontFamily: UI_FONT, textAlign: 'left' }}
      >
        <ChevronDown size={13} strokeWidth={1.8} style={{ flexShrink: 0, transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Architecture delta</span>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px' }}>
          {analysis.loading ? 'reading structure' : analysis.error ? 'unavailable' : analysis.result ? <Summary result={analysis.result} /> : 'waiting'}
        </span>
      </button>
      {expanded ? (
        <div style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}>
          {analysis.loading ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>Reading module relationships…</p>
          ) : analysis.error ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-brand-red)', fontSize: 11, fontWeight: 300 }}>{analysis.error}</p>
          ) : !analysis.result ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>Architecture evidence is not available yet.</p>
          ) : analysis.result.status !== 'ready' ? (
            <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>{analysis.result.reason}</p>
          ) : (
            <>
              <div style={{ marginBottom: 7, color: 'var(--t-text-faint)', fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Modules in scope</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 6 }}>
                {visibleNodes.map((node) => <ModuleRow key={node.path} node={node} onSelectFile={onSelectFile} />)}
              </div>
              <div style={{ marginTop: 12, marginBottom: 5, color: 'var(--t-text-faint)', fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Dependency relationships</div>
              {visibleEdges.length ? (
                <div style={{ borderTop: '1px solid var(--t-divider-subtle)' }}>
                  {visibleEdges.map((edge) => <EdgeRow key={`${edge.state}:${edge.from}:${edge.to}`} edge={edge} onSelectFile={onSelectFile} />)}
                </div>
              ) : (
                <p style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>No internal dependency relationships touch these modules.</p>
              )}
              {hiddenCount > 0 ? (
                <button type="button" onClick={() => setShowAll((value) => !value)} style={{ marginTop: 8, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, border: 0, background: 'transparent', color: 'var(--t-accent)', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 10, fontWeight: 300 }}>
                  {showAll ? 'Show compact view' : `Show ${hiddenCount} more`}
                </button>
              ) : null}
              {analysis.result.truncated ? (
                <p style={{ marginTop: 8, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-brand-orange)', fontSize: 10, fontWeight: 300 }}>Bounded view: additional source files or relationships were omitted.</p>
              ) : null}
              {analysis.result.unsupportedPaths.length ? (
                <p style={{ marginTop: 6, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300 }}>{analysis.result.unsupportedPaths.length} changed file(s) use an unsupported format.</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
