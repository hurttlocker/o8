'use client';

import { useCallback, useEffect, useMemo } from 'react';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileReviewFileResponse,
} from '@/lib/mobile/types';
import {
  loadOwnedReviewPacketForSession,
  loadReviewFilePreview,
  loadSessionHistory,
  refreshInboxSnapshot,
} from '../controller';
import {
  startUnifiedSyncPolling,
  trackVisibilityRefresh,
} from '../effects';
import type { MobileState } from './useMobileState';

/**
 * Manages all data-fetching: history loading, review packets, review files,
 * unified sync polling, visibility-based refresh.
 */
export function useMobilePolling(state: MobileState, wsConnected: boolean) {
  const {
    snapshot, setSnapshot,
    selectedSessionKey, selectedSession,
    isOwnedCodexSession,
    historyBySession, historyLoading,
    setHistoryLoading, setHistoryBySession, setHistoryGroupsBySession, setHistoryError,
    reviewPacketBySession, reviewPacketLoadingBySession,
    setReviewPacketLoadingBySession, setReviewPacketBySession, setReviewPacketErrorBySession,
    reviewFileByPath, setReviewFileLoadingPath, setReviewFileError, setReviewFileByPath,
    selectedReviewFilePath, setSelectedReviewFilePath,
    stickyReviewFilesRef,
    setRefreshError,
    pendingOwnedTurnBySession, actionStateBySession,
    waitingForResponse, diffOpen,
    documentVisibleRef,
  } = state;

  const refreshInbox = useCallback(
    () => refreshInboxSnapshot({ setSnapshot, setRefreshError }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
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
    [historyBySession], // eslint-disable-line react-hooks/exhaustive-deps
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
    [reviewPacketBySession], // eslint-disable-line react-hooks/exhaustive-deps
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
    [reviewFileByPath], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const reviewFiles = useMemo(() => {
    const next = isOwnedCodexSession
      ? state.selectedReviewPacket?.changedFiles ?? []
      : snapshot.review?.changedFiles ?? [];
    if (next.length) {
      stickyReviewFilesRef.current = next;
      return next;
    }
    return stickyReviewFilesRef.current;
  }, [isOwnedCodexSession, state.selectedReviewPacket, snapshot.review?.changedFiles, stickyReviewFilesRef]);

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

  // Unified sync polling
  useEffect(() => {
    return startUnifiedSyncPolling({
      selectedSessionKey,
      selectedSession,
      linkedOwnedKey,
      pendingOwnedTurnBySession,
      actionStateBySession,
      waitingForResponse,
      diffOpen,
      selectedReviewFilePath,
      documentVisibleRef,
      historyBySession,
      wsConnected,
      setSnapshot,
      setRefreshError,
      setHistoryBySession,
      setHistoryGroupsBySession,
      setReviewFileByPath,
      loadOwnedReviewPacket,
    });
  }, [
    actionStateBySession, diffOpen, historyBySession, linkedOwnedKey,
    loadOwnedReviewPacket, pendingOwnedTurnBySession, selectedReviewFilePath,
    selectedSession, selectedSessionKey, waitingForResponse, wsConnected,
    setSnapshot, setRefreshError, setHistoryBySession, setHistoryGroupsBySession, setReviewFileByPath,
    documentVisibleRef,
  ]);

  return {
    refreshInbox,
    loadHistory,
    loadOwnedReviewPacket,
    loadReviewFile,
    reviewFiles,
    linkedOwnedKey,
  };
}
