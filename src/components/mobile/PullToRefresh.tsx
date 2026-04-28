'use client';

import { type CSSProperties, type ReactNode } from 'react';
import { usePullToRefresh } from '@/lib/mobile/use-pull-to-refresh';

interface PullToRefreshProps {
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  threshold?: number;
  maxPull?: number;
  /** When false the gesture is disabled (e.g. while a sheet is open). */
  enabled?: boolean;
  /** Extra style applied to the wrapping <div>. */
  style?: CSSProperties;
}

export function PullToRefresh({
  onRefresh,
  children,
  threshold = 64,
  maxPull = 120,
  enabled = true,
  style,
}: PullToRefreshProps) {
  const { containerRef, pullDistance, refreshing, isPulling, isTriggered, progress } = usePullToRefresh({
    onRefresh,
    threshold,
    maxPull,
    enabled,
  });

  return (
    <div
      ref={containerRef}
      data-no-pull-refresh={refreshing ? 'true' : undefined}
      style={style}
    >
      {/* Floating indicator pinned to the top of the viewport */}
      <div style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 50px)',
        left: '50%',
        transform: `translateX(-50%) translateY(${Math.max(pullDistance - 20, 0)}px)`,
        zIndex: 50,
        opacity: progress > 0.1 ? Math.min(progress * 1.5, 1) : 0,
        transition: isPulling ? 'none' : 'all 300ms cubic-bezier(0.22, 1, 0.36, 1)',
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
            // Arrow that rotates as you pull, locks once threshold is crossed.
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke={isTriggered ? '#007aff' : 'rgba(0,122,255,0.5)'}
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{
                transform: `rotate(${progress * 180}deg)`,
                transition: isPulling ? 'none' : 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
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
