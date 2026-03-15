'use client';

import { useEffect } from 'react';
import type { MobileState } from './useMobileState';
import { useWebSocket } from './useWebSocket';

/**
 * Manages WebSocket connection + response waiting state.
 */
export function useMobileStreaming(state: MobileState) {
  const {
    selectedSessionKey,
    setSnapshot, setRefreshError,
    setHistoryBySession,
    setStreamingText, streamingTextRef,
    waitingForResponse, setWaitingForResponse,
    lastAssistantCountRef,
    seenMessageIdsRef,
    setHydrated,
  } = state;

  // WebSocket connection
  const { connectionState: wsConnectionState } = useWebSocket({
    selectedSessionKey,
    setSnapshot,
    setRefreshError,
    setHistoryBySession,
    setStreamingText,
    streamingTextRef,
  });

  const wsConnected = wsConnectionState === 'connected';

  // Hydration + seen message tracking
  useEffect(() => {
    if (!seenMessageIdsRef.current) {
      // Initialize on first mount — not inside render
      seenMessageIdsRef.current = new Set();
    }
    setHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    wsConnected,
    wsConnectionState,
  };
}
