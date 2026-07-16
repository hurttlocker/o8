'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The header chrome's tooltip — label + keybind, in o8's own vocabulary rather
 * than the OS's. Every chrome control wears it (Q 2026-07-16: "everything needs
 * this bespoke description hover, it's branding, like EVERYTHING"), so it lives
 * here instead of inside any one button.
 *
 * Why not the native `title` attribute: these controls sit in the topmost strip,
 * where a native tooltip (or any `overflow: hidden` ancestor) clips against the
 * window's top edge — the operator saw "Open O…". This portals to document.body
 * and opens DOWNWARD, right-anchored, so the label is always fully readable.
 */
export function useChromeTooltip({ label, keybind }: { label: string; keybind?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const [tip, setTip] = useState<{ top: number; right: number } | null>(null);

  const open = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTip({ top: r.bottom + 6, right: Math.max(6, window.innerWidth - r.right) });
  }, []);

  const close = useCallback(() => {
    window.clearTimeout(showTimer.current);
    setTip(null);
  }, []);

  const schedule = useCallback(() => {
    window.clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(open, 320);
  }, [open]);

  useEffect(() => () => window.clearTimeout(showTimer.current), []);

  const handlers = {
    onMouseEnter: schedule,
    onMouseLeave: close,
    onFocus: open,
    onBlur: close,
  };

  const tooltip = tip && typeof document !== 'undefined'
    ? createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            top: tip.top,
            right: tip.right,
            zIndex: 2147483000,
            pointerEvents: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            whiteSpace: 'nowrap',
            background: 'var(--t-bg-card)',
            color: 'var(--t-text)',
            borderWidth: '0.5px',
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            borderRadius: 8,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 8,
            paddingRight: 8,
            fontFamily: 'var(--font-sans-system)',
            fontSize: 11,
            fontWeight: 400,
            lineHeight: 1.3,
            letterSpacing: '-0.1px',
            boxShadow: 'var(--t-glass-shadow, 0 8px 20px rgba(15, 23, 42, 0.22))',
          }}
        >
          <span>{label}</span>
          {keybind ? <span style={{ color: 'var(--t-text-muted)' }}>{keybind}</span> : null}
        </div>,
        document.body,
      )
    : null;

  return { ref, handlers, close, tooltip };
}
