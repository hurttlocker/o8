'use client';

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  threshold?: number;
  maxPull?: number;
}

export function PullToRefresh({
  onRefresh,
  children,
  threshold = 64,
  maxPull = 120,
}: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const handleTouchStart = useCallback((e: TouchEvent) => {
    // Only start pull if at the top of the scroll
    if (window.scrollY > 5 || refreshing || shouldIgnoreTarget(e.target)) return;
    startYRef.current = e.touches[0].clientY;
    pullingRef.current = true;
    setIsPulling(true);
  }, [refreshing, shouldIgnoreTarget]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!pullingRef.current || refreshing) return;

    const currentY = e.touches[0].clientY;
    const diff = currentY - startYRef.current;

    if (diff < 0) {
      // Scrolling up, cancel pull
      pullingRef.current = false;
      setIsPulling(false);
      setPullDistance(0);
      return;
    }

    // Rubber band resistance — pull gets harder
    const resistance = 1 - Math.min(diff / (maxPull * 2.5), 0.65);
    const distance = Math.min(diff * resistance, maxPull);

    if (distance > 4) {
      e.preventDefault(); // Prevent native scroll while pulling
    }

    setPullDistance(distance);
  }, [refreshing, maxPull]);

  const handleTouchEnd = useCallback(async () => {
    if (!pullingRef.current) return;
    pullingRef.current = false;
    setIsPulling(false);

    if (pullDistance >= threshold && !refreshing) {
      setRefreshing(true);
      setPullDistance(threshold * 0.6); // Snap to loading position
      try {
        await onRefresh();
      } catch {
        // Swallow refresh errors
      }
      setRefreshing(false);
    }

    setPullDistance(0);
  }, [pullDistance, threshold, refreshing, onRefresh]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const progress = Math.min(pullDistance / threshold, 1);
  const isTriggered = pullDistance >= threshold;

  return (
    <div ref={containerRef} data-no-pull-refresh={refreshing ? 'true' : undefined}>
      {/* Pull indicator */}
      <div style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 50px)',
        left: '50%',
        transform: `translateX(-50%) translateY(${Math.max(pullDistance - 20, 0)}px)`,
        zIndex: 50,
        opacity: progress > 0.1 ? Math.min(progress * 1.5, 1) : 0,
        transition: isPulling ? 'none' : 'all 300ms cubic-bezier(0.32, 0.72, 0, 1)',
        pointerEvents: 'none',
      }}>
        <div style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'rgba(0,122,255,0.08)',
          backdropFilter: 'blur(20px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
          border: '1px solid rgba(0,122,255,0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(0,122,255,0.12)',
        }}>
          {refreshing ? (
            // Spinning loader
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="#007aff" strokeWidth="2.5" strokeLinecap="round"
              style={{ animation: 'spin 0.8s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            // Arrow that rotates as you pull
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke={isTriggered ? '#007aff' : 'rgba(0,122,255,0.5)'}
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{
                transform: `rotate(${progress * 180}deg)`,
                transition: isPulling ? 'none' : 'transform 200ms ease',
              }}>
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          )}
        </div>
      </div>

      {children}
    </div>
  );
}
