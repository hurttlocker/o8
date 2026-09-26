'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WORKSPACE_TAB_DRAG_TYPE, type WorkspaceTabDragKind } from '@/lib/tiles/workspace-tab-drag';

interface HeaderPlayButtonProps {
  onSpawnChat?: () => void;
  onSpawnTerminal?: () => void;
  onSplitTab?: (kind: 'chat' | 'terminal', direction: 'right' | 'below') => void;
  ariaSuffix?: string;
  paneMode?: boolean;
}

function HeaderPlayMenuItem({ label, onClick, dragKind, onDragEnd }: {
  label: string;
  onClick: () => void;
  dragKind?: WorkspaceTabDragKind;
  onDragEnd?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      draggable={Boolean(dragKind)}
      onClick={onClick}
      onDragStart={(event) => {
        if (!dragKind) return;
        event.dataTransfer.setData(WORKSPACE_TAB_DRAG_TYPE, dragKind);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text)',
        cursor: dragKind ? 'grab' : 'pointer',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 12,
        paddingRight: 12,
        fontSize: 13.5,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        lineHeight: 1.25,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {label}
    </button>
  );
}

export function HeaderPlayButton({
  onSpawnChat,
  onSpawnTerminal,
  onSplitTab,
  ariaSuffix,
  paneMode = false,
}: HeaderPlayButtonProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const update = () => setAnchorRect(wrapperRef.current?.getBoundingClientRect() ?? null);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const pick = useCallback((handler?: () => void) => () => {
    setOpen(false);
    handler?.();
  }, []);

  return (
    <div ref={wrapperRef} data-no-drag style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => {
          setAnchorRect(wrapperRef.current?.getBoundingClientRect() ?? null);
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={paneMode ? `Add pane (${ariaSuffix ?? 'workspace'})` : ariaSuffix ? `New tab (${ariaSuffix})` : 'New tab'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={paneMode ? 'Add a pane' : 'Add a workspace tab'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 26,
          minWidth: 26,
          paddingLeft: 7,
          paddingRight: 7,
          borderRadius: 7,
          borderWidth: 0,
          background: open || hovered ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-secondary)',
          cursor: 'pointer',
          marginTop: -3,
          transition: 'background 120ms ease',
          ['WebkitAppRegion' as string]: 'no-drag',
        }}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {open && anchorRect && typeof document !== 'undefined' ? createPortal(<div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label={paneMode ? `Add pane options (${ariaSuffix ?? 'workspace'})` : ariaSuffix ? `New tab options (${ariaSuffix})` : 'New tab options'}
        style={{
          position: 'fixed',
          top: anchorRect.bottom + 4,
          right: Math.max(8, window.innerWidth - anchorRect.right),
          minWidth: 220,
          borderRadius: 10,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          background: 'var(--t-popover-surface)',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
          paddingTop: 4,
          paddingBottom: 4,
          zIndex: 100,
          overflow: 'hidden',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {onSpawnChat ? (
          <HeaderPlayMenuItem label="Chat" onClick={pick(onSpawnChat)} dragKind="chat" onDragEnd={() => setOpen(false)} />
        ) : null}
        {onSpawnTerminal ? (
          <HeaderPlayMenuItem label="Terminal" onClick={pick(onSpawnTerminal)} dragKind="terminal" onDragEnd={() => setOpen(false)} />
        ) : null}
        {paneMode ? (
          <div style={{ color: 'var(--t-text-muted)', fontSize: 11, paddingTop: 7, paddingBottom: 5, paddingLeft: 12, borderTop: '1px solid var(--t-divider)' }}>Drag to place on a pane edge</div>
        ) : null}
        {onSplitTab ? (
          <>
            <div role="separator" style={{ borderTop: '1px solid var(--t-divider)', marginTop: 4, marginBottom: 4 }} />
            <div style={{ color: 'var(--t-text-muted)', fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', paddingLeft: 12, paddingBottom: 3 }}>NEW PANE</div>
            <HeaderPlayMenuItem label="Chat to right" onClick={pick(() => onSplitTab('chat', 'right'))} />
            <HeaderPlayMenuItem label="Terminal to right" onClick={pick(() => onSplitTab('terminal', 'right'))} />
            <HeaderPlayMenuItem label="Chat below" onClick={pick(() => onSplitTab('chat', 'below'))} />
            <HeaderPlayMenuItem label="Terminal below" onClick={pick(() => onSplitTab('terminal', 'below'))} />
            <div style={{ color: 'var(--t-text-muted)', fontSize: 11, paddingTop: 7, paddingBottom: 5, paddingLeft: 12, borderTop: '1px solid var(--t-divider)' }}>Drag Chat or Terminal onto a pane</div>
          </>
        ) : null}
      </div>, document.body) : null}
    </div>
  );
}
