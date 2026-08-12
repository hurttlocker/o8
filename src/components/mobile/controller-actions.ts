/**
 * controller-actions.ts — Surface actions: run action, review disposition, copy, refresh, focus, stop, diff
 */
import type {
  Dispatch,
  SetStateAction,
} from 'react';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import { requestConfirm } from '@/components/shared/ConfirmToastHost';
import type {
  MobileActionRequest,
  MobileActionResponse,
  MobileInboxSnapshot,
  MobileReviewFileResponse,
} from '@/lib/mobile/types';
import type {
  ActionState,
  CompactLine,
} from './types';
import { fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { readJson } from './utils';

// ── Run action ──

interface RunActionArgs {
  payload: MobileActionRequest;
  setActionStateBySession: Dispatch<SetStateAction<Record<string, ActionState>>>;
  setActionNoteBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
  realtimeEnabled?: boolean;
  refreshInbox: (fresh?: boolean) => Promise<MobileInboxSnapshot>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
}

export async function runMobileAction({
  payload,
  setActionStateBySession,
  setActionNoteBySession,
  realtimeEnabled = false,
  refreshInbox,
  loadHistory,
  loadOwnedReviewPacket,
}: RunActionArgs) {
  const sessionKey = payload.sessionKey;
  const nextState: ActionState = payload.action === 'stop'
    ? 'stopping'
    : payload.action === 'watch' || payload.action === 'resolve' || payload.action === 'approve' || payload.action === 'deny'
      ? 'reviewing'
      : 'steering';

  setActionStateBySession((current) => ({ ...current, [sessionKey]: nextState }));

  let receiptSettled = false;
  try {
    const receipt = await fetchCorrelatedActionReceipt<MobileActionResponse>('/api/mobile/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    receiptSettled = true;
    if (!receipt.response.ok || !receipt.payload) {
      return await readJson<MobileActionResponse>(new Response(
        receipt.payload ? JSON.stringify(receipt.payload) : null,
        { status: receipt.response.status },
      ));
    }
    const result = receipt.payload;
    setActionNoteBySession((current) => ({ ...current, [sessionKey]: result.note }));
    globalThis.setTimeout(() => {
      setActionNoteBySession((current) => (current[sessionKey] === result.note ? { ...current, [sessionKey]: null } : current));
    }, 3000);
    if (!realtimeEnabled) {
      await refreshInbox();
      await loadHistory(sessionKey, true).catch(() => undefined);
      if (sessionKey.startsWith('codex-owned:')) {
        await loadOwnedReviewPacket(sessionKey, true).catch(() => undefined);
      }
    }
    return result;
  } finally {
    if (receiptSettled) {
      setActionStateBySession((current) => ({ ...current, [sessionKey]: 'idle' }));
    }
  }
}

// ── Review disposition ──

interface OptimisticDispositionArgs {
  sessionKey: string;
  disposition: RuntimeReviewPacket['reviewDisposition'];
  setReviewPacketBySession: Dispatch<SetStateAction<Record<string, RuntimeReviewPacket>>>;
}

export function setOwnedReviewDispositionOptimistically({
  sessionKey,
  disposition,
  setReviewPacketBySession,
}: OptimisticDispositionArgs) {
  const updatedAt = new Date().toISOString();
  setReviewPacketBySession((current) => {
    const existing = current[sessionKey];
    if (!existing) return current;
    return {
      ...current,
      [sessionKey]: {
        ...existing,
        reviewDisposition: disposition,
        reviewDispositionUpdatedAt: updatedAt,
        reviewDispositionUpdatedAtLabel: 'Just now',
      },
    };
  });
}

interface ReviewDispositionArgs {
  action: 'watch' | 'resolve';
  sessionKey: string;
  reviewPacketBySession: Record<string, RuntimeReviewPacket>;
  setReviewPacketBySession: Dispatch<SetStateAction<Record<string, RuntimeReviewPacket>>>;
  setActionNoteBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
  runAction: (payload: MobileActionRequest) => Promise<MobileActionResponse | undefined>;
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
}

export async function updateOwnedReviewDisposition({
  action,
  sessionKey,
  reviewPacketBySession,
  setReviewPacketBySession,
  setActionNoteBySession,
  setSurfaceNote,
  runAction,
  loadOwnedReviewPacket,
}: ReviewDispositionArgs) {
  const previousPacket = reviewPacketBySession[sessionKey];
  const nextDisposition = action === 'resolve' ? 'resolved' : 'watching';

  if (previousPacket) {
    setOwnedReviewDispositionOptimistically({ sessionKey, disposition: nextDisposition, setReviewPacketBySession });
  }

  setActionNoteBySession((current) => ({
    ...current,
    [sessionKey]: action === 'resolve' ? 'Marking resolved…' : 'Switching to watching…',
  }));

  try {
    const result = await runAction({ action, sessionKey });
    setSurfaceNote(result?.note ?? null);
  } catch (error) {
    if (previousPacket) {
      setReviewPacketBySession((current) => ({ ...current, [sessionKey]: previousPacket }));
    }
    void loadOwnedReviewPacket(sessionKey, true).catch(() => undefined);
    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: error instanceof Error ? error.message : 'Unable to update the owned review state from mobile.',
    }));
  }
}

