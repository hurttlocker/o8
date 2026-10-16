'use client';

import { Component, lazy, memo, Suspense, useMemo, useState, type ReactNode } from 'react';
import type { PrFile } from './types';

class DiffBoundary extends Component<{ children: ReactNode; file: PrFile; revision: object; onRetry: () => void }, { failed: boolean; revision: object | null }> {
  state = { failed: false, revision: null as object | null };
  static getDerivedStateFromProps(props: { revision: object }, state: { revision: object | null }) {
    return props.revision === state.revision ? null : { failed: false, revision: props.revision };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div>
      <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 14, fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t-text-muted)' }}>The code view could not load. The supplied patch is shown below.<button type="button" onClick={this.props.onRetry} style={{ marginLeft: 'auto', flexShrink: 0, padding: 6, borderRadius: 6, border: '1px solid var(--t-border)', background: 'var(--t-hover)', color: 'var(--t-text)', cursor: 'pointer' }}>Retry</button></div>
      <pre style={{ margin: 0, padding: 14, font: 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{this.props.file.patch}</pre>
    </div>;
  }
}

export const PrDiffPatch = memo(function PrDiffPatch({ file, diffStyle = 'unified' }: { file: PrFile; diffStyle?: 'unified' | 'split' }) {
  const [attempt, setAttempt] = useState(0);
  // Keep the syntax engine out of the dashboard's initial module graph.
  const [renderer, setRenderer] = useState(() => ({ Diff: lazy(() => import('./PierrePrDiff')) }));
  const revision = useMemo(() => ({ path: file.path, previousPath: file.previousPath, status: file.status, patch: file.patch, attempt }), [file.path, file.previousPath, file.status, file.patch, attempt]);
  const retry = () => { setRenderer({ Diff: lazy(() => import('./PierrePrDiff')) }); setAttempt((current) => current + 1); };
  return <div role="region" aria-label={'Diff for ' + file.path} tabIndex={0} data-pr-diff style={{ fontFamily: 'var(--font-ui)', fontSize: 12, lineHeight: 1.65, background: 'var(--t-canvas-bg)', borderTop: '1px solid var(--t-divider-subtle)', overflowX: 'hidden', tabSize: 2 }}>
    <DiffBoundary revision={revision} file={file} onRetry={retry}>
      <Suspense fallback={<div role="status" style={{ padding: 14, fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t-text-muted)' }}>Preparing code view…</div>}><renderer.Diff file={file} diffStyle={diffStyle} /></Suspense>
    </DiffBoundary>
    <div style={{ textAlign: 'center', padding: 8, borderTop: '1px solid var(--t-divider-subtle)', color: 'var(--t-text-muted)', fontFamily: 'var(--font-ui)', fontSize: 10 }}>Only supplied diff context is shown.</div>
  </div>;
});
