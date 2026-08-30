'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

interface HeaderPlayButtonProps {
  onSpawnOrchestrator?: () => void;
  onSpawnChat?: () => void;
  onSpawnTerminal?: () => void;
  ariaSuffix?: string;
}

function HeaderPlayMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
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
  onSpawnOrchestrator,
  onSpawnChat,
  onSpawnTerminal,
  ariaSuffix,
}: HeaderPlayButtonProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) setOpen(false);
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

  const pick = useCallback((handler?: () => void) => () => {
    setOpen(false);
    handler?.();
  }, []);

  return (
    <div ref={wrapperRef} data-no-drag style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={ariaSuffix ? `New tab (${ariaSuffix})` : 'New tab'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="New orchestrator tab (⌘T)"
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
          color: 'var(--t-accent)',
          cursor: 'pointer',
          marginTop: -3,
          transition: 'background 120ms ease',
          ['WebkitAppRegion' as string]: 'no-drag',
        }}
      >
        <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
      <div
        id={menuId}
        role="menu"
        aria-label={ariaSuffix ? `New tab options (${ariaSuffix})` : 'New tab options'}
        style={{
          display: open ? 'block' : 'none',
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          minWidth: 220,
          borderRadius: 10,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          background: 'var(--t-panel)',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
          paddingTop: 4,
          paddingBottom: 4,
          zIndex: 100,
          overflow: 'hidden',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {onSpawnOrchestrator ? (
          <HeaderPlayMenuItem label="Orchestrator" onClick={pick(onSpawnOrchestrator)} />
        ) : null}
        {onSpawnChat ? (
          <HeaderPlayMenuItem label="Chat" onClick={pick(onSpawnChat)} />
        ) : null}
        {onSpawnTerminal ? (
          <HeaderPlayMenuItem label="Terminal" onClick={pick(onSpawnTerminal)} />
        ) : null}
      </div>
    </div>
  );
}
