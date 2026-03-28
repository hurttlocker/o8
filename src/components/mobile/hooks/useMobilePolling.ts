'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  loadOwnedReviewPacketForSession,
  loadReviewFilePreview,
  loadSessionHistory,
  refreshInboxSnapshot,
} from '../controller';
import {
  computePollingTier,
  startUnifiedSyncPolling,
  trackVisibilityRefresh,
} from '../effects';
import type { MobileState } from './useMobileState';

/**
 * Manages all data-fetching: history loading, review packets, review files,
 * unified sync polling, visibility-based refresh.
 */
export function useMobilePolling(state: MobileState, wsConnected: boolean, includeOpenClaw: boolean) {
  const {
    snapshot, setSnapshot,
    selectedSessionKey, selectedSession,
    isOwnedCodexSession,
    historyBySession, historyBySessionRef, historyLoading,
    setHistoryLoading, setHistoryBySession, setHistoryGroupsBySession, setHistoryError,
    reviewPacketBySession, reviewPacketLoadingBySession,
    setReviewPacketLoadingBySession, setReviewPacketBySession, setReviewPacketErrorBySession,
    reviewFileByPath, setReviewFileLoadingPath, setReviewFileError, setReviewFileByPath,
    selectedReviewFilePath, setSelectedReviewFilePath,
    setRefreshError,
    pendingOwnedTurnBySession, actionStateBySession,
    waitingForResponse, setWaitingForResponse, diffOpen,
    lastAssistantCountRef,
    documentVisibleRef,
  } = state;

  const refreshInbox = useCallback(
    (fresh = false) => refreshInboxSnapshot({ setSnapshot, setRefreshError, includeOpenClaw, fresh }),
    [includeOpenClaw, setRefreshError, setSnapshot],
  );

  const loadHistory = useCallback(
    (sessionKey: string, force = false) => loadSessionHistory({
      sessionKey,
      force,
      historyBySession,
      setHistoryLoading,
      setHistoryBySession,
      setHistoryGroupsBySession,
      setHistoryError,
    }),
    [historyBySession, setHistoryBySession, setHistoryError, setHistoryGroupsBySession, setHistoryLoading],
  );

  const loadOwnedReviewPacket = useCallback(
    (sessionKey: string, force = false) => loadOwnedReviewPacketForSession({
      sessionKey,
      force,
      reviewPacketBySession,
      setReviewPacketLoadingBySession,
      setReviewPacketBySession,
      setReviewPacketErrorBySession,
    }),
    [reviewPacketBySession, setReviewPacketBySession, setReviewPacketErrorBySession, setReviewPacketLoadingBySession],
  );

  const loadReviewFile = useCallback(
    (reviewPath: string, force = false) => loadReviewFilePreview({
      reviewPath,
      force,
      reviewFileByPath,
      setReviewFileLoadingPath,
      setReviewFileError,
      setReviewFileByPath,
    }),
    [reviewFileByPath, setReviewFileByPath, setReviewFileError, setReviewFileLoadingPath],
  );

  const rawReviewFiles = useMemo(() => {
    return isOwnedCodexSession
      ? state.selectedReviewPacket?.changedFiles ?? []
      : snapshot.review?.changedFiles ?? [];
  }, [isOwnedCodexSession, state.selectedReviewPacket, snapshot.review?.changedFiles]);

  // Sticky fallback: keep the last non-empty review file list.
  // Uses a state-based fallback instead of reading stickyReviewFilesRef during render (#195).
  const [stickyReviewFiles, setStickyReviewFiles] = useState(rawReviewFiles);
  /* eslint-disable react-hooks/set-state-in-effect -- sticky diff file list intentionally persists the last usable review set */
  useEffect(() => {
    if (!rawReviewFiles.length) return;
    setStickyReviewFiles((current) => {
      if (
        current.length === rawReviewFiles.length
        && current.every((file, index) => (
          file.path === rawReviewFiles[index]?.path
          && file.status === rawReviewFiles[index]?.status
          && file.additions === rawReviewFiles[index]?.additions
          && file.deletions === rawReviewFiles[index]?.deletions
        ))
      ) {
        return current;
      }
      return rawReviewFiles;
    });
  }, [rawReviewFiles]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const reviewFiles = rawReviewFiles.length ? rawReviewFiles : stickyReviewFiles;

  // Load history for selected session on first mount
  useEffect(() => {
    if (!selectedSessionKey) return;
    if (!historyBySession[selectedSessionKey]?.length && !historyLoading[selectedSessionKey]) {
      void loadHistory(selectedSessionKey).catch(() => undefined);
    }
  }, [historyBySession, historyLoading, loadHistory, selectedSessionKey]);

  // Load owned review packet
  useEffect(() => {
    if (!selectedSessionKey || !selectedSessionKey.startsWith('codex-owned:')) return;
    if (!reviewPacketBySession[selectedSessionKey] && !reviewPacketLoadingBySession[selectedSessionKey]) {
      void loadOwnedReviewPacket(selectedSessionKey).catch(() => undefined);
    }
  }, [loadOwnedReviewPacket, reviewPacketBySession, reviewPacketLoadingBySession, selectedSessionKey]);

  // Track review file selection
  useEffect(() => {
    if (!reviewFiles.length) {
      setSelectedReviewFilePath(null);
      setReviewFileError(null);
      return;
    }
    if (selectedReviewFilePath && reviewFiles.some((file) => file.path === selectedReviewFilePath)) return;
    const nextPath = reviewFiles[0]?.path ?? null;
    setSelectedReviewFilePath(nextPath);
    if (nextPath) {
      void loadReviewFile(nextPath).catch(() => undefined);
    }
  }, [loadReviewFile, reviewFiles, selectedReviewFilePath, setSelectedReviewFilePath, setReviewFileError]);

  // Visibility-based refresh
  useEffect(() => {
    return trackVisibilityRefresh({
      documentVisibleRef,
      selectedSessionKey,
      loadHistory,
      refreshInbox,
    });
  }, [loadHistory, refreshInbox, selectedSessionKey, documentVisibleRef]);

  // Linked owned session (discovered → owned mapping)
  const linkedOwnedKey = useMemo(() => {
    if (!selectedSession || selectedSession.runtime !== 'codex' || selectedSession.runtimeSurface?.ownership !== 'discovered') return null;
    const cwd = selectedSession.runtimeSurface?.cwd ?? selectedSession.workspace ?? '';
    const owned = snapshot.sessions.find((s) =>
      s.runtime === 'codex' &&
      s.runtimeSurface?.ownership === 'owned' &&
      (s.runtimeSurface?.cwd === cwd || s.workspace === cwd),
    );
    return owned?.sessionKey ?? null;
  }, [selectedSession, snapshot.sessions]);

  // Initial linked history load
  useEffect(() => {
    if (linkedOwnedKey && !historyBySession[linkedOwnedKey] && !historyLoading[linkedOwnedKey]) {
      void loadHistory(linkedOwnedKey, true).catch(() => undefined);
    }
  }, [linkedOwnedKey, historyBySession, historyLoading, loadHistory]);

  // ── Unified sync polling (#193) ──
  // Compute a stable polling tier so the effect only restarts when the
  // actual polling speed needs to change, not on ordinary state churn.
  const pollingTier = computePollingTier({
    wsConnected,
    selectedSessionKey,
    selectedSession,
    pendingOwnedTurnBySession,
    actionStateBySession,
    waitingForResponse,
  });

  // Refs for values that the tick function reads but that should NOT restart the timer
  const pollingTierRef = useRef(pollingTier);
  useEffect(() => { pollingTierRef.current = pollingTier; }, [pollingTier]);
  const selectedSessionKeyRef = useRef(selectedSessionKey);
  useEffect(() => { selectedSessionKeyRef.current = selectedSessionKey; }, [selectedSessionKey]);
  const linkedOwnedKeyRef = useRef(linkedOwnedKey);
  useEffect(() => { linkedOwnedKeyRef.current = linkedOwnedKey; }, [linkedOwnedKey]);
  const diffOpenRef = useRef(diffOpen);
  useEffect(() => { diffOpenRef.current = diffOpen; }, [diffOpen]);
  const selectedReviewFilePathRef = useRef(selectedReviewFilePath);
  useEffect(() => { selectedReviewFilePathRef.current = selectedReviewFilePath; }, [selectedReviewFilePath]);
  const loadOwnedReviewPacketRef = useRef(loadOwnedReviewPacket);
  useEffect(() => { loadOwnedReviewPacketRef.current = loadOwnedReviewPacket; }, [loadOwnedReviewPacket]);

  useEffect(() => {
    return startUnifiedSyncPolling({
      pollingTier,
      selectedSessionKey,
      linkedOwnedKey,
      diffOpen,
      selectedReviewFilePath,
      documentVisibleRef,
      historyBySessionRef,
      pollingTierRef,
      selectedSessionKeyRef,
      linkedOwnedKeyRef,
      diffOpenRef,
      selectedReviewFilePathRef,
      setSnapshot,
      setRefreshError,
      setHistoryBySession,
      setHistoryGroupsBySession,
      setReviewFileByPath,
      loadOwnedReviewPacketRef,
    });
  }, [
    pollingTier,
    // Only these stable values restart the timer:
    setSnapshot, setRefreshError, setHistoryBySession, setHistoryGroupsBySession, setReviewFileByPath,
    documentVisibleRef, historyBySessionRef,
    // Refs are stable (same identity)
    pollingTierRef, selectedSessionKeyRef, linkedOwnedKeyRef,
    diffOpenRef, selectedReviewFilePathRef, loadOwnedReviewPacketRef,
    // These are still in deps for the initial sync (effect only re-runs when pollingTier changes):
    selectedSessionKey, linkedOwnedKey, diffOpen, selectedReviewFilePath,
  ]);

  // Pre-fetch adjacent session history during idle (#46 optimistic rendering)
  useEffect(() => {
    if (!selectedSessionKey || !snapshot.sessions.length) return;
    const currentIndex = snapshot.sessions.findIndex((s) => s.sessionKey === selectedSessionKey);
    if (currentIndex < 0) return;

    // Gather up to 2 adjacent sessions that haven't been loaded yet
    const adjacentKeys: string[] = [];
    for (const offset of [1, -1]) {
      const idx = currentIndex + offset;
      if (idx >= 0 && idx < snapshot.sessions.length) {
        const key = snapshot.sessions[idx].sessionKey;
        if (key && !historyBySession[key]?.length && !historyLoading[key]) {
          adjacentKeys.push(key);
        }
      }
    }
    if (adjacentKeys.length === 0) return;

    // Use requestIdleCallback (or setTimeout fallback) to pre-fetch during idle
    const idleCallback = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback
      : (cb: () => void) => window.setTimeout(cb, 2000);
    const cancelIdle = typeof window.cancelIdleCallback === 'function'
      ? window.cancelIdleCallback
      : (id: number) => window.clearTimeout(id);

    const id = idleCallback(() => {
      for (const key of adjacentKeys) {
        void loadHistory(key).catch(() => undefined);
      }
    });
    return () => cancelIdle(id);
  }, [selectedSessionKey, snapshot.sessions, historyBySession, historyLoading, loadHistory]);

  useEffect(() => {
    if (!selectedSessionKey || !waitingForResponse) return;
    const assistantCount = (historyBySession[selectedSessionKey] ?? []).filter((entry) => entry.role === 'assistant').length;
    if (assistantCount > lastAssistantCountRef.current) {
      setWaitingForResponse(false);
    }
  }, [selectedSessionKey, waitingForResponse, historyBySession, lastAssistantCountRef, setWaitingForResponse]);

  return {
    refreshInbox,
    loadHistory,
    loadOwnedReviewPacket,
    loadReviewFile,
    reviewFiles,
    stickyReviewFiles,
    linkedOwnedKey,
  };
}
