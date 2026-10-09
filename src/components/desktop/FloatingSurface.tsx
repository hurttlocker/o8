'use client';

import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';
import { SmoothCorners } from '@lisse/react';
import { useTheme } from '@/lib/theme/context';
import { isWebMachineBrowserSurface } from '@/lib/connect/web-machine-surface';
import { isNonMacShell } from '@/lib/desktop/host-platform';
import { WORKSPACE_RAIL_CORNER_RADIUS, WORKSPACE_RAIL_CORNER_SMOOTHING } from './branch-rail-geometry';

/** Shared floating treatment for the rail's usage hover, menus and drawers. */
export const FloatingSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  glass?: boolean;
  contentStyle?: CSSProperties;
}>(function FloatingSurface({ glass, style, contentStyle, children, ...props }, ref) {
  const { workspaceGlass, surface, paletteId } = useTheme();
  const isGlass = glass ?? (!isWebMachineBrowserSurface() && !isNonMacShell() && (workspaceGlass || surface === 'glass'));
  return <div {...props} ref={ref} style={{
    border: `1px solid ${isGlass ? 'var(--t-border)' : 'var(--t-divider-subtle)'}`,
    borderRadius: WORKSPACE_RAIL_CORNER_RADIUS,
    boxShadow: '0 18px 48px rgba(15, 23, 42, 0.32), 0 4px 14px rgba(15, 23, 42, 0.16)',
    color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)',
    ...(isGlass && (workspaceGlass || paletteId === 'dark') ? { '--t-text': '#e8ecf2', '--t-text-secondary': '#bcc5d0', '--t-text-muted': '#8b95a3' } : {}),
    ...style,
  } as CSSProperties}>
    <SmoothCorners corners={{ radius: typeof style?.borderRadius === 'number' ? style.borderRadius : WORKSPACE_RAIL_CORNER_RADIUS, smoothing: WORKSPACE_RAIL_CORNER_SMOOTHING }}
      autoEffects={false} style={{ ...contentStyle, background: isGlass ? 'var(--t-bg)' : 'var(--t-panel-solid)',
        backdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
        WebkitBackdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined }}>
      {children}
    </SmoothCorners>
  </div>;
});
