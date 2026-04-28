'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface UsePullToRefreshOptions {
  /** Async refresh callback. Errors are swallowed so the spinner always retracts. */
  onRefresh: () => Promise<void> | void;
  /** Pull distance (px) at which the gesture commits on release. Default 64. */
  threshold?: number;
  /** Maximum visual pull distance after rubber-band resistance. Default 120. */
  maxPull?: number;
  /** When false the gesture is fully disabled (listeners still attach but no-op). */
  enabled?: boolean;
}

export interface UsePullToRefreshResult {
  /** Attach this ref to the element that wraps the pulled content. Touch listeners bind here. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Current pull distance in pixels (already rubber-banded, capped at maxPull). */
  pullDistance: number;
  /** True while the refresh callback is awaiting. */
  refreshing: boolean;
  /** True from the first touch until release while the user is actively pulling. */
  isPulling: boolean;
  /** True once pullDistance has crossed the threshold for the current gesture. */
  isTriggered: boolean;
  /** 0..1 normalized progress for indicator rotation/opacity. */
  progress: number;
}

/**
 * iOS-friendly pull-to-refresh gesture hook.
 *
 * Attaches `touchstart` / `touchmove` / `touchend` listeners to the element
 * pointed to by `containerRef`. The gesture only fires when:
 *   1. The window is at scrollTop ≈ 0
 *   2. No nested scroll container is mid-scroll
 *   3. The touch target isn't a form control or `[data-no-pull-refresh]`
 *
 * On the first frame past `threshold`, `navigator.vibrate(10)` fires once
 * (haptic tick) and the state flips to `isTriggered: true`. On release at
 * or past threshold the hook awaits `onRefresh()` and retracts. The pull
 * uses a rubber-band curve that gets harder past `maxPull / 2.5`.
 *
 * The hook deliberately stays vanilla (no framer-motion) so it can be
 * dropped into iOS PWA contexts where overscroll gestures get swallowed.
 */
export function usePullToRefresh({
  onRefresh,
  threshold = 64,
  maxPull = 120,
  enabled = true,
}: UsePullToRefreshOptions): UsePullToRefreshResult {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);
  const triggeredRef = useRef(false);
  const refreshingRef = useRef(false);

  // Mirror state into refs so the latest values are visible inside the
  // touch handlers without forcing them to re-bind every render.
  useEffect(() => {
    refreshingRef.current = refreshing;
  }, [refreshing]);

  const shouldIgnoreTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.closest('textarea, input, button, a, select, [role="dialog"], [data-no-pull-refresh]')) {
      return true;
    }

    let current: HTMLElement | null = target;
    while (current && current !== document.body) {
      const styles = window.getComputedStyle(current);
      const canScrollY = /(auto|scroll)/.test(styles.overflowY);
      if (canScrollY && current.scrollHeight > current.clientHeight && current.scrollTop > 0) {
        return true;
      }
      current = current.parentElement;
    }

    return false;
  }, []);

  const handleTouchStart = useCallback((event: TouchEvent) => {
    if (!enabled) return;
    if (window.scrollY > 5 || refreshingRef.current || shouldIgnoreTarget(event.target)) return;
    startYRef.current = event.touches[0].clientY;
    pullingRef.current = true;
    triggeredRef.current = false;
    setIsPulling(true);
  }, [enabled, shouldIgnoreTarget]);

  const handleTouchMove = useCallback((event: TouchEvent) => {
    if (!pullingRef.current || refreshingRef.current) return;

    const currentY = event.touches[0].clientY;
    const diff = currentY - startYRef.current;

    if (diff < 0) {
      // Scrolling up cancels the pull.
      pullingRef.current = false;
      triggeredRef.current = false;
      setIsPulling(false);
      setPullDistance(0);
      return;
    }

    // Rubber band — the further you drag, the harder it gets.
    const resistance = 1 - Math.min(diff / (maxPull * 2.5), 0.65);
    const distance = Math.min(diff * resistance, maxPull);

    if (distance > 4) {
      // Block the underlying scroll while we paint the indicator.
      event.preventDefault();
    }

    // Haptic tick exactly once per gesture, when crossing the threshold.
    if (!triggeredRef.current && distance >= threshold) {
      triggeredRef.current = true;
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate?.(10);
      }
    } else if (triggeredRef.current && distance < threshold) {
      // Slipped back below — allow another tick if user re-crosses.
      triggeredRef.current = false;
    }

    setPullDistance(distance);
  }, [maxPull, threshold]);

  const handleTouchEnd = useCallback(async () => {
    if (!pullingRef.current) return;
    pullingRef.current = false;
    setIsPulling(false);

    const committed = pullDistance >= threshold && !refreshingRef.current;
    triggeredRef.current = false;

    if (committed) {
      setRefreshing(true);
      // Snap to the loading position so the indicator stays visible.
      setPullDistance(threshold * 0.6);
      try {
        await onRefresh();
      } catch {
        // Swallow refresh errors — the spinner always retracts.
      }
      setRefreshing(false);
    }

    setPullDistance(0);
  }, [onRefresh, pullDistance, threshold]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('touchmove', handleTouchMove, { passive: false });
    element.addEventListener('touchend', handleTouchEnd, { passive: true });
    element.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
      element.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const progress = Math.min(pullDistance / threshold, 1);
  const isTriggered = pullDistance >= threshold;

  return {
    containerRef,
    pullDistance,
    refreshing,
    isPulling,
    isTriggered,
    progress,
  };
}
