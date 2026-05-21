'use client';
/* eslint-disable react-hooks/set-state-in-effect -- repo changes intentionally reload editor state from o8.md */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTheme } from '@/lib/theme/context';
import { O8SpecEditor } from './O8SpecEditor';

interface O8SpecPaneProps {
  repoPath?: string | null;
}

const SAVE_DEBOUNCE_MS = 800;
const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

function savedLabel(savedAt: number | null, now: number) {
  if (!savedAt) return 'Loaded';
  const seconds = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (seconds < 60) return `Saved ${seconds}s ago`;
  return `Saved ${Math.floor(seconds / 60)}m ago`;
}

function linesForDiff(value: string) {
  return value.replace(/\r\n/g, '\n').split('\n');
}

function countChangedLines(base: string, next: string) {
  if (base === next) return { additions: 0, deletions: 0 };

  const before = linesForDiff(base);
  const after = linesForDiff(next);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return {
    additions: Math.max(0, afterEnd - start + 1),
    deletions: Math.max(0, beforeEnd - start + 1),
  };
}

export function O8SpecPane({ repoPath }: O8SpecPaneProps) {
  const [content, setContent] = useState('');
  const [loadedContent, setLoadedContent] = useState('');
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
      setLoadedContent('');
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
        if (data?.ok && typeof data.content === 'string') {
          setContent(data.content);
          setLoadedContent(data.content);
        } else {
          setLoadedContent('');
          setError(data?.error || 'Failed to load notes');
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
    ? 'Loading notes'
    : error
      ? error
      : savePending
        ? 'Saving...'
        : savedLabel(savedAt, now);
  const diffStats = useMemo(() => countChangedLines(loadedContent, content), [content, loadedContent]);

  // The wide O8 Panel root carries data-chrome-surface="true". In SOLID
  // surface mode the spec editor renders as CONTENT (paper bg, dark text),
  // so we re-bind the common text tokens back to chat-surface content
  // values. In GLASS mode we want the editor to read as glass like every
  // other o8 panel tab — let the chrome-surface scope win (white text on
  // translucent vibrancy), no re-binding.
  const { surface } = useTheme();
  const contentRebinds = surface === 'solid'
    ? {
        ['--t-text' as unknown as string]: 'var(--t-chat-surface-text)',
        ['--t-text-secondary' as unknown as string]: 'var(--t-chat-surface-text-secondary)',
        ['--t-text-muted' as unknown as string]: 'var(--t-chat-surface-text-muted)',
        ['--t-text-faint' as unknown as string]: 'var(--t-chat-surface-text-muted)',
        ['--t-input-bg' as unknown as string]: 'var(--t-chat-surface-input-bg)',
      }
    : {};
  return (
    <div style={{
      display: 'flex',
      flex: 1,
      flexDirection: 'column',
      minHeight: 0,
      background: 'var(--t-canvas-bg)',
      color: surface === 'solid' ? 'var(--t-chat-surface-text)' : 'var(--t-text)',
      ...contentRebinds,
    } as CSSProperties}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 58,
        paddingLeft: 18,
        paddingRight: 18,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontFamily: UI_FONT,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: surface === 'solid' ? 'var(--t-chat-surface-text)' : 'var(--t-text)',
            fontSize: 13,
            fontWeight: 650,
            letterSpacing: '-0.01em',
          }}>
            Workspace Notes
          </div>
          <div style={{
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: error ? 'var(--t-brand-red)' : 'var(--t-chat-surface-text-muted)',
            fontSize: 11,
            fontWeight: 600,
          }}>
            Shared with agents · {status}
          </div>
        </div>
        <div
          aria-label={`Notes diff ${diffStats.additions} additions, ${diffStats.deletions} deletions`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontFamily: MONO_FONT,
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {diffStats.additions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>+{diffStats.additions}</span> : null}
          {diffStats.deletions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{diffStats.deletions}</span> : null}
          {diffStats.additions === 0 && diffStats.deletions === 0 ? <span style={{ color: 'var(--t-text-faint)' }}>0</span> : null}
        </div>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14 }}>
        <div style={{
          display: 'flex',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          maxWidth: 920,
          marginLeft: 'auto',
          marginRight: 'auto',
          borderRadius: 18,
          border: '1px solid var(--t-divider-subtle)',
          background: surface === 'solid' ? 'var(--t-chat-surface-input-bg)' : 'rgba(255, 255, 255, 0.04)',
          overflow: 'hidden',
        }}>
          {loading ? (
            <div style={{ paddingTop: 18, paddingLeft: 18, color: 'var(--t-chat-surface-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>Loading notes...</div>
          ) : (
            <div
              className="cortex-scroll-fade-y cortex-themed-scroll cortex-inset-scroll o8-notes-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                marginTop: 7,
                marginRight: 7,
                marginBottom: 7,
                marginLeft: 7,
                paddingLeft: 16,
                paddingRight: 8,
                // map the editor's theme-agnostic vars onto the panel's surface tokens
                ['--o8ed-ink' as string]: surface === 'solid' ? 'var(--t-chat-surface-text)' : 'var(--t-text)',
                ['--o8ed-ink-soft' as string]: 'var(--t-chat-surface-text-secondary)',
                ['--o8ed-ink-faint' as string]: 'var(--t-chat-surface-text-muted)',
                ['--o8ed-orange' as string]: 'var(--t-brand-orange, #FF5A1F)',
                ['--o8ed-add' as string]: 'var(--t-terminal-ansi-bright-green, #16a34a)',
                ['--o8ed-del' as string]: 'var(--t-brand-red, #ef4444)',
                ['--o8ed-hilite' as string]: 'rgba(232, 150, 40, 0.20)',
              } as CSSProperties}
            >
              <O8SpecEditor value={content} onChange={handleChange} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
