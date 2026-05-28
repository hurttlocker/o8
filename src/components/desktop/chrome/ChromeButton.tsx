'use client';

/**
 * ChromeButton — the canonical header/footer button style for o8's desktop
 * shell. Lifted out of `NavRail.tsx` so the TitleBar, DesktopStatusBar, and
 * WorkspaceTerminal TabBar can all share one neomorphic look.
 *
 * Usage:
 *
 *   <ChromeButton
 *     icon={<PhosphorIcon />}           // 18px, bold (lucide works too)
 *     label="Agents"
 *     active={activeSection === 'agents'}
 *     onClick={() => setActiveNavSection('agents')}
 *   />
 *
 * The button is 32×32 by default (compact header density). It pulls its
 * background tint from the active theme via `data-theme` on the document
 * root so vibrancy-mode Tauri windows don't wash out.
 */

import { type CSSProperties, type ReactNode } from 'react';
import { motion } from 'framer-motion';

// Flat button surface tokens — DESIGN.md §06.7. The legacy chrome-btn-* tokens
// (boxy bg + inset shadow) were retired here on 2026-05-23 per operator lock-in.
// The button is transparent at rest, paints var(--t-hover) on hover, and uses
// var(--t-input-bg) when the surrounding UI requires an "active" indicator on
// the button itself. No shadows on hover or active.
const BG_INACTIVE = 'transparent';
const BG_HOVER = 'var(--t-hover)';
const BG_ACTIVE = 'var(--t-input-bg)';
const SHADOW_INACTIVE = 'none';
const SHADOW_HOVER = 'none';
const SHADOW_ACTIVE = 'none';
const TEXT_COLOR = 'var(--t-text)';

export function chromeNeoStyle(active: boolean, size = 32, radius = 10): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: radius,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: active ? BG_ACTIVE : BG_INACTIVE,
    boxShadow: active ? SHADOW_ACTIVE : SHADOW_INACTIVE,
    transition: 'box-shadow 150ms cubic-bezier(0.22, 1, 0.36, 1), background 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}

/**
 * Returns just the background + boxShadow portion of the neomorphic preset,
 * for non-square chrome elements like WorkspaceTerminal tabs that need the
 * same tint/shadow but manage their own dimensions.
 */
export function chromeNeoSurface(active: boolean): { background: string; boxShadow: string } {
  return {
    background: active ? BG_ACTIVE : BG_INACTIVE,
    boxShadow: active ? SHADOW_ACTIVE : SHADOW_INACTIVE,
  };
}

export function chromeNeoHoverSurface(): { background: string; boxShadow: string } {
  return { background: BG_HOVER, boxShadow: SHADOW_HOVER };
}

function applyNeoHover(el: HTMLElement, active: boolean) {
  if (active) return;
  el.style.background = BG_HOVER;
  el.style.boxShadow = SHADOW_HOVER;
}

function resetNeoHover(el: HTMLElement, active: boolean) {
  if (active) return;
  el.style.background = BG_INACTIVE;
  el.style.boxShadow = SHADOW_INACTIVE;
}

interface ChromeButtonProps {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  badge?: number;
  size?: number;
  radius?: number;
  /** Tooltip override — defaults to `label`. Pass this to surface a keybind
   *  hint (e.g. "Settings (⌘,)") in the title without bloating aria-label. */
  title?: string;
  /** Cancel the Tauri drag region so the button is clickable in the title bar. */
  noDrag?: boolean;
}

export function ChromeButton({
  icon,
  label,
  onClick,
  active = false,
  badge,
  // Defaults updated to DESIGN.md §06.7 — 26 tall, 7px radius. Existing call
  // sites that pass `size={22} radius={6}` (DesktopStatusBar footer) still
  // win via prop overrides.
  size = 26,
  radius = 7,
  title,
  noDrag = false,
}: ChromeButtonProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={title ?? label}
      // whileHover="hover" propagates the variant down — the inner icon
      // wrapper picks up { scale: 1.08 } so the icon gets a gentle micro
      // motion on hover while the button itself stays put. Matches the
      // title-bar IconPanelLeft / IconSearch language (operator pass
      // 2026-05-27: "motion of the icon, not motion of the button").
      initial="rest"
      animate="rest"
      whileHover="hover"
      whileTap="tap"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        borderWidth: 0,
        background: 'transparent',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        position: 'relative',
        ...(noDrag ? { ['WebkitAppRegion' as string]: 'no-drag' } : {}),
      }}
      onMouseEnter={(event) => {
        const neo = event.currentTarget.querySelector('[data-neo]') as HTMLElement | null;
        if (neo) applyNeoHover(neo, active);
      }}
      onMouseLeave={(event) => {
        const neo = event.currentTarget.querySelector('[data-neo]') as HTMLElement | null;
        if (neo) resetNeoHover(neo, active);
      }}
    >
      <div data-neo="" style={{ ...chromeNeoStyle(active, size, radius), color: TEXT_COLOR }}>
        <motion.div
          // Icon micro-motion — rotate + nudge, NOT a scale grow. Operator
          // pass 2026-05-27: "motion of the icon, not just get bigger".
          // ~7° tilt and 0.6 px horizontal nudge reads as "spring to
          // attention" without resizing. Matches IconPanelLeft / IconSearch's
          // tilt language in the title bar.
          variants={{
            rest: { rotate: 0, x: 0 },
            hover: { rotate: -7, x: 0.6 },
            tap: { rotate: -3, x: 0.2 },
          }}
          transition={{ type: 'spring', stiffness: 520, damping: 22, mass: 0.6 }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }}
        >
          {icon}
        </motion.div>
      </div>
      {badge !== undefined && badge > 0 ? (
        <div
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            minWidth: 14,
            height: 14,
            paddingLeft: 3,
            paddingRight: 3,
            borderRadius: 7,
            background: '#ef4444',
            color: '#fff',
            fontSize: 8,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {badge > 9 ? '9+' : badge}
        </div>
      ) : null}
    </motion.button>
  );
}
