'use client';

/**
 * ModeChip — compact mode selector that lives in the composer footer.
 *
 * Replaces the full-card ModePicker render that used to take over the
 * composer area as soon as the user typed. The chip is one line, never
 * blocks typing, and opens a small popover on click with the four
 * routing options (Fleet stays on this tab; Single/Chat spawn a new
 * tab in that mode).
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OrchestrationMode, OrchestratorRuntime } from '@/lib/orchestrator/types';

interface ModeChipProps {
  selectedMode: OrchestrationMode;
  selectedSingleRuntime: OrchestratorRuntime;
  onSelectFleet: () => void;
  /**
   * Kept for backwards-compatible call sites + legacy single-mode tabs that
   * already exist on disk. The picker UI no longer surfaces a single-runtime
   * section (operator decision 2026-05-23 — only Fleet and Chat are exposed
   * in the picker; existing single-mode tabs still render their label
   * correctly via chipLabel fallback).
   */
  onSpawnSingleTab?: (runtime: OrchestratorRuntime) => void;
  onSpawnChatTab?: () => void;
}

const FONT_FAMILY = 'var(--font-sans-system)';

function chipLabel(mode: OrchestrationMode, runtime: OrchestratorRuntime): string {
  if (mode === 'fleet') return 'Fleet';
  if (mode === 'chat') return 'Chat';
  // Legacy single-mode label — capitalize the runtime id.
  return runtime.charAt(0).toUpperCase() + runtime.slice(1);
}

export function ModeChip({
  selectedMode,
  selectedSingleRuntime,
  onSelectFleet,
  onSpawnChatTab,
}: ModeChipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Anchor the popover from the BOTTOM (so it grows UPWARD) — the chip
  // lives near the bottom of the composer footer and a downward menu
  // gets clipped by the workspace edge. `bottom` in CSS is measured
  // from the viewport bottom; we fix the popover's bottom edge 6px
  // above the chip's top edge.
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition({
      left: Math.round(rect.left),
      bottom: Math.round(window.innerHeight - rect.top + 6),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleDocClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', handleDocClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleDocClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const label = chipLabel(selectedMode, selectedSingleRuntime);

  const handlePickFleet = () => {
    onSelectFleet();
    setOpen(false);
  };

  const handlePickChat = () => {
    if (!onSpawnChatTab) return;
    onSpawnChatTab();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch mode"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 18,
          paddingTop: 0,
          paddingRight: 6,
          paddingBottom: 0,
          paddingLeft: 6,
          borderRadius: 6,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: open ? 'var(--t-border)' : 'transparent',
          background: open ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-faint)',
          cursor: 'pointer',
          fontFamily: FONT_FAMILY,
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(event) => {
          if (open) return;
          event.currentTarget.style.background = 'var(--t-hover)';
        }}
        onMouseLeave={(event) => {
          if (open) return;
          event.currentTarget.style.background = 'transparent';
        }}
      >
        <span aria-hidden style={{ display: 'inline-flex', color: 'var(--t-brand-orange, #FF5A1F)', marginRight: 1 }}>
          <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="6" r="2" />
            <circle cx="6" cy="18" r="2" />
            <circle cx="18" cy="18" r="2" />
            <path d="M12 8v4" />
            <path d="m12 12-6 4" />
            <path d="m12 12 6 4" />
          </svg>
        </span>
        <span>{label}</span>
        <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ opacity: 0.7 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && position
        ? createPortal(
            <div
              ref={popoverRef}
              role="menu"
              style={{
                position: 'fixed',
                left: position.left,
                bottom: position.bottom,
                zIndex: 1000,
                minWidth: 240,
                paddingTop: 6,
                paddingRight: 6,
                paddingBottom: 6,
                paddingLeft: 6,
                borderRadius: 12,
                background: 'var(--t-panel-solid, #ffffff)',
                border: '1px solid var(--t-border, rgba(15,23,42,0.12))',
                boxShadow: '0 18px 42px rgba(15, 23, 42, 0.16)',
                fontFamily: FONT_FAMILY,
              }}
            >
              <PopoverSectionLabel>Mode</PopoverSectionLabel>
              <PopoverRow
                active={selectedMode === 'fleet'}
                title="Fleet orchestration"
                detail="Stay on this tab · Claude routes Codex in waves."
                onClick={handlePickFleet}
                glyph={<FleetGlyph />}
              />

              <PopoverSectionLabel>Chat · spawns new tab</PopoverSectionLabel>
              <PopoverRow
                active={selectedMode === 'chat'}
                title="Chat with o8"
                detail="No dispatch · model picker in tab."
                onClick={handlePickChat}
                glyph={<ChatGlyph />}
                disabled={!onSpawnChatTab}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function PopoverSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        paddingTop: 6,
        paddingRight: 8,
        paddingBottom: 4,
        paddingLeft: 8,
        fontSize: 9.5,
        fontWeight: 700,
        color: 'var(--t-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </div>
  );
}

interface PopoverRowProps {
  active: boolean;
  title: string;
  detail: string;
  onClick: () => void;
  glyph: React.ReactNode;
  disabled?: boolean;
}

function PopoverRow({ active, title, detail, onClick, glyph, disabled }: PopoverRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
      style={{
        display: 'grid',
        gridTemplateColumns: '20px minmax(0, 1fr) 14px',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        paddingTop: 7,
        paddingRight: 8,
        paddingBottom: 7,
        paddingLeft: 8,
        borderRadius: 8,
        borderWidth: 0,
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: 'var(--t-text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (active || disabled) return;
        event.currentTarget.style.background = 'var(--t-hover)';
      }}
      onMouseLeave={(event) => {
        if (active || disabled) return;
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <span aria-hidden style={{ display: 'inline-flex', color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-muted)' }}>
        {glyph}
      </span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--t-text)',
            letterSpacing: '-0.005em',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--t-text-muted)',
            lineHeight: 1.35,
          }}
        >
          {detail}
        </span>
      </span>
      <span aria-hidden style={{ opacity: active ? 1 : 0, color: 'var(--t-brand-orange, #FF5A1F)' }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 4 4 10-10" />
        </svg>
      </span>
    </button>
  );
}

function FleetGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 8v4" />
      <path d="m12 12-6 4" />
      <path d="m12 12 6 4" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    </svg>
  );
}
