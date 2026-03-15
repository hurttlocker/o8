import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react';
import type { RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileActionRequest,
  MobileActionResponse,
  MobileHistoryResponse,
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileRuntimeTailGroup,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
import type {
  ActionState,
  CompactLine,
  DraftAttachment,
  PendingOwnedTurn,
  SessionSummary,
} from './types';
import { buildOwnedCorrectionDraft, fileToDataUrl, readJson } from './utils';

const mobileClockFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

// ── Consolidated sync ──

interface SyncRequest {
  inbox?: { etag?: string };
  history?: { sessionKey: string; sinceId?: string; limit?: number };
  review?: { sessionKey?: string; includeFile?: string };
  linked?: { sessionKey: string; sinceId?: string };
}

interface SyncResponse {
  inbox?: MobileInboxSnapshot | null;
  inboxEtag?: string;
  history?: { sessionKey: string; entries: MobileTranscriptEntry[] };
  review?: { file?: MobileReviewFileResponse['file'] };
  linked?: { sessionKey: string; entries: MobileTranscriptEntry[] };
  serverTime: string;
  errors?: Record<string, string>;
}

let cachedInboxEtag: string | undefined;

interface MobileSyncArgs {
  // What to request
  wantInbox: boolean;
  historySessionKey?: string;
  historyLastId?: string;
  reviewFilePath?: string;
  linkedSessionKey?: string;
  linkedLastId?: string;
  // State setters
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setHistoryGroupsBySession: Dispatch<SetStateAction<Record<string, MobileRuntimeTailGroup[]>>>;
  setReviewFileByPath: Dispatch<SetStateAction<Record<string, MobileReviewFileResponse['file']>>>;
}

export async function mobileSyncOnce({
  wantInbox,
  historySessionKey,
  historyLastId,
  reviewFilePath,
  linkedSessionKey,
  linkedLastId,
  setSnapshot,
  setRefreshError,
  setHistoryBySession,
  setHistoryGroupsBySession,
  setReviewFileByPath,
}: MobileSyncArgs): Promise<SyncResponse | null> {
  const body: SyncRequest = {};
  if (wantInbox) body.inbox = { etag: cachedInboxEtag };
  if (historySessionKey) body.history = { sessionKey: historySessionKey, sinceId: historyLastId, limit: 18 };
  if (reviewFilePath) body.review = { includeFile: reviewFilePath };
  if (linkedSessionKey) body.linked = { sessionKey: linkedSessionKey, sinceId: linkedLastId };

  // Nothing to sync
  if (!body.inbox && !body.history && !body.review && !body.linked) return null;

  try {
    const response = await fetch('/api/mobile/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`sync HTTP ${response.status}`);
    const data = (await response.json()) as SyncResponse;

    // Apply inbox
    if (data.inboxEtag) cachedInboxEtag = data.inboxEtag;
    if (data.inbox) {
      setSnapshot((prev) => {
        const prevKey = prev.sessions.map((s) => `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`).join('|');
        const nextKey = data.inbox!.sessions.map((s) => `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`).join('|');
        if (prevKey === nextKey && prev.summary.alerts === data.inbox!.summary.alerts) return prev;
        return data.inbox!;
      });
      setRefreshError(null);
    }

    // Apply history
    if (data.history && data.history.entries.length > 0) {
      const sk = data.history.sessionKey;
      const newEntries = data.history.entries;
      setHistoryBySession((current) => {
        const prev = current[sk] ?? [];
        if (historyLastId) {
          // Delta mode: append new entries
          const existingIds = new Set(prev.map((e) => e.id));
          const genuinelyNew = newEntries.filter((e) => !existingIds.has(e.id));
          if (genuinelyNew.length === 0) return current;
          return { ...current, [sk]: [...prev, ...genuinelyNew] };
        }
        // Full mode
        if (
          prev.length === newEntries.length
          && prev.length > 0
          && prev[prev.length - 1]?.id === newEntries[newEntries.length - 1]?.id
          && prev[prev.length - 1]?.text === newEntries[newEntries.length - 1]?.text
        ) return current;
        return { ...current, [sk]: newEntries };
      });
    }

    // Apply review file
    if (data.review?.file && reviewFilePath) {
      setReviewFileByPath((current) => ({ ...current, [reviewFilePath]: data.review!.file as MobileReviewFileResponse['file'] }));
    }

    // Apply linked history
    if (data.linked && data.linked.entries.length > 0 && linkedSessionKey) {
      const sk = data.linked.sessionKey;
      const newEntries = data.linked.entries;
      setHistoryBySession((current) => {
        const prev = current[sk] ?? [];
        if (linkedLastId) {
          const existingIds = new Set(prev.map((e) => e.id));
          const genuinelyNew = newEntries.filter((e) => !existingIds.has(e.id));
          if (genuinelyNew.length === 0) return current;
          return { ...current, [sk]: [...prev, ...genuinelyNew] };
        }
        if (
          prev.length === newEntries.length
          && prev.length > 0
          && prev[prev.length - 1]?.id === newEntries[newEntries.length - 1]?.id
        ) return current;
        return { ...current, [sk]: newEntries };
      });
    }

    return data;
  } catch (error) {
    if (wantInbox) {
      setRefreshError(error instanceof Error ? error.message : 'sync failed');
    }
    return null;
  }
}

interface RefreshInboxArgs {
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
}

export async function refreshInboxSnapshot({
  setSnapshot,
  setRefreshError,
}: RefreshInboxArgs) {
  const response = await fetch(`/api/mobile/inbox?_t=${Date.now()}`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const nextSnapshot = (await response.json()) as MobileInboxSnapshot;
  setSnapshot((prev) => {
    const prevKey = prev.sessions.map((session) => `${session.sessionKey}:${session.status}:${Math.round(session.context?.usedPercent ?? 0)}`).join('|');
    const nextKey = nextSnapshot.sessions.map((session) => `${session.sessionKey}:${session.status}:${Math.round(session.context?.usedPercent ?? 0)}`).join('|');
    if (prevKey === nextKey && prev.summary.alerts === nextSnapshot.summary.alerts) {
      return prev;
    }
    return nextSnapshot;
  });
  setRefreshError(null);
  return nextSnapshot;
}

interface LoadHistoryArgs {
  sessionKey: string;
  force?: boolean;
  historyBySession: Record<string, MobileTranscriptEntry[]>;
  setHistoryLoading: Dispatch<SetStateAction<Record<string, boolean>>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setHistoryGroupsBySession: Dispatch<SetStateAction<Record<string, MobileRuntimeTailGroup[]>>>;
  setHistoryError: Dispatch<SetStateAction<Record<string, string | null>>>;
}

export async function loadSessionHistory({
  sessionKey,
  force = false,
  historyBySession,
  setHistoryLoading,
  setHistoryBySession,
  setHistoryGroupsBySession,
  setHistoryError,
}: LoadHistoryArgs) {
  if (!force && historyBySession[sessionKey]?.length) {
    return historyBySession[sessionKey];
  }

  setHistoryLoading((current) => ({ ...current, [sessionKey]: true }));
  try {
    const response = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=18&_t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    const payload = await readJson<MobileHistoryResponse>(response);
    setHistoryBySession((current) => {
      const prev = current[sessionKey] ?? [];
      const next = payload.transcript;
      if (
        prev.length === next.length
        && prev.length > 0
        && prev[prev.length - 1]?.id === next[next.length - 1]?.id
        && prev[prev.length - 1]?.text === next[next.length - 1]?.text
      ) {
        return current;
      }
      const existingIds = new Set(prev.filter((entry) => !entry.id.startsWith('optimistic-')).map((entry) => entry.id));
      const newServerEntries = next.filter((entry) => !existingIds.has(entry.id));
      if (newServerEntries.length === 0 && prev.length >= next.length) {
        return current;
      }
      return { ...current, [sessionKey]: next };
    });
    setHistoryGroupsBySession((current) => {
      const prev = current[sessionKey] ?? [];
      const next = payload.groups ?? [];
      if (prev.length === next.length && prev.length > 0 && prev[prev.length - 1]?.id === next[next.length - 1]?.id) {
        return current;
      }
      return { ...current, [sessionKey]: next };
    });
    setHistoryError((current) => ({ ...current, [sessionKey]: null }));
    return payload.transcript;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load session history';
    setHistoryError((current) => ({ ...current, [sessionKey]: message }));
    throw error;
  } finally {
    setHistoryLoading((current) => ({ ...current, [sessionKey]: false }));
  }
}

interface LoadOwnedPacketArgs {
  sessionKey: string;
  force?: boolean;
  reviewPacketBySession: Record<string, RuntimeReviewPacket>;
  setReviewPacketLoadingBySession: Dispatch<SetStateAction<Record<string, boolean>>>;
  setReviewPacketBySession: Dispatch<SetStateAction<Record<string, RuntimeReviewPacket>>>;
  setReviewPacketErrorBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
}

export async function loadOwnedReviewPacketForSession({
  sessionKey,
  force = false,
  reviewPacketBySession,
  setReviewPacketLoadingBySession,
  setReviewPacketBySession,
  setReviewPacketErrorBySession,
}: LoadOwnedPacketArgs) {
  if (!sessionKey.startsWith('codex-owned:')) {
    return null;
  }
  if (!force && reviewPacketBySession[sessionKey]) {
    return reviewPacketBySession[sessionKey];
  }

  setReviewPacketLoadingBySession((current) => ({ ...current, [sessionKey]: true }));
  try {
    const response = await fetch(`/api/runtime/review?surfaceId=${encodeURIComponent(sessionKey)}`, { cache: 'no-store' });
    const payload = await readJson<RuntimeReviewPacket>(response);
    setReviewPacketBySession((current) => ({ ...current, [sessionKey]: payload }));
    setReviewPacketErrorBySession((current) => ({ ...current, [sessionKey]: null }));
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load the owned review packet.';
    setReviewPacketErrorBySession((current) => ({ ...current, [sessionKey]: message }));
    throw error;
  } finally {
    setReviewPacketLoadingBySession((current) => ({ ...current, [sessionKey]: false }));
  }
}

interface LoadReviewFileArgs {
  reviewPath: string;
  force?: boolean;
  reviewFileByPath: Record<string, MobileReviewFileResponse['file']>;
  setReviewFileLoadingPath: Dispatch<SetStateAction<string | null>>;
  setReviewFileError: Dispatch<SetStateAction<string | null>>;
  setReviewFileByPath: Dispatch<SetStateAction<Record<string, MobileReviewFileResponse['file']>>>;
}

export async function loadReviewFilePreview({
  reviewPath,
  force = false,
  reviewFileByPath,
  setReviewFileLoadingPath,
  setReviewFileError,
  setReviewFileByPath,
}: LoadReviewFileArgs) {
  if (!force && reviewFileByPath[reviewPath]) {
    setReviewFileError(null);
    return reviewFileByPath[reviewPath];
  }

  setReviewFileLoadingPath(reviewPath);
  setReviewFileError(null);
  try {
    const response = await fetch(`/api/mobile/review-file?path=${encodeURIComponent(reviewPath)}`, { cache: 'no-store' });
    const payload = await readJson<MobileReviewFileResponse>(response);
    setReviewFileByPath((current) => ({ ...current, [reviewPath]: payload.file }));
    return payload.file;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load the per-file review preview.';
    setReviewFileError(message);
    throw error;
  } finally {
    setReviewFileLoadingPath((current) => (current === reviewPath ? null : current));
  }
}

interface AttachmentSelectionArgs {
  selectedSessionKey?: string;
  files: FileList | null;
  isChatSession: boolean;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
  setDraftAttachmentsBySession: Dispatch<SetStateAction<Record<string, DraftAttachment[]>>>;
  composeRef: RefObject<HTMLTextAreaElement | null>;
}

export async function prepareImageAttachments({
  selectedSessionKey,
  files,
  isChatSession,
  setSurfaceNote,
  setDraftAttachmentsBySession,
  composeRef,
}: AttachmentSelectionArgs) {
  if (!selectedSessionKey || !files?.length) {
    return;
  }
  if (!isChatSession) {
    setSurfaceNote('Image attachments are only available for chat sessions right now.');
    return;
  }

  const chosenFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
  if (!chosenFiles.length) {
    setSurfaceNote('Only image attachments are supported right now.');
    return;
  }

  try {
    const nextAttachments = await Promise.all(chosenFiles.slice(0, 4).map(async (file, index) => {
      if (file.size > 5_000_000) {
        throw new Error(`${file.name} is too large. Keep image attachments under 5 MB.`);
      }
      const content = await fileToDataUrl(file);
      return {
        id: `${file.name}:${file.lastModified}:${index}`,
        fileName: file.name,
        mimeType: file.type || 'image/png',
        content,
        previewUrl: URL.createObjectURL(file),
      } satisfies DraftAttachment;
    }));

    setDraftAttachmentsBySession((current) => ({
      ...current,
      [selectedSessionKey]: [...(current[selectedSessionKey] ?? []), ...nextAttachments].slice(0, 4),
    }));
    setSurfaceNote(`Attached ${nextAttachments.length} image${nextAttachments.length === 1 ? '' : 's'}.`);
    window.requestAnimationFrame(() => composeRef.current?.focus());
  } catch (error) {
    setSurfaceNote(error instanceof Error ? error.message : 'Unable to prepare these image attachments.');
  }
}

interface RemoveAttachmentArgs {
  sessionKey: string;
  attachmentId: string;
  setDraftAttachmentsBySession: Dispatch<SetStateAction<Record<string, DraftAttachment[]>>>;
}

export function removeImageAttachment({
  sessionKey,
  attachmentId,
  setDraftAttachmentsBySession,
}: RemoveAttachmentArgs) {
  setDraftAttachmentsBySession((current) => {
    const existing = current[sessionKey] ?? [];
    const removed = existing.find((item) => item.id === attachmentId);
    if (removed) {
      URL.revokeObjectURL(removed.previewUrl);
    }
    const remaining = existing.filter((item) => item.id !== attachmentId);
    return {
      ...current,
      [sessionKey]: remaining,
    };
  });
}

interface RunActionArgs {
  payload: MobileActionRequest;
  setActionStateBySession: Dispatch<SetStateAction<Record<string, ActionState>>>;
  setActionNoteBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
  refreshInbox: () => Promise<MobileInboxSnapshot>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  loadOwnedReviewPacket: (sessionKey: string, force?: boolean) => Promise<RuntimeReviewPacket | null | undefined>;
}

export async function runMobileAction({
  payload,
  setActionStateBySession,
  setActionNoteBySession,
  refreshInbox,
  loadHistory,
  loadOwnedReviewPacket,
}: RunActionArgs) {
  const sessionKey = payload.sessionKey;
  const nextState: ActionState = payload.action === 'stop'
    ? 'stopping'
    : payload.action === 'watch' || payload.action === 'resolve'
      ? 'reviewing'
      : 'steering';

  setActionStateBySession((current) => ({ ...current, [sessionKey]: nextState }));

  try {
    const response = await fetch('/api/mobile/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await readJson<MobileActionResponse>(response);
    setActionNoteBySession((current) => ({ ...current, [sessionKey]: result.note }));
    window.setTimeout(() => {
      setActionNoteBySession((current) => (current[sessionKey] === result.note ? { ...current, [sessionKey]: null } : current));
    }, 3000);
    await refreshInbox();
    await loadHistory(sessionKey, true).catch(() => undefined);
    if (sessionKey.startsWith('codex-owned:')) {
      await loadOwnedReviewPacket(sessionKey, true).catch(() => undefined);
    }
    return result;
  } finally {
    setActionStateBySession((current) => ({ ...current, [sessionKey]: 'idle' }));
  }
}

interface EnhancePromptArgs {
  selectedSessionKey?: string;
  enhancing: boolean;
  draftBySession: Record<string, string>;
  setEnhancing: Dispatch<SetStateAction<boolean>>;
  setPreEnhanceDraft: Dispatch<SetStateAction<string | null>>;
  setDraftBySession: Dispatch<SetStateAction<Record<string, string>>>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
}

export async function enhancePromptDraft({
  selectedSessionKey,
  enhancing,
  draftBySession,
  setEnhancing,
  setPreEnhanceDraft,
  setDraftBySession,
  setSurfaceNote,
}: EnhancePromptArgs) {
  if (!selectedSessionKey || enhancing) return;
  const raw = draftBySession[selectedSessionKey]?.trim();
  if (!raw || raw.length < 3) return;

  setEnhancing(true);
  setPreEnhanceDraft(raw);
  try {
    const res = await fetch('/api/mobile/enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: raw }),
    });
    if (!res.ok) throw new Error('enhance failed');
    const { enhanced } = await res.json();
    if (enhanced && typeof enhanced === 'string') {
      setDraftBySession((current) => ({ ...current, [selectedSessionKey]: enhanced }));
    }
  } catch {
    setSurfaceNote('Enhancement failed — original prompt kept');
    setPreEnhanceDraft(null);
  } finally {
    setEnhancing(false);
  }
}

interface SteerSubmitArgs {
  sessionKey: string;
  actionStateBySession: Record<string, ActionState>;
  snapshot: MobileInboxSnapshot;
  draftBySession: Record<string, string>;
  draftAttachmentsBySession: Record<string, DraftAttachment[]>;
  transcriptEntries: MobileTranscriptEntry[];
  lastAssistantCountRef: MutableRefObject<number>;
  setWaitingForResponse: Dispatch<SetStateAction<boolean>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setDraftBySession: Dispatch<SetStateAction<Record<string, string>>>;
  setDraftAttachmentsBySession: Dispatch<SetStateAction<Record<string, DraftAttachment[]>>>;
  setPreEnhanceDraft: Dispatch<SetStateAction<string | null>>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
  setActionNoteBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  runAction: (payload: MobileActionRequest) => Promise<MobileActionResponse | undefined>;
  refreshInbox: () => Promise<MobileInboxSnapshot>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  playSendClick: () => void;
}

export async function submitSteerTurn({
  sessionKey,
  actionStateBySession,
  snapshot,
  draftBySession,
  draftAttachmentsBySession,
  transcriptEntries,
  lastAssistantCountRef,
  setWaitingForResponse,
  setHistoryBySession,
  setDraftBySession,
  setDraftAttachmentsBySession,
  setPreEnhanceDraft,
  setSurfaceNote,
  setActionNoteBySession,
  setSelectedId,
  runAction,
  refreshInbox,
  loadHistory,
  playSendClick,
}: SteerSubmitArgs) {
  if (actionStateBySession[sessionKey] === 'steering') return;

  const targetSession = snapshot.sessions.find((session) => session.sessionKey === sessionKey);
  const isDiscoveredCodex = targetSession?.runtime === 'codex' && targetSession?.runtimeSurface?.ownership === 'discovered';
  const isOwnedCodex = targetSession?.runtime === 'codex' && targetSession?.runtimeSurface?.ownership === 'owned';
  const isChat = targetSession?.runtime === 'openclaw' || isDiscoveredCodex || isOwnedCodex;
  if (!isChat) {
    setActionNoteBySession((current) => ({ ...current, [sessionKey]: 'Cannot send to this session type.' }));
    return;
  }

  const message = draftBySession[sessionKey]?.trim();
  const attachments = draftAttachmentsBySession[sessionKey] ?? [];
  if (!message && attachments.length === 0) {
    setActionNoteBySession((current) => ({ ...current, [sessionKey]: 'Type a message or attach an image first.' }));
    return;
  }

  playSendClick();
  lastAssistantCountRef.current = transcriptEntries.filter((entry) => entry.role === 'assistant').length;
  setWaitingForResponse(true);

  const optimisticEntry: MobileTranscriptEntry = {
    id: `optimistic-${Date.now()}`,
    role: 'user',
    text: message ?? '',
    media: attachments.length > 0
      ? attachments.map((attachment) => ({ kind: 'image' as const, path: attachment.previewUrl, name: attachment.fileName }))
      : undefined,
    timestampLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  };
  setHistoryBySession((current) => ({
    ...current,
    [sessionKey]: [...(current[sessionKey] ?? []), optimisticEntry],
  }));

  setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
  setDraftAttachmentsBySession((current) => ({ ...current, [sessionKey]: [] }));
  setPreEnhanceDraft(null);
  attachments.forEach((item) => {
    URL.revokeObjectURL(item.previewUrl);
  });
  setSurfaceNote(
    attachments.length > 0
      ? `Sent with ${attachments.length} image${attachments.length === 1 ? '' : 's'}.`
      : 'Sent.',
  );

  try {
    if (isDiscoveredCodex) {
      const cwd = targetSession?.runtimeSurface?.cwd ?? targetSession?.workspace ?? '';
      const existingOwned = snapshot.sessions.find((session) =>
        session.runtime === 'codex'
        && session.runtimeSurface?.ownership === 'owned'
        && (session.runtimeSurface?.cwd === cwd || session.workspace === cwd)
        && session.runtimeSurface?.lifecycle?.availability === 'ready-for-resume',
      );

      if (existingOwned) {
        await runAction({
          action: 'resume' as MobileActionRequest['action'],
          sessionKey: existingOwned.sessionKey,
          message,
        });
        setSelectedId(existingOwned.id);
        setSurfaceNote('Resuming Codex session…');
        await loadHistory(existingOwned.sessionKey, true).catch(() => undefined);
      } else {
        const launchResult = await runAction({
          action: 'launch' as MobileActionRequest['action'],
          sessionKey,
          message,
          cwd,
        });
        if (launchResult?.ok && launchResult.sessionKey && launchResult.sessionKey !== sessionKey) {
          setSurfaceNote('Codex launched — switching to session…');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const freshInbox = await refreshInbox();
          const newSession = freshInbox.sessions.find((session) => session.sessionKey === launchResult.sessionKey);
          if (newSession) {
            setSelectedId(newSession.id);
            await loadHistory(launchResult.sessionKey, true).catch(() => undefined);
          }
        } else {
          setSurfaceNote('Codex session launched.');
        }
      }
    } else if (isOwnedCodex) {
      await runAction({
        action: 'resume' as MobileActionRequest['action'],
        sessionKey,
        message,
      });
      setSurfaceNote('Sent to Codex…');
    } else {
      await runAction({
        action: 'steer',
        sessionKey,
        message,
        attachments: attachments.map((item) => ({
          type: 'image',
          mimeType: item.mimeType,
          fileName: item.fileName,
          content: item.content,
        })),
      });
    }
  } catch (error) {
    setDraftBySession((current) => ({ ...current, [sessionKey]: message ?? '' }));
    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: error instanceof Error ? error.message : 'Failed to send. Message restored.',
    }));
  }
}

