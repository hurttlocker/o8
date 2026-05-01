'use client';
/* eslint-disable react-hooks/set-state-in-effect -- repo changes intentionally reload editor state from o8.md */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownRender } from './markdown-render';

type SpecView = 'split' | 'edit' | 'preview';

interface O8SpecPaneProps {
  repoPath?: string | null;
}

const SAVE_DEBOUNCE_MS = 800;
const UI_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

function savedLabel(savedAt: number | null, now: number) {
  if (!savedAt) return 'Loaded';
  const seconds = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (seconds < 60) return `Saved ${seconds}s ago`;
  return `Saved ${Math.floor(seconds / 60)}m ago`;
}

function ViewButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? 'var(--t-brand-orange)' : 'var(--t-divider-subtle)'}`,
        borderRadius: 10,
        background: active ? 'var(--t-input-bg)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: UI_FONT,
        fontSize: 11,
        fontWeight: 600,
        minHeight: 28,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}

export function O8SpecPane({ repoPath }: O8SpecPaneProps) {
  const [content, setContent] = useState('');
  const [view, setView] = useState<SpecView>('split');
  const [loading, setLoading] = useState(true);
  const [savePending, setSavePending] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!repoPath) {
      setContent('');
      setLoading(false);
      setSavePending(false);
      setError('Select a repo to edit o8.md.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    fetch(`/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok && typeof data.content === 'string') setContent(data.content);
        else setError(data?.error || 'Failed to load o8.md');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [repoPath]);

  const persist = useCallback((next: string) => {
    if (!repoPath) return;
    setSavePending(true);
    setError(null);
    fetch(`/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: next }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok) setSavedAt(Date.now());
        else setError(data?.error || 'Save failed');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSavePending(false);
      });
  }, [repoPath]);

  const handleChange = useCallback((next: string) => {
    setContent(next);
    setSavePending(true);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      persist(next);
    }, SAVE_DEBOUNCE_MS) as unknown as number;
  }, [persist]);

  useEffect(() => () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
  }, []);

  const status = loading
    ? 'Loading o8.md'
    : error
      ? error
      : savePending
        ? 'Saving...'
        : savedLabel(savedAt, now);

  const showEditor = view === 'split' || view === 'edit';
  const showPreview = view === 'split' || view === 'preview';

  return (
    <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, background: 'var(--t-canvas-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 42, paddingLeft: 12, paddingRight: 12, borderBottom: '1px solid var(--t-divider-subtle)', fontFamily: UI_FONT }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: error ? 'var(--t-brand-red)' : 'var(--t-text-muted)', fontSize: 11, fontWeight: 600 }}>
          [SPEC] · agents read & write this · {status}
        </span>
        <ViewButton active={view === 'split'} label="Side-by-side" onClick={() => setView('split')} />
        <ViewButton active={view === 'edit'} label="Edit" onClick={() => setView('edit')} />
        <ViewButton active={view === 'preview'} label="Preview" onClick={() => setView('preview')} />
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {showEditor ? (
          <div style={{ flex: view === 'split' ? '0 0 50%' : 1, minWidth: 0, display: 'flex', borderRight: view === 'split' ? '1px solid var(--t-divider-subtle)' : 'none' }}>
            {loading ? (
              <div style={{ paddingTop: 16, paddingLeft: 16, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>Loading o8.md...</div>
            ) : (
              <textarea
                value={content}
                onChange={(e) => handleChange(e.target.value)}
                spellCheck={false}
                placeholder="# o8 Spec"
                style={{
                  flex: 1,
                  minHeight: 0,
                  resize: 'none',
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                  lineHeight: 1.58,
                  paddingTop: 14,
                  paddingRight: 16,
                  paddingBottom: 18,
                  paddingLeft: 16,
                  tabSize: 2,
                }}
              />
            )}
          </div>
        ) : null}
        {showPreview ? (
          <div style={{ flex: view === 'split' ? '0 0 50%' : 1, minWidth: 0, overflowY: 'auto', paddingTop: 14, paddingRight: 18, paddingBottom: 18, paddingLeft: 18 }}>
            {content.trim() ? <MarkdownRender content={content} /> : <div style={{ color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>No o8.md content yet.</div>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
