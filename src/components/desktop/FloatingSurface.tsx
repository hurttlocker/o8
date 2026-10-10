'use client';

import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';
import { SmoothCorners } from '@lisse/react';
import { useTheme } from '@/lib/theme/context';
import { isWebMachineBrowserSurface } from '@/lib/connect/web-machine-surface';
import { isNonMacShell } from '@/lib/desktop/host-platform';
import { WORKSPACE_RAIL_CORNER_RADIUS, WORKSPACE_RAIL_CORNER_SMOOTHING } from './branch-rail-geometry';

/** Material shared by floating surfaces that need their own corner geometry. */
export function useFloatingSurfaceMaterial(glass?: boolean) {
  const { workspaceGlass, surface, paletteId } = useTheme();
  const isGlass = glass ?? (!isWebMachineBrowserSurface() && !isNonMacShell() && (workspaceGlass || surface === 'glass'));
  return {
    isGlass,
    borderColor: isGlass ? 'var(--t-border)' : 'var(--t-divider-subtle)',
    shadow: '0 18px 48px rgba(15, 23, 42, 0.32), 0 4px 14px rgba(15, 23, 42, 0.16)',
    textStyle: {
      color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)',
      ...(isGlass && (workspaceGlass || paletteId === 'dark') ? { '--t-text': '#e8ecf2', '--t-text-secondary': '#bcc5d0', '--t-text-muted': '#8b95a3' } : {}),
    } as CSSProperties,
    surfaceStyle: {
      background: isGlass ? 'var(--t-bg)' : 'var(--t-panel-solid)',
      backdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
      WebkitBackdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
    } as CSSProperties,
  };
}

/** Shared floating treatment for the rail's usage hover, menus and drawers. */
export const FloatingSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  glass?: boolean;
  contentStyle?: CSSProperties;
}>(function FloatingSurface({ glass, style, contentStyle, children, ...props }, ref) {
  const material = useFloatingSurfaceMaterial(glass);
  return <div {...props} ref={ref} style={{
    border: `1px solid ${material.borderColor}`,
    borderRadius: WORKSPACE_RAIL_CORNER_RADIUS,
    boxShadow: material.shadow,
    ...material.textStyle,
    ...style,
  } as CSSProperties}>
    <SmoothCorners corners={{ radius: typeof style?.borderRadius === 'number' ? style.borderRadius : WORKSPACE_RAIL_CORNER_RADIUS, smoothing: WORKSPACE_RAIL_CORNER_SMOOTHING }}
      autoEffects={false} style={{ ...contentStyle, ...material.surfaceStyle }}>
      {children}
    </SmoothCorners>
  </div>;
});
