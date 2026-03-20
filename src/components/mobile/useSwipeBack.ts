'use client';

import { useRef, useEffect, useCallback } from 'react';

/**
 * Swipe right from the left edge to navigate back.
 * Returns nothing — just calls onBack when gesture completes.
 */
export function useSwipeBack(onBack: () => void, enabled = true) {
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const swipingRef = useRef(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!enabled) return;
    const touch = e.touches[0];
    // Only start if touch begins within 24px of left edge
    if (touch.clientX > 24) return;
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    swipingRef.current = true;
  }, [enabled]);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (!swipingRef.current) return;
    swipingRef.current = false;

    const touch = e.changedTouches[0];
    const dx = touch.clientX - startXRef.current;
    const dy = Math.abs(touch.clientY - startYRef.current);

    // Swipe right at least 80px, and more horizontal than vertical
    if (dx > 80 && dx > dy * 1.5) {
      onBack();
    }
  }, [onBack]);

  useEffect(() => {
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchEnd]);
}
