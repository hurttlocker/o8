'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { listSavedPrompts, type PromptLibraryEntry } from '@/lib/prompt-library/client';

const UI_FONT = 'var(--font-sans-system)';

export function PromptLibraryPalette({ open, repoPath, onClose, onPick }: {
  open: boolean;
  repoPath: string | null;
  onClose: () => void;
  onPick: (prompt: PromptLibraryEntry) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [prompts, setPrompts] = useState<PromptLibraryEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setQuery('');
      setSelectedIndex(0);
      setError(null);
      inputRef.current?.focus();
    }, 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void listSavedPrompts({ query, repoPath, signal: controller.signal })
        .then((entries) => {
          setPrompts(entries);
          setSelectedIndex(0);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setError(cause instanceof Error ? cause.message : 'Saved prompts could not be loaded.');
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, query ? 100 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, repoPath]);

  const commit = useCallback((prompt: PromptLibraryEntry) => {
    onPick(prompt);
    onClose();
  }, [onClose, onPick]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (prompts.length > 0) setSelectedIndex((current) => (current + 1) % prompts.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (prompts.length > 0) setSelectedIndex((current) => (current - 1 + prompts.length) % prompts.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const prompt = prompts[selectedIndex];
      if (prompt) commit(prompt);
    }
  };

  if (!open || !mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={overlayStyle}
    >
      <div role="dialog" aria-label="Saved prompts" style={paletteStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Prompts</span>
          <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>{prompts.length}</span>
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="Search saved prompts…"
          aria-label="Search saved prompts"
          style={inputStyle}
        />
        <div aria-hidden style={{ height: 1, background: 'var(--t-divider-subtle)' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '50vh', overflowY: 'auto' }}>
          {error ? <PaletteStatus text={error} error /> : loading && prompts.length === 0 ? (
            <PaletteStatus text="Loading saved prompts…" />
          ) : prompts.length === 0 ? (
            <PaletteStatus text={query ? 'No matching prompts.' : 'No saved prompts yet. Add one in Customize.'} />
          ) : prompts.map((prompt, index) => (
            <button
              key={prompt.id}
              type="button"
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(prompt)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                minHeight: 44,
                paddingTop: 7,
                paddingBottom: 7,
                paddingLeft: 10,
                paddingRight: 10,
                border: 'none',
                borderRadius: 9,
                background: index === selectedIndex ? 'var(--t-hover)' : 'transparent',
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: UI_FONT,
              }}
            >
              <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prompt.title}</span>
                <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prompt.body.replace(/\s+/g, ' ')}</span>
              </div>
              <span style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>{prompt.scope === 'global' ? 'Global' : 'Repo'}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>
          <span>↑↓ select</span>
          <span>↵ insert</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PaletteStatus({ text, error = false }: { text: string; error?: boolean }) {
  return <div role={error ? 'alert' : 'status'} style={{ minHeight: 44, paddingTop: 12, paddingBottom: 12, paddingLeft: 10, paddingRight: 10, fontSize: 12, fontWeight: 300, color: error ? 'var(--t-danger, #ef4444)' : 'var(--t-text-muted)' }}>{text}</div>;
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  zIndex: 10001,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '18vh',
  background: 'rgba(0, 0, 0, 0.5)',
};

const paletteStyle: CSSProperties = {
  width: 480,
  maxWidth: 'calc(100vw - 48px)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  paddingTop: 20,
  paddingBottom: 16,
  paddingLeft: 20,
  paddingRight: 20,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider-subtle)',
  borderRadius: 14,
  background: 'var(--t-panel-solid, var(--t-bg-card))',
  boxShadow: 'var(--t-panel-shadow)',
  color: 'var(--t-text)',
  fontFamily: UI_FONT,
};

const inputStyle: CSSProperties = {
  width: '100%',
  height: 44,
  paddingTop: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  paddingRight: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--t-text)',
  fontSize: 15,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  fontFamily: UI_FONT,
};
