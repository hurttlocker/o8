'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Horizontal swipe-to-action gesture for mobile cards.
 *
 * Tracks finger drag, surfaces a translateX value (with rubber-band past
 * threshold), and fires `onCommit` when the user releases past the threshold.
 * Vertical drags pass through to the page so list scroll still works.
 *
 * The hook does NOT auto-fire the destructive action — `onCommit` is meant to
 * land you in a confirmation strip. The caller decides what to do after that.
 */

export type SwipeSide = 'left' | 'right';

export interface UseSwipeActionOptions {
  /** Pixel distance the user must drag before the gesture latches. */
  threshold?: number;
  /** Min horizontal/vertical ratio before we claim the gesture from the page. */
  horizontalDominance?: number;
  /** Called when the user releases past the threshold (no auto-action). */
  onCommit?: (side: SwipeSide) => void;
  /** Called once per gesture as the threshold is first crossed (haptic tick). */
  onThresholdCross?: (side: SwipeSide) => void;
  /** Disable the gesture (e.g. while a confirmation strip is open). */
  disabled?: boolean;
}

export interface UseSwipeActionResult {
  /** Pointer handlers to spread on the swipe wrapper. */
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  };
  /** Current horizontal offset to apply via translate3d. */
  offset: number;
  /** Which side is currently being revealed (null when at rest). */
  side: SwipeSide | null;
  /** True once the user has dragged past the threshold. */
  pastThreshold: boolean;
  /** True while a finger is on the card actively swiping. */
  swiping: boolean;
  /** Reset to rest position (use after committing or cancelling). */
  reset: () => void;
}

const DEFAULT_THRESHOLD = 80;
const DEFAULT_HORIZONTAL_DOMINANCE = 1.4;
const RUBBER_BAND_FACTOR = 0.35;

export function useSwipeAction(options: UseSwipeActionOptions = {}): UseSwipeActionResult {
  const {
    threshold = DEFAULT_THRESHOLD,
    horizontalDominance = DEFAULT_HORIZONTAL_DOMINANCE,
    onCommit,
    onThresholdCross,
    disabled = false,
  } = options;

  const [offset, setOffset] = useState(0);
  const [side, setSide] = useState<SwipeSide | null>(null);
  const [pastThreshold, setPastThreshold] = useState(false);
  const [swiping, setSwiping] = useState(false);

  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const activeIdRef = useRef<number | null>(null);
  const lockedAxisRef = useRef<'horizontal' | 'vertical' | null>(null);
  const thresholdHitRef = useRef(false);

  const reset = useCallback(() => {
    setOffset(0);
    setSide(null);
    setPastThreshold(false);
    setSwiping(false);
    activeIdRef.current = null;
    lockedAxisRef.current = null;
    thresholdHitRef.current = false;
  }, []);

  // If the consumer flips `disabled` on (e.g. confirmation strip opens),
  // freeze whatever offset/side we ended on — the consumer is responsible for
  // the visual after that point. Calling reset() on disable would double-jump.
  useEffect(() => {
    if (disabled) {
      activeIdRef.current = null;
      lockedAxisRef.current = null;
      setSwiping(false);
    }
  }, [disabled]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    // Only respond to primary button / single touch. Mouse right-click etc. ignored.
    if (event.button !== undefined && event.button !== 0) return;
    activeIdRef.current = event.pointerId;
    startXRef.current = event.clientX;
    startYRef.current = event.clientY;
    lockedAxisRef.current = null;
    thresholdHitRef.current = false;
    setSwiping(true);
  }, [disabled]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (activeIdRef.current !== event.pointerId) return;

    const dx = event.clientX - startXRef.current;
    const dy = event.clientY - startYRef.current;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Decide axis once we've moved more than ~10px so we don't compete with
    // the page scroller on a near-vertical drag.
    if (lockedAxisRef.current === null) {
      if (absDx < 10 && absDy < 10) return;
      if (absDx > absDy * horizontalDominance) {
        lockedAxisRef.current = 'horizontal';
        // Capture the pointer so we keep getting moves even if the finger
        // wanders out of the card bounds.
        try {
          (event.target as Element & { setPointerCapture?: (id: number) => void })
            .setPointerCapture?.(event.pointerId);
        } catch {
          // Some test environments / older browsers throw — ignore.
        }
      } else {
        // Vertical-dominant — let the page scroll, abandon the gesture.
        lockedAxisRef.current = 'vertical';
        setSwiping(false);
        activeIdRef.current = null;
        return;
      }
    }

    if (lockedAxisRef.current !== 'horizontal') return;

    // Apply rubber-band past the threshold so dragging way past it still
    // visually responds without flying off the card.
    let displayed = dx;
    const overshoot = absDx - threshold;
    if (overshoot > 0) {
      const sign = dx >= 0 ? 1 : -1;
      displayed = sign * (threshold + overshoot * RUBBER_BAND_FACTOR);
    }

    const nextSide: SwipeSide | null = dx > 0 ? 'right' : dx < 0 ? 'left' : null;
    const reachedThreshold = absDx >= threshold;

    setOffset(displayed);
    setSide(nextSide);
    setPastThreshold(reachedThreshold);

    if (reachedThreshold && !thresholdHitRef.current && nextSide) {
      thresholdHitRef.current = true;
      onThresholdCross?.(nextSide);
    } else if (!reachedThreshold && thresholdHitRef.current) {
      // Crossed back under threshold — re-arm so a future re-cross fires again.
      thresholdHitRef.current = false;
    }
  }, [disabled, horizontalDominance, onThresholdCross, threshold]);

  const finalize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (activeIdRef.current !== event.pointerId) return;
    const wasHorizontal = lockedAxisRef.current === 'horizontal';
    const finalSide = side;
    const passed = pastThreshold;

    activeIdRef.current = null;
    lockedAxisRef.current = null;
    setSwiping(false);

    if (wasHorizontal && passed && finalSide) {
      // Hand off to the consumer — caller decides whether to snap back, hold
      // open as a confirmation strip, etc.
      onCommit?.(finalSide);
      return;
    }

    // Partial swipe — snap back.
    setOffset(0);
    setSide(null);
    setPastThreshold(false);
    thresholdHitRef.current = false;
  }, [onCommit, pastThreshold, side]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    finalize(event);
  }, [disabled, finalize]);

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    // Treat a cancel (e.g. browser interrupted the gesture) as a snap-back.
    if (activeIdRef.current !== event.pointerId) return;
    activeIdRef.current = null;
    lockedAxisRef.current = null;
    setOffset(0);
    setSide(null);
    setPastThreshold(false);
    setSwiping(false);
    thresholdHitRef.current = false;
  }, [disabled]);

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    offset,
    side,
    pastThreshold,
    swiping,
    reset,
  };
}

/** Safe `navigator.vibrate` wrapper — silent no-op on unsupported browsers. */
export function mobileSwipeVibrate(pattern: number | number[]) {
  if (typeof navigator === 'undefined') return;
  if (typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some PWAs gate vibrate behind a user gesture — silently ignore.
  }
}