interface LoadCorrectionDraftArgs {
  sessionKey: string;
  reviewPacketBySession: Record<string, RuntimeReviewPacket>;
  setDraftBySession: Dispatch<SetStateAction<Record<string, string>>>;
  setActionNoteBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
  composeRef: RefObject<HTMLTextAreaElement | null>;
}

export function loadOwnedCorrectionDraftForSession({
  sessionKey,
  reviewPacketBySession,
  setDraftBySession,
  setActionNoteBySession,
  composeRef,
}: LoadCorrectionDraftArgs) {
  const packet = reviewPacketBySession[sessionKey];
  if (!packet) {
    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: 'Review packet is still loading. Refresh and try again.',
    }));
    return;
  }

  setDraftBySession((current) => ({
    ...current,
    [sessionKey]: buildOwnedCorrectionDraft(packet),
  }));
  setActionNoteBySession((current) => ({
    ...current,
    [sessionKey]: 'Loaded correction draft from review packet.',
  }));
  window.requestAnimationFrame(() => composeRef.current?.focus());
}

interface OwnedResumeArgs {
  sessionKey: string;
  actionStateBySession: Record<string, ActionState>;
  draftBySession: Record<string, string>;
  setActionNoteBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
  setPendingOwnedTurnBySession: Dispatch<SetStateAction<Record<string, PendingOwnedTurn>>>;
  setDraftBySession: Dispatch<SetStateAction<Record<string, string>>>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
  runAction: (payload: MobileActionRequest) => Promise<MobileActionResponse | undefined>;
  playSendClick: () => void;
}

