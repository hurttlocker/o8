'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepoFocusRepo } from '../types';

interface SpecTabProps {
  repo: RepoFocusRepo;
  onOpenInWorkspace?: (repoPath: string) => void;
}

const SAVE_DEBOUNCE_MS = 800;

export function SpecTab({ repo, onOpenInWorkspace }: SpecTabProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savePending, setSavePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);
  const repoPath = repo.localPath;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`;
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok && typeof data.content === 'string') {
          setContent(data.content);
        } else {
          setError(data?.error || 'Failed to load o8.md');
        }
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
    setSavePending(true);
    setError(null);
    fetch(`/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: next }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok) {
          setSavedAt(Date.now());
        } else {
          setError(data?.error || 'Save failed');
        }
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
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      persist(next);
    }, SAVE_DEBOUNCE_MS) as unknown as number;
  }, [persist]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const status = (() => {
    if (savePending) return 'Saving…';
    if (error) return error;
    if (savedAt) {
      const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
      if (seconds < 5) return 'Saved';
      if (seconds < 60) return `Saved ${seconds}s ago`;
      return `Saved ${Math.floor(seconds / 60)}m ago`;
    }
    return 'o8.md · agents read & write this';
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--t-divider)',
          fontSize: 11,
          color: 'var(--t-text-muted)',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          letterSpacing: '-0.005em',
        }}
      >
        <span style={{ color: error ? '#dc2626' : 'var(--t-text-muted)' }}>{status}</span>
        {onOpenInWorkspace ? (
          <button
            type="button"
            onClick={() => onOpenInWorkspace(repoPath)}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'pointer',
              padding: '2px 6px',
              borderRadius: 6,
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; e.currentTarget.style.background = 'var(--t-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; e.currentTarget.style.background = 'transparent'; }}
          >
            Open in workspace
          </button>
        ) : null}
      </div>
      {loading ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading o8.md…</div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--t-text)',
            padding: '12px 14px',
            fontSize: 12,
            lineHeight: 1.55,
            fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace',
            resize: 'none',
            tabSize: 2,
          }}
          placeholder="# o8 Spec — write the mission, scope, constraints, and open questions for this repo."
        />
      )}
    </div>
  );
}
