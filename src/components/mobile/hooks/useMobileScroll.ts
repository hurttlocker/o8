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
    transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [stickToBottomRef, transcriptBottomRef]);

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
      stickToBottomRef,
    });
  }, [pendingOwnedTurn, scrollMarker, selectedSessionKey, transcriptEntries, transcriptGroups, initialBottomPinBySessionRef, transcriptBottomRef, stickToBottomRef]);

  return {
    isWindowNearBottom,
    scrollToLatestMessage,
  };
}
