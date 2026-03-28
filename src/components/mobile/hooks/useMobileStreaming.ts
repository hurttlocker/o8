'use client';

import { useEffect } from 'react';
import type { MobileState } from './useMobileState';
import { useWebSocket } from './useWebSocket';

/**
 * Manages WebSocket connection + response waiting state.
 */
export function useMobileStreaming(state: MobileState, includeOpenClaw: boolean) {
  const {
    selectedSessionKey,
    selectedSession,
    setSnapshot, setRefreshError,
    setHistoryBySession,
    setStreamingText, streamingTextRef,
    setActionStateBySession,
    setActionNoteBySession,
    setRealtimeMutationsById,
    setPendingMutationIdBySession,
    pendingMutationIdBySessionRef,
    seenMessageIdsRef,
    setHydrated,
  } = state;

  // WebSocket connection
  const {
    connectionState: wsConnectionState,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
  } = useWebSocket({
    selectedSessionKey,
    includeOpenClaw,
    setSnapshot,
    setRefreshError,
    setHistoryBySession,
    setStreamingText,
    streamingTextRef,
    setActionStateBySession,
    setActionNoteBySession,
    setRealtimeMutationsById,
    setPendingMutationIdBySession,
    pendingMutationIdBySessionRef,
  });

  const wsConnected = wsConnectionState === 'connected';

  useEffect(() => {
    const tmuxSession = selectedSession?.tmuxSession;
    const supportsSlashRelay = Boolean(
      tmuxSession && (selectedSession?.runtime === 'codex' || selectedSession?.runtime === 'claude-code'),
    );
    if (!supportsSlashRelay || !tmuxSession) return;

    sendTerminalAttach(tmuxSession, 120, 32);
    return () => {
      sendTerminalDetach(tmuxSession);
    };
  }, [selectedSession?.runtime, selectedSession?.tmuxSession, sendTerminalAttach, sendTerminalDetach]);

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
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalAttach,
    sendTerminalDetach,
  };
}
