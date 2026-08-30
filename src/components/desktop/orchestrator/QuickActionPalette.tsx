'use client';

/**
 * QuickActionPalette — Cmd+Shift+K palette mounted in the Orchestrator tab.
 * (Plain Cmd+K is the global CommandPalette; see OrchestratorTab keydown.)
 *
 * Paper surface, hairline border, 480px wide, portal-mounted over a
 * 50% tint backdrop. Typing filters by verb + label. Up/Down move
 * selection; Enter picks; Esc closes.
 *
 * On pick, calls `onPick(action)` — parent is responsible for filling
 * the composer (typically via the existing `draftInjection` prop on
 * ThoughtsChatPanel). We deliberately do NOT auto-send — operator
 * should be able to edit the template before sending.
 *
 * Lives inside /orchestrator for a reason: if another surface ever
 * wants its own quick-actions palette, copy this file; don't try to
 * share it. Keeps the orchestrator UX isolated.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { filterQuickActions, type QuickAction } from '@/lib/orchestrator/quick-actions';

interface QuickActionPaletteProps {
  open: boolean;
  onClose: () => void;
  onPick: (action: QuickAction) => void;
}

const FONT_STACK = 'var(--font-sans-system)';
const subscribeToMountedState = () => () => {};
const getMountedSnapshot = () => true;
const getServerMountedSnapshot = () => false;

export function QuickActionPalette({ open, onClose, onPick }: QuickActionPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const mounted = useSyncExternalStore(
    subscribeToMountedState,
    getMountedSnapshot,
    getServerMountedSnapshot,
  );
  // Entrance fade — 120ms opacity only, matching the global CommandPalette
  // (Q ruling 2026-07-28: quick fade on both palettes, no scale, no travel).
  const [entered, setEntered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setEntered(false);
    };
  }, [open]);

  const filtered = useMemo(() => filterQuickActions(query), [query]);

  // Reset state every time the palette is opened so operators always
  // land on a clean list from the first row.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Clamp selection when the filtered list shrinks below the current index.
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(filtered.length === 0 ? 0 : filtered.length - 1);
    }
  }, [filtered.length, selectedIndex]);

  const commit = useCallback((action: QuickAction) => {
    onPick(action);
    onClose();
  }, [onClose, onPick]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length === 0) return;
      setSelectedIndex((prev) => (prev + 1) % filtered.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const pick = filtered[selectedIndex];
      if (pick) commit(pick);
    }
  }, [commit, filtered, onClose, selectedIndex]);

  if (!open || !mounted || typeof document === 'undefined') return null;

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    background: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '18vh',
    zIndex: 10000,
    opacity: entered ? 1 : 0,
    transition: 'opacity 120ms ease-out',
  };

  const paletteStyle: CSSProperties = {
    width: 480,
    maxWidth: 'calc(100vw - 48px)',
    background: 'var(--t-bg-card)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--t-border-subtle, var(--t-border))',
    borderRadius: 14,
    paddingTop: 24,
    paddingRight: 24,
    paddingBottom: 24,
    paddingLeft: 24,
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.22)',
    fontFamily: FONT_STACK,
    color: 'var(--t-text)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  };

  const inputStyle: CSSProperties = {
    width: '100%',
    height: 36,
    borderWidth: 0,
    background: 'transparent',
    color: 'var(--t-text)',
    fontSize: 15,
    fontWeight: 500,
    fontFamily: FONT_STACK,
    outline: 'none',
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    letterSpacing: '-0.005em',
  };

  const dividerStyle: CSSProperties = {
    height: 1,
    background: 'var(--t-border-subtle, var(--t-border))',
    width: '100%',
  };

  const listStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: '50vh',
    overflowY: 'auto',
  };

  const emptyStyle: CSSProperties = {
    paddingTop: 12,
    paddingRight: 4,
    paddingBottom: 12,
    paddingLeft: 4,
    fontSize: 13,
    color: 'var(--t-text-muted)',
    fontFamily: FONT_STACK,
  };

  const node = (
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        style={paletteStyle}
        role="dialog"
        aria-label="Quick actions"
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="What do you want to do…"
          style={inputStyle}
          aria-label="Filter quick actions"
        />
        <div style={dividerStyle} aria-hidden />
        <div ref={listRef} style={listStyle}>
          {filtered.length === 0 ? (
            <div style={emptyStyle}>No matches.</div>
          ) : (
            filtered.map((action, index) => (
              <QuickActionRow
                key={action.id}
                action={action}
                selected={index === selectedIndex}
                onHover={() => setSelectedIndex(index)}
                onPick={() => commit(action)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

interface QuickActionRowProps {
  action: QuickAction;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}

function QuickActionRow({ action, selected, onHover, onPick }: QuickActionRowProps) {
  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    paddingTop: 10,
    paddingRight: 12,
    paddingBottom: 10,
    paddingLeft: 12,
    borderRadius: 10,
    cursor: 'pointer',
    background: selected ? 'var(--t-bg-card-hover, var(--t-panel-hover))' : 'transparent',
    transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
    borderWidth: 0,
    textAlign: 'left',
    fontFamily: FONT_STACK,
  };

  const verbStyle: CSSProperties = {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--t-text-muted)',
    minWidth: 72,
    flexShrink: 0,
  };

  const labelStyle: CSSProperties = {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--t-text)',
    letterSpacing: '-0.005em',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  return (
    <button
      type="button"
      style={rowStyle}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        // Prevent the input from losing focus before the click fires.
        event.preventDefault();
      }}
      onClick={onPick}
    >
      <span style={verbStyle}>{action.verb}</span>
      <span style={labelStyle}>{action.label}</span>
    </button>
  );
}
