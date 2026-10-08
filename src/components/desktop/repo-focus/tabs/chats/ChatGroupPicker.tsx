'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { REPO_FOCUS_FONT } from '../../utils';

import { CHAT_VIEW_LABELS, type ChatGroupMode } from './sidebar-view';
export type { ChatGroupMode } from './sidebar-view';

/** Compact chat view menu; the glyph and hover target share one center. */
export function ChatGroupPicker({
  mode,
  onChange,
}: {
  mode: ChatGroupMode;
  onChange: (next: ChatGroupMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const choose = (next: ChatGroupMode) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: globalThis.MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, marginRight: -1 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Change chat view"
        title="Change chat view"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 0,
          background: open || hovered ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          transition: 'background 120ms ease, color 120ms ease',
        }}
      >
        {/* Iconoir FilterList — matches hurttlocker chrome vocabulary. */}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="13" cy="8" r="1" /></svg>

      </button>
      {/* Always-mounted (display toggles) so agents can enumerate the
          grouping options from the DOM without opening first. */}
      <div
        ref={menuRef}
        id={menuId}
        onKeyDown={(event) => {
          const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
            : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
          if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
          if (event.key === 'Tab') setOpen(false);
        }}
        role="menu"
        aria-label="Chat view options"
        style={{
            display: open ? 'block' : 'none',
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 168,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'var(--t-popover-surface)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            paddingTop: 4,
            paddingBottom: 4,
            zIndex: 50,
            fontFamily: REPO_FOCUS_FONT,
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          {(['flat', 'chronological', 'working', 'scheduled'] as const).map((value) => (
            <ChatGroupPickerItem key={value} label={CHAT_VIEW_LABELS[value]} selected={mode === value} onClick={() => choose(value)} />
          ))}
          <div role="separator" style={{ height: 1, marginTop: 4, marginBottom: 4, background: 'var(--t-divider)' }} />
          {(['repo', 'date'] as const).map((value) => (
            <ChatGroupPickerItem key={value} label={`Group ${CHAT_VIEW_LABELS[value].toLowerCase()}`} selected={mode === value} onClick={() => choose(value)} />
          ))}
      </div>
    </div>
  );
}

function ChatGroupPickerItem({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 10,
        paddingRight: 10,
        borderWidth: 0,
        background: hovered || focused ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 12,
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: selected ? 'var(--t-accent)' : 'transparent',
        }}
      >
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      <span>{label}</span>
    </button>
  );
}
