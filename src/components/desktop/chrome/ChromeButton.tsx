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

const NEO_LIGHT = {
  inactive: {
    background: 'rgba(255, 255, 255, 0.72)',
    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8)',
  },
  active: {
    background: 'rgba(255, 255, 255, 0.98)',
    boxShadow: '0 3px 10px rgba(15, 23, 42, 0.12), 0 1px 2px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.95)',
  },
  hover: {
    background: 'rgba(255, 255, 255, 0.88)',
    boxShadow: '0 2px 8px rgba(15, 23, 42, 0.1), 0 1px 2px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
  },
};

const NEO_DARK = {
  inactive: {
    background: 'rgba(22, 26, 34, 0.55)',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.07)',
  },
  active: {
    background: 'rgba(32, 38, 50, 0.82)',
    boxShadow: '0 3px 10px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.14)',
  },
  hover: {
    background: 'rgba(28, 34, 44, 0.7)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.32), 0 1px 2px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
  },
};

function getNeoPreset() {
  if (typeof document === 'undefined') return NEO_LIGHT;
  const theme = document.documentElement.getAttribute('data-theme');
  const isDark = theme === 'dark' || theme === 'midnight';
  return isDark ? NEO_DARK : NEO_LIGHT;
}

export function chromeNeoStyle(active: boolean, size = 32, radius = 10): CSSProperties {
  const neo = getNeoPreset();
  const preset = active ? neo.active : neo.inactive;
  return {
    width: size,
    height: size,
    borderRadius: radius,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: preset.background,
    boxShadow: preset.boxShadow,
    transition: 'box-shadow 150ms ease, background 150ms ease',
  };
}

/**
 * Returns just the background + boxShadow portion of the neomorphic preset,
 * for non-square chrome elements like WorkspaceTerminal tabs that need the
 * same tint/shadow but manage their own dimensions.
 */
export function chromeNeoSurface(active: boolean): { background: string; boxShadow: string } {
  const neo = getNeoPreset();
  const preset = active ? neo.active : neo.inactive;
  return { background: preset.background, boxShadow: preset.boxShadow };
}

export function chromeNeoHoverSurface(): { background: string; boxShadow: string } {
  const neo = getNeoPreset();
  return { background: neo.hover.background, boxShadow: neo.hover.boxShadow };
}

function applyNeoHover(el: HTMLElement, active: boolean) {
  if (active) return;
  const neo = getNeoPreset();
  el.style.background = neo.hover.background;
  el.style.boxShadow = neo.hover.boxShadow;
}

function resetNeoHover(el: HTMLElement, active: boolean) {
  if (active) return;
  const neo = getNeoPreset();
  el.style.background = neo.inactive.background;
  el.style.boxShadow = neo.inactive.boxShadow;
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
      <div data-neo="" style={{ ...chromeNeoStyle(active, size, radius), color: 'var(--t-text)' }}>
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
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          {badge > 9 ? '9+' : badge}
        </div>
      ) : null}
    </button>
  );
}
