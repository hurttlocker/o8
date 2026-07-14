'use client';

/**
 * ColumnHeaderStrip — the per-column header strip primitive for the o8 shell
 * (epic #1089). Each column — left nav, center workspace, right panel —
 * carries its own header strip instead of a single global TitleBar. A strip
 * is a horizontal row with left / center / right slots. Pass `drag` to make
 * the strip a Tauri window-drag region; interactive children stay clickable.
 */

import { useCallback, type CSSProperties, type ReactNode } from 'react';

interface ColumnHeaderStripProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  /** Strip height in px. Tightened from the legacy 44px to 36px to
   *  match Codex / Claude's leaner title-bar density. Override on any
   *  consumer that needs the old 44px (e.g. when re-introducing the
   *  Apple-HIG-mandated touch target). */
  height?: number;
  /** When true the strip acts as a Tauri window-drag region. */
  drag?: boolean;
  style?: CSSProperties;
}

export function ColumnHeaderStrip({
  left,
  center,
  right,
  height = 36,
  drag = false,
  style,
}: ColumnHeaderStripProps) {
  // Window drag — Tauri v2 startDragging. Skip when the click lands on an
  // interactive child so buttons / inputs still work. Mirrors TitleBar.tsx.
  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('kbd') ||
      target.closest('[data-no-drag]')
    ) {
      return;
    }
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startDragging();
    } catch {
      // Not in Tauri — ignore (browser mode)
    }
  }, []);

  return (
    <div
      data-chrome-surface="true"
      data-stationary-chrome="true"
      data-tauri-drag-region={drag ? '' : undefined}
      onMouseDown={drag ? handleMouseDown : undefined}
      style={{
        height,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 8,
        paddingRight: 8,
        background: 'var(--t-chrome, transparent)',
        borderBottom: '0.5px solid var(--t-divider-subtle)',
        color: 'var(--t-text)',
        position: 'relative',
        boxSizing: 'border-box',
        minWidth: 0,
        overflow: 'hidden',
        ['WebkitAppRegion' as string]: drag ? 'drag' : 'no-drag',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
        {left}
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
        {center}
      </div>
      {/* Right slot stays overflow:visible — its buttons use marginTop:-3 to
          nudge up, which pokes 3px above the auto-sized wrapper; a hidden
          wrapper clipped the top of their rounded hover fill (operator:
          "cut off at the top … when I hover"). The strip root still clips at
          its own 36px bounds, so nothing bleeds past the strip. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, minWidth: 0, overflow: 'visible' }}>
        {right}
      </div>
    </div>
  );
}