// ── Clipboard ──

interface CopyTextArgs {
  text: string;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
}

export function copyTextToClipboard({ text, setSurfaceNote }: CopyTextArgs) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    setSurfaceNote('Clipboard is not available on this browser.');
    return;
  }
  void navigator.clipboard.writeText(text).then(() => {
    setSurfaceNote('Copied to clipboard.');
  }).catch(() => {
    setSurfaceNote('Could not copy to the clipboard.');
  });
}

// ── Surface refresh ──

interface RefreshSurfaceArgs {
  selectedSessionKey: string | undefined;
  selectedReviewFilePath: string | null;
  refreshInbox: (fresh?: boolean) => Promise<MobileInboxSnapshot>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
  loadReviewFile: (reviewPath: string, force?: boolean) => Promise<MobileReviewFileResponse['file'] | undefined>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
}

export async function refreshMobileSurface({
  selectedSessionKey,
  selectedReviewFilePath,
  refreshInbox,
  loadHistory,
  loadOwnedReviewPacket,
  loadReviewFile,
  setSurfaceNote,
}: RefreshSurfaceArgs) {
  try {
    const nextSnapshot = await refreshInbox();
    const nextSessionKey = selectedSessionKey
      ?? nextSnapshot.primarySessionKey
      ?? nextSnapshot.sessions.find((session) => session.isCurrentSession)?.sessionKey
      ?? nextSnapshot.sessions[0]?.sessionKey;
    let nextReviewPath = selectedReviewFilePath;

    if (nextSessionKey) {
      await loadHistory(nextSessionKey, true).catch(() => undefined);
      if (nextSessionKey.startsWith('codex-owned:')) {
        const packet = await loadOwnedReviewPacket(nextSessionKey, true).catch(() => null);
        nextReviewPath = nextReviewPath ?? packet?.changedFiles[0]?.path ?? null;
      } else {
        nextReviewPath = nextReviewPath ?? nextSnapshot.review?.changedFiles[0]?.path ?? null;
      }
    }
    if (nextReviewPath) {
      await loadReviewFile(nextReviewPath, true).catch(() => undefined);
    }
    setSurfaceNote('Refreshed.');
  } catch (error) {
    setSurfaceNote(error instanceof Error ? error.message : 'Unable to refresh the mobile surface right now.');
    throw error;
  }
}

// ── Session focus ──

interface FocusSessionArgs {
  sessionId: string;
  snapshot: MobileInboxSnapshot;
  compactLine: CompactLine;
  setSelection: Dispatch<SetStateAction<{
    id: string;
    sessionKey: string;
    fallback: MobileInboxSnapshot['sessions'][number] | null;
  }>>;
  setActiveView: (view: 'chat') => void;
  setControlsOpen: Dispatch<SetStateAction<boolean>>;
  setDiffOpen: Dispatch<SetStateAction<boolean>>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
  setSelectedReviewFilePath: Dispatch<SetStateAction<string | null>>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
  loadReviewFile: (reviewPath: string, force?: boolean) => Promise<MobileReviewFileResponse['file'] | undefined>;
}

