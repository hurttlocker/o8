'use client';

/**
 * Settings-shaped trigger around `AcpModelPicker`.
 *
 * The composer opens the picker inside its own popover; Settings needs a
 * PickerMenu-shaped control instead — same 44px row height and Rams chrome as
 * the other rows, so an opencode model reads as one setting among many rather
 * than a bolted-on panel.
 *
 * Portalled to `document.body` and positioned from the trigger's rect, matching
 * PickerMenu: an absolutely-positioned menu inside the scrolling settings body
 * gets clipped by the panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { AcpModelPicker } from '../thoughts/AcpModelPicker';
import { RAMS_CONTROL_BORDER } from './shared';

const PANEL_WIDTH = 320;

export function AcpModelPickerPopover({
  label,
  value,
  onSelect,
  onClear,
  disabled,
  backend = 'opencode',
}: {
  label: string;
  value: string | null;
  onSelect: (modelId: string) => void;
  onClear: () => void;
  disabled?: boolean;
  backend?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const toggle = useCallback(() => {
    if (disabled) return;
    setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null);
    setOpen((prev) => !prev);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  // Flip above the trigger when the panel would run off the bottom.
  const top = anchorRect
    ? (anchorRect.bottom + 440 > window.innerHeight ? Math.max(8, anchorRect.top - 444) : anchorRect.bottom + 6)
    : 0;
  const left = anchorRect ? Math.max(8, Math.min(anchorRect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)) : 0;

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {value ? (
        <button
          type="button"
          onClick={() => { if (!disabled) onClear(); }}
          disabled={disabled}
          title="Clear — run on the agent’s own default"
          style={{
            minHeight: 44,
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 10,
            paddingRight: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: RAMS_CONTROL_BORDER,
            borderRadius: 9,
            background: 'transparent',
            color: 'var(--t-text-faint)',
            fontSize: 12,
            fontWeight: 400,
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-sans-system)',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          Clear
        </button>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        title={value ?? undefined}
        style={{
          maxWidth: 260,
          minWidth: 140,
          minHeight: 44,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 14,
          paddingRight: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: RAMS_CONTROL_BORDER,
          borderRadius: 9,
          background: 'var(--t-input-bg)',
          color: 'var(--t-text)',
          fontSize: 12,
          fontWeight: 400,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: 'var(--font-sans-system)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.6 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top,
              left,
              zIndex: 4000,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: RAMS_CONTROL_BORDER,
              borderRadius: 12,
              background: 'var(--t-bg-card)',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.22)',
              overflow: 'hidden',
            }}
          >
            <AcpModelPicker
              backend={backend}
              value={value}
              width={PANEL_WIDTH}
              onSelect={(picked) => { onSelect(picked); setOpen(false); }}
            />
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
