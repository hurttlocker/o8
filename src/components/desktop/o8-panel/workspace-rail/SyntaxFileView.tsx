'use client';

import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';

function PlainFile({ content, wrap = true }: { content: string; wrap?: boolean }) {
  return <pre data-file-plain-source style={{ margin: 0, padding: 12, font: 'inherit', whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' }}>{content}</pre>;
}

class CodeBoundary extends Component<{ children: ReactNode; content: string; wrap: boolean; revision: object; onRetry: () => void }, { failed: boolean; revision: object | null }> {
  state = { failed: false, revision: null as object | null };
  static getDerivedStateFromProps(props: { revision: object }, state: { revision: object | null }) {
    return props.revision === state.revision ? null : { failed: false, revision: props.revision };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <>
      <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12, fontFamily: 'var(--font-sans-system)', fontSize: 11, color: 'var(--t-text-muted)' }}>Syntax colors are unavailable.
        <button type="button" onClick={this.props.onRetry} style={{ border: '1px solid var(--t-divider-subtle)', borderRadius: 7, padding: 5, background: 'var(--t-hover)', color: 'var(--t-text)', cursor: 'pointer', font: 'inherit' }}>Retry</button>
      </div>
      <PlainFile content={this.props.content} wrap={this.props.wrap} />
    </>;
  }
}

/** Share the PR code palette without loading its syntax engine at boot. */
export function SyntaxFileView({ path, content, wrap = true }: { path: string; content: string; wrap?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [renderer, setRenderer] = useState(() => ({ Code: lazy(() => import('./PierreFileView')) }));
  const revision = useMemo(() => ({ path, content, attempt }), [path, content, attempt]);
  const fallback = <PlainFile content={content} wrap={wrap} />;
  return <div role="region" aria-label={`Source for ${path}`} tabIndex={0} data-file-code-view style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'none', background: 'transparent', color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace', fontSize: 12, lineHeight: '19px', tabSize: 2 }}>
    <CodeBoundary content={content} wrap={wrap} revision={revision} onRetry={() => { setRenderer({ Code: lazy(() => import('./PierreFileView')) }); setAttempt((value) => value + 1); }}>
      <Suspense fallback={fallback}><renderer.Code path={path} content={content} wrap={wrap} fallback={fallback} /></Suspense>
    </CodeBoundary>
  </div>;
}