export function focusSessionSurface({
  sessionId,
  snapshot,
  compactLine,
  setSelection,
  setActiveView,
  setControlsOpen,
  setDiffOpen,
  setSurfaceNote,
  setSelectedReviewFilePath,
  loadHistory,
  loadOwnedReviewPacket,
  loadReviewFile,
}: FocusSessionArgs) {
  const nextSession = snapshot.sessions.find((session) => session.id === sessionId || session.sessionKey === sessionId);
  if (!nextSession?.sessionKey) return;

  console.info('[mobile] focusing session', {
    requestedSessionRef: sessionId,
    resolvedId: nextSession.id,
    resolvedSessionKey: nextSession.sessionKey,
  });

  setSelection({
    id: nextSession.id,
    sessionKey: nextSession.sessionKey,
    fallback: nextSession,
  });
  setActiveView('chat');
  setControlsOpen(false);
  setDiffOpen(false);
  setSurfaceNote(`Focused ${compactLine(nextSession.name, 'the selected session', 40)}.`);

  void (async () => {
    await loadHistory(nextSession.sessionKey, true).catch(() => undefined);
    if (!nextSession.sessionKey.startsWith('codex-owned:')) return;
    const packet = await loadOwnedReviewPacket(nextSession.sessionKey).catch(() => null);
    const nextPath = packet?.changedFiles[0]?.path;
    if (!nextPath) return;
    setSelectedReviewFilePath(nextPath);
    await loadReviewFile(nextPath).catch(() => undefined);
  })();
}

// ── Stop/interrupt ──

interface StopRunArgs {
  selectedSessionKey?: string;
  isChatSession: boolean;
  canInterruptOwnedCodex: boolean;
  isOwnedCodexSession: boolean;
  runAction: (payload: MobileActionRequest) => Promise<MobileActionResponse | undefined>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
  setControlsOpen: Dispatch<SetStateAction<boolean>>;
}

export async function stopActiveRunFromSurface({
  selectedSessionKey,
  isChatSession,
  canInterruptOwnedCodex,
  isOwnedCodexSession,
  runAction,
  setSurfaceNote,
  setControlsOpen,
}: StopRunArgs) {
  if (!selectedSessionKey) return;
  if (!isChatSession && !canInterruptOwnedCodex) {
    setSurfaceNote('No active run to interrupt right now.');
    return;
  }
  if (!(await requestConfirm({ title: isOwnedCodexSession ? 'Interrupt the active owned Codex run?' : 'Stop the active run for this session?', confirmLabel: isOwnedCodexSession ? 'Interrupt' : 'Stop', danger: true }))) return;

  try {
    const result = await runAction({ action: 'stop', sessionKey: selectedSessionKey });
    setSurfaceNote(result?.note ?? null);
    setControlsOpen(false);
  } catch (error) {
    setSurfaceNote(error instanceof Error ? error.message : isOwnedCodexSession ? 'Unable to interrupt the owned Codex run from mobile.' : 'Unable to stop the active run from mobile.');
  }
}

// ── Diff viewer ──

interface OpenDiffArgs {
  reviewFiles: RuntimeReviewPacket['changedFiles'];
  selectedReviewFilePath: string | null;
  reviewFileByPath: Record<string, MobileReviewFileResponse['file']>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
  setSelectedReviewFilePath: Dispatch<SetStateAction<string | null>>;
  setControlsOpen: Dispatch<SetStateAction<boolean>>;
  setDiffOpen: Dispatch<SetStateAction<boolean>>;
  loadReviewFile: (reviewPath: string, force?: boolean) => Promise<MobileReviewFileResponse['file'] | undefined>;
}

export function openDiffViewerForSession({
  reviewFiles,
  selectedReviewFilePath,
  reviewFileByPath,
  setSurfaceNote,
  setSelectedReviewFilePath,
  setControlsOpen,
  setDiffOpen,
  loadReviewFile,
}: OpenDiffArgs) {
  if (!reviewFiles.length) {
    setSurfaceNote('No active diff to review right now.');
    return;
  }
  const nextPath = selectedReviewFilePath ?? reviewFiles[0]?.path ?? null;
  if (nextPath) {
    setSelectedReviewFilePath(nextPath);
    if (!reviewFileByPath[nextPath]) {
      void loadReviewFile(nextPath).catch(() => undefined);
    }
  }
  setControlsOpen(false);
  setDiffOpen(true);
}
