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

// Chrome button surface tokens. Each theme defines these in `themes.ts`, and a
// `[data-chrome-surface="true"]` scope in the ThemeProvider overrides them when
// a chrome region sits on top of the vibrancy bleed (right panel in light
// mode, etc). Consuming CSS vars means hover/active updates cascade through
// the override without the component having to know about it.
const BG_INACTIVE = 'var(--t-chrome-btn-bg)';
const BG_HOVER = 'var(--t-chrome-btn-hover-bg)';
const BG_ACTIVE = 'var(--t-chrome-btn-active-bg)';
const SHADOW_INACTIVE = 'var(--t-chrome-btn-shadow)';
const SHADOW_HOVER = 'var(--t-chrome-btn-hover-shadow)';
const SHADOW_ACTIVE = 'var(--t-chrome-btn-active-shadow)';
const TEXT_COLOR = 'var(--t-chrome-btn-text, var(--t-text))';

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
    transition: 'box-shadow 150ms ease, background 150ms ease',
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
  /** Cancel the Tauri drag region so the button is clickable in the title bar. */
  noDrag?: boolean;
}

export function ChromeButton({
  icon,
  label,
  onClick,
  active = false,
  badge,
  size = 32,
  radius = 10,
  noDrag = false,
}: ChromeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={label}
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
        {icon}
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
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          {badge > 9 ? '9+' : badge}
        </div>
      ) : null}
    </button>
  );
}
