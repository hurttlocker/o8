'use client';

import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { QuickDocs } from './QuickDocs';

export interface WorkspaceFileTreeProps {
  repoPath?: string | null;
  selectedFile: string | null;
  dirtyFiles: Set<string>;
  onSelectFile: (filePath: string) => void;
}

class TreeBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div role="status" style={{ padding: 12, color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 12 }}>
      Couldn&apos;t load the file explorer. <button type="button" onClick={this.props.onRetry} style={{ border: 0, borderRadius: 5, padding: 5, background: 'var(--t-hover)', color: 'var(--t-text)', font: 'inherit', cursor: 'pointer' }}>Retry</button>
    </div>;
  }
}

/** The explorer engine is loaded only when Files is opened. */
export function AllFilesTree(props: WorkspaceFileTreeProps) {
  const [renderer, setRenderer] = useState(() => ({ Explorer: lazy(() => import('./WorkspaceFileTree')), attempt: 0 }));
  const { Explorer, attempt } = renderer;
  return <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }}>
    <QuickDocs repoPath={props.repoPath} selectedFile={props.selectedFile} onSelectFile={props.onSelectFile} />
    <TreeBoundary key={attempt} onRetry={() => setRenderer(current => ({ Explorer: lazy(() => import('./WorkspaceFileTree')), attempt: current.attempt + 1 }))}>
      <Suspense fallback={<div role="status" style={{ padding: 12, color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 12 }}>Loading files...</div>}>
        <Explorer key={props.repoPath ?? ''} {...props} />
      </Suspense>
    </TreeBoundary>
  </div>;
}