export async function submitOwnedResumeTurn({
  sessionKey,
  actionStateBySession,
  draftBySession,
  setActionNoteBySession,
  setPendingOwnedTurnBySession,
  setDraftBySession,
  setSurfaceNote,
  runAction,
  playSendClick,
}: OwnedResumeArgs) {
  if (actionStateBySession[sessionKey] === 'steering') return;

  const message = draftBySession[sessionKey]?.trim();
  if (!message) {
    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: 'Write an instruction or load the correction draft first.',
    }));
    return;
  }

  playSendClick();

  const pendingTurn: PendingOwnedTurn = {
    id: `pending-${Date.now()}`,
    prompt: message,
    createdAt: Date.now(),
    timestampLabel: mobileClockFormatter.format(new Date()),
  };

  setPendingOwnedTurnBySession((current) => ({
    ...current,
    [sessionKey]: pendingTurn,
  }));
  setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
  setSurfaceNote('Turn queued.');

  try {
    await runAction({ action: 'resume', sessionKey, message });
  } catch (error) {
    setPendingOwnedTurnBySession((current) => {
      if (!current[sessionKey]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionKey];
      return next;
    });
    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: error instanceof Error ? error.message : 'Unable to resume the owned Codex session from mobile.',
    }));
  }
}

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
    if (!existing) {
      return current;
    }
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
    setOwnedReviewDispositionOptimistically({
      sessionKey,
      disposition: nextDisposition,
      setReviewPacketBySession,
    });
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

