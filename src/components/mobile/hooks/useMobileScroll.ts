'use client';

import { useCallback, useEffect, useLayoutEffect } from 'react';
import type { MobileTranscriptEntry, MobileRuntimeTailGroup } from '@/lib/mobile/types';
import type { PendingOwnedTurn } from '../types';
import {
  pinTranscriptToBottom,
  trackScrollChrome,
  trackViewportTopOffset,
} from '../effects';
import type { MobileState } from './useMobileState';

/**
 * Manages scroll behavior: viewport offset tracking, scroll chrome (header show/hide),
 * scroll-to-bottom pinning, and utility functions.
 */
export function useMobileScroll(state: MobileState, transcriptEntries: MobileTranscriptEntry[], transcriptGroups: MobileRuntimeTailGroup[], pendingOwnedTurn: PendingOwnedTurn | null, scrollMarker: string) {
  const {
    setViewportTopOffset,
    setScrollY, setIsScrolling, setHeaderVisible,
    scrollStopTimerRef, headerRevealTimerRef,
    stickToBottomRef, transcriptBottomRef,
    initialBottomPinBySessionRef,
    selectedSessionKey,
  } = state;

  const isWindowNearBottom = useCallback((threshold = 160) => {
    if (typeof window === 'undefined') return true;
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const viewportBottom = scrollTop + window.innerHeight;
    const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    return documentHeight - viewportBottom <= threshold;
  }, []);

  const scrollToLatestMessage = useCallback((force = false) => {
    if (typeof window === 'undefined') return;
    if (!force && !stickToBottomRef.current) return;
    if (force) stickToBottomRef.current = true;

    // Use scrollTo with scrollHeight — scrollIntoView breaks with virtual
    // scrolling because the document height grows as items render during
    // the smooth animation, causing it to land halfway.
    const scrollToAbsoluteBottom = () => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    };
    scrollToAbsoluteBottom();

    // After the smooth scroll settles and the virtualizer has rendered
    // newly-visible items (which may increase scrollHeight), do a final
    // jump to guarantee we're actually at the bottom.
    const retryId = window.setTimeout(() => {
      const distanceFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      if (distanceFromBottom > 10) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      }
    }, 400);

    // One more check for very long transcripts where virtualizer is still
    // catching up after the first retry.
    const finalId = window.setTimeout(() => {
      const distanceFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      if (distanceFromBottom > 10) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      }
    }, 900);

    // Cleanup is best-effort — these are fire-and-forget corrective scrolls
    void retryId;
    void finalId;
  }, [stickToBottomRef]);

  useEffect(() => {
    return trackViewportTopOffset({ setViewportTopOffset });
  }, [setViewportTopOffset]);

  useEffect(() => {
    return trackScrollChrome({
      setScrollY,
      setIsScrolling,
      setHeaderVisible,
      scrollStopTimerRef,
      headerRevealTimerRef,
      stickToBottomRef,
      isWindowNearBottom,
    });
  }, [isWindowNearBottom, setScrollY, setIsScrolling, setHeaderVisible, scrollStopTimerRef, headerRevealTimerRef, stickToBottomRef]);

  useLayoutEffect(() => {
    return pinTranscriptToBottom({
      selectedSessionKey,
      transcriptEntries,
      transcriptGroups,
      pendingOwnedTurn,
      initialBottomPinBySessionRef,
      transcriptBottomRef,
    });
  }, [pendingOwnedTurn, scrollMarker, selectedSessionKey, transcriptEntries, transcriptGroups, initialBottomPinBySessionRef, transcriptBottomRef]);

  return {
    isWindowNearBottom,
    scrollToLatestMessage,
  };
}
