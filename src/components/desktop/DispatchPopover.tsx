'use client';

/**
 * DispatchPopover — the 600x80 frameless popover summoned by Cmd+Shift+O
 * (issue #730). Single text input. Press Enter to dispatch via the existing
 * `/api/orchestrator/create-mission` endpoint (which auto-dispatches because
 * the API defaults `dispatch=true`). Esc to close.
 *
 * Picks the most recently opened repo as the dispatch target. v1 trade-off:
 * we don't show a repo picker — that bloats the 80px height. Power users can
 * still dispatch via the main Orchestrator tab when they need a different
 * repo. Future iteration: tab-completion for repo names.
 */
import { useEffect, useRef, useState } from 'react';

interface RepoEntry {
  id: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  lastOpenedAt: string;
}

function readWsToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? '';
}

function bearerHeaders(): Record<string, string> {
  const token = readWsToken();
  const base: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

async function loadDefaultRepo(): Promise<RepoEntry | null> {
  try {
    const res = await fetch('/api/panel/repos', { headers: bearerHeaders() });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const repos: RepoEntry[] = Array.isArray(json?.repos) ? json.repos : [];
    if (repos.length === 0) return null;
    // Most recently opened wins. lastOpenedAt is ISO; lex-sort works.
    const sorted = [...repos].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
    return sorted[0] ?? null;
  } catch {
    return null;
  }
}

async function closePopover(): Promise<void> {
  // Cross fingers we're inside Tauri; in a non-Tauri preview context, just
  // navigate the browser tab away.
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_dispatch_popover');
      return;
    }
  } catch {
    // fall through
  }
  if (typeof window !== 'undefined') {
    window.close();
  }
}

export default function DispatchPopover() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState('');
  const [repo, setRepo] = useState<RepoEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadDefaultRepo().then((r) => setRepo(r));
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  // Esc closes immediately. We capture at window level because the input
  // doesn't always have native Esc behavior under Tauri.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void closePopover();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-close on blur — the popover should feel like a Spotlight prompt:
  // click anywhere else, it goes away. We keep a ref-flag for `busy` so the
  // handler can read the latest value (closure capture would freeze busy=false).
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => {
    const handler = () => {
      // Slight delay so submit's window.close beats this and we don't fire
      // both close paths. Skip when a dispatch is in flight.
      window.setTimeout(() => {
        if (busyRef.current) return;
        if (!document.hasFocus()) {
          void closePopover();
        }
      }, 120);
    };
    window.addEventListener('blur', handler);
    return () => window.removeEventListener('blur', handler);
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    if (!repo) {
      setError('No repo registered. Open one in the dashboard first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/orchestrator/create-mission', {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({
          repoPath: repo.localPath,
          issues: [
            {
              number: Date.now(),
              title: trimmed.slice(0, 120),
              body: trimmed,
              url: '',
            },
          ],
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        setError(`Dispatch failed: ${res.status} ${txt.slice(0, 80)}`);
        setBusy(false);
        return;
      }
      // Mission created + auto-dispatched (the API defaults dispatch=true).
      // Close immediately — the user can tab to o8 to monitor progress.
      await closePopover();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      setBusy(false);
    }
  };

  const placeholder = repo
    ? `Dispatch to ${repo.name} on ${repo.defaultBranch}…`
    : 'Loading repo…';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'rgba(22, 25, 30, 0.92)',
        backdropFilter: 'blur(24px) saturate(160%)',
        WebkitBackdropFilter: 'blur(24px) saturate(160%)',
        borderRadius: 14,
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 24px 48px -12px rgba(0, 0, 0, 0.5)',
        color: '#e8ecf2',
        fontFamily: '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 18,
          paddingRight: 18,
          gap: 12,
        }}
      >
        {/* Tiny brand glyph — square dot — matches the o8 design language. */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            backgroundColor: busy ? '#f59e0b' : '#22c55e',
            flexShrink: 0,
            boxShadow: busy ? '0 0 12px rgba(245, 158, 11, 0.6)' : '0 0 12px rgba(34, 197, 94, 0.4)',
          }}
        />
        <input
          ref={inputRef}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          autoFocus
          spellCheck={false}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#ffffff',
            fontSize: 17,
            fontWeight: 400,
            letterSpacing: '-0.01em',
            fontFamily: 'inherit',
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: 'rgba(232, 236, 242, 0.5)',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          {busy ? 'Dispatching' : 'Enter'}
        </span>
      </div>
      {error ? (
        <div
          style={{
            paddingTop: 4,
            paddingBottom: 8,
            paddingLeft: 18,
            paddingRight: 18,
            fontSize: 11,
            color: '#fca5a5',
            letterSpacing: '-0.005em',
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
