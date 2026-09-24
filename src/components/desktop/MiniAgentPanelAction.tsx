'use client';

import type React from 'react';
import { Menu, type LucideIcon } from './lucide-shims';
import { MenuScale } from 'iconoir-react';

const MINI_FLAT_HOVER_BG = 'var(--t-hover)';

/**
 * LOCKED 2026-05-28 — DO NOT modify the icon column geometry, label x-position,
 * or trailing-icon shift on this component without operator sign-off. These
 * values are aligned by-eye against the Yesterday folder glyph (x=12) and
 * chat-row text (x=37) below in the same column. See [[next-session-pickup-may28]].
 *
 *   Leading icon span: width 17, transform translateX(-2px) → visible icon
 *     left edge ≈ x=10, matches Yesterday folder at x=12.
 *   Button paddingLeft: 2 (was 10) → label text lands at x=37, matches
 *     HistoryChatRow paddingLeft: 37.
 *   Disclosure trailing icon: transform translateX(7px) → sits ~6px right of
 *     the Yesterday FilterList glyph. New session uses lucide Menu (≡), Projects
 *     uses iconoir MenuScale.
 */
export function MiniAgentPanelAction({
  icon: Icon,
  label,
  active = false,
  disabled = false,
  disclosure,
  onClick,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  disclosure?: 'menu' | 'filter';
  onClick?: () => void;
  /** Extra control rendered between the label and the disclosure glyph
      (e.g. Projects row's add-repo). Must NOT be a <button> — the row
      itself is one; use a span with role="button" + stopPropagation. */
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // Menu-disclosure rows are real menu triggers (New session → inline
      // Orchestrator/Terminal menu). Say so: agents and screen readers find
      // triggers by aria-haspopup/aria-expanded — the o8_view_* menu tools
      // ignore unlabeled buttons entirely (#1571).
      aria-haspopup={disclosure === 'menu' ? 'menu' : undefined}
      aria-expanded={disclosure === 'menu' ? active : undefined}
      style={{
        width: 'calc(100% - 16px)',
        marginLeft: 8,
        marginRight: 8,
        minHeight: 27,
        borderWidth: 0,
        borderBottom: 0,
        // Round + slight inset so the hover bg reads as a flat chip,
        // not a full-bleed slab across the column. Matches the bottom
        // terminal toggle's footprint feel — operator pass 2026-05-27.
        borderRadius: 8,
        background: active ? MINI_FLAT_HOVER_BG : 'transparent',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        outline: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 3,
        paddingRight: 10,
        paddingBottom: 3,
        paddingLeft: 2,
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        // No transition — instant flat color swap, no soft fade. The
        // terminal toggle button uses the same instant pattern.
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = MINI_FLAT_HOVER_BG;
      }}
      onMouseLeave={(event) => {
        if (!disabled) event.currentTarget.style.background = active ? MINI_FLAT_HOVER_BG : 'transparent';
      }}
    >
      <span
        aria-hidden
        style={{
          width: 17,
          height: 17,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
          flexShrink: 0,
          transform: 'translateX(-2px)',
        }}
      >
        <Icon size={14} strokeWidth={2} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </span>
      {trailing ?? null}
      {disclosure ? (
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--t-text-faint)',
            // Per-glyph optical nudge (2026-06-11 re-snap): both glyphs' ink
            // sat 1-2px left of the right-rail column (ring+2). Menu's lines
            // inset ~1px inside its 13px box, MenuScale's ~0.5px inside 12px
            // — measured from rendered pixels at 4x, not the bbox math.
            transform: disclosure === 'menu' ? 'translateX(9px)' : 'translateX(8px)',
          }}
        >
          {disclosure === 'menu' ? (
            <Menu size={13} strokeWidth={2} />
          ) : (
            <MenuScale width={12} height={12} color="currentColor" strokeWidth={1.8} />
          )}
        </span>
      ) : null}
    </button>
  );
}