interface RefreshSurfaceArgs {
  selectedSessionKey: string | undefined;
  selectedReviewFilePath: string | null;
  refreshInbox: () => Promise<MobileInboxSnapshot>;
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

interface FocusSessionArgs {
  sessionId: string;
  snapshot: MobileInboxSnapshot;
  compactLine: CompactLine;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setActiveView: Dispatch<SetStateAction<'squad' | 'chat' | 'costs'>>;
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
  setSelectedId,
  setActiveView,
  setControlsOpen,
  setDiffOpen,
  setSurfaceNote,
  setSelectedReviewFilePath,
  loadHistory,
  loadOwnedReviewPacket,
  loadReviewFile,
}: FocusSessionArgs) {
  const nextSession = snapshot.sessions.find((session) => session.id === sessionId);
  if (!nextSession?.sessionKey) {
    return;
  }

  setSelectedId(sessionId);
  setActiveView('chat');
  setControlsOpen(false);
  setDiffOpen(false);
  setSurfaceNote(`Focused ${compactLine(nextSession.name, 'the selected session', 40)}.`);

  void (async () => {
    await loadHistory(nextSession.sessionKey).catch(() => undefined);
    if (!nextSession.sessionKey.startsWith('codex-owned:')) {
      return;
    }
    const packet = await loadOwnedReviewPacket(nextSession.sessionKey).catch(() => null);
    const nextPath = packet?.changedFiles[0]?.path;
    if (!nextPath) {
      return;
    }
    setSelectedReviewFilePath(nextPath);
    await loadReviewFile(nextPath).catch(() => undefined);
  })();
}

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
  if (!selectedSessionKey) {
    return;
  }
  if (!isChatSession && !canInterruptOwnedCodex) {
    setSurfaceNote('No active run to interrupt right now.');
    return;
  }
  if (!window.confirm(isOwnedCodexSession ? 'Interrupt the active owned Codex run?' : 'Stop the active run for this session?')) {
    return;
  }

  try {
    const result = await runAction({ action: 'stop', sessionKey: selectedSessionKey });
    setSurfaceNote(result?.note ?? null);
    setControlsOpen(false);
  } catch (error) {
    setSurfaceNote(error instanceof Error ? error.message : isOwnedCodexSession ? 'Unable to interrupt the owned Codex run from mobile.' : 'Unable to stop the active run from mobile.');
  }
}

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
