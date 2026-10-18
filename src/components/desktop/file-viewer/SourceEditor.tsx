'use client';
import dynamic from 'next/dynamic';
import { Component, useEffect, useState, type ReactNode } from 'react';
import type { EditorProps } from '@monaco-editor/react';
import { loadBundledMonacoEditor } from './bundled-monaco';

function createMonacoEditor() {
  return dynamic(loadBundledMonacoEditor, { ssr: false, loading: () => null });
}

class SourceBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function SourceFallback({ value, label, pending, retry }: { value: string; label: string; pending: boolean; retry: () => void }) {
  return <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--t-bg)', color: 'var(--t-text)' }}>
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)', fontSize: 11, color: 'var(--t-text-muted)' }}>
      <span style={{ flex: 1 }}>{pending ? 'Starting editor. Source is available below.' : 'Editor unavailable. Showing read-only source.'}</span>
      {!pending ? <button type="button" onClick={retry} style={{ paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, border: '1px solid var(--t-border)', borderRadius: 6, background: 'var(--t-hover)', color: 'var(--t-text)', font: 'inherit', cursor: 'pointer' }}>Retry editor</button> : null}
    </div>
    <textarea aria-label="Source fallback" title={label} readOnly value={value} spellCheck={false} style={{ flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', resize: 'none', border: 0, padding: 12, background: 'transparent', color: 'var(--t-text)', fontFamily: '"SF Mono", Menlo, Monaco, ui-monospace, monospace', fontSize: 13, lineHeight: '20px', whiteSpace: 'pre', overflow: 'auto' }} />
  </div>;
}

export function SourceEditor({ sourceLabel, ...props }: EditorProps & { sourceLabel: string }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [MonacoEditor, setMonacoEditor] = useState(createMonacoEditor);
  useEffect(() => {
    if (phase !== 'loading') return;
    const timer = setTimeout(() => setPhase('unavailable'), 8000);
    return () => clearTimeout(timer);
  }, [phase, attempt]);
  const retry = () => {
    // A rejected React.lazy import is cached by its component type. A fresh
    // loader is necessary for Retry to make a new initialization attempt.
    setMonacoEditor(() => createMonacoEditor());
    setPhase('loading');
    setAttempt(value => value + 1);
  };
  const fallback = (pending: boolean) => <SourceFallback value={props.value ?? ''} label={sourceLabel} pending={pending} retry={retry} />;
  return <div style={{ position: 'relative', height: '100%', minHeight: 0 }}>
    <SourceBoundary key={attempt} fallback={fallback(false)}>
      {phase !== 'ready' ? fallback(phase === 'loading') : null}
      {phase !== 'unavailable' ? <div style={{ height: '100%', visibility: phase === 'ready' ? 'inherit' : 'hidden' }}>
        <MonacoEditor {...props} loading={null} onMount={(editor, monaco) => { setPhase('ready'); props.onMount?.(editor, monaco); }} />
      </div> : null}
    </SourceBoundary>
  </div>;
}
