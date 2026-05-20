'use client';

/**
 * useTabBarVisibility — gates the workspace's top tab bar on window width.
 *
 * Above the breakpoint the left rail is wide enough to fully serve as
 * the primary nav surface, so the top tabs disappear. Below it, the
 * top tabs return as a fallback so narrow screens still expose every
 * open session.
 *
 * Threshold and listener are window-level (not container) so resize
 * latency stays predictable across tile layouts.
 */

import { useEffect, useState } from 'react';

const DEFAULT_BREAKPOINT_PX = 1100;

export interface UseTabBarVisibilityOptions {
  breakpointPx?: number;
}

export function useTabBarVisibility(options?: UseTabBarVisibilityOptions): { widthAllowsTabs: boolean } {
  const breakpoint = options?.breakpointPx ?? DEFAULT_BREAKPOINT_PX;
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setNarrow(window.innerWidth < breakpoint);
    };
    onResize();
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);

  return { widthAllowsTabs: narrow };
}
