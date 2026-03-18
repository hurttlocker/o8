/**
 * controller-compose.ts — Compose/submit: attachments, enhance, steer, owned resume, correction draft
 */
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
  MobileInboxSnapshot,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
import type {
  ActionState,
  DraftAttachment,
  PendingOwnedTurn,
} from './types';
import { buildOwnedCorrectionDraft, fileToDataUrl } from './utils';
import { buildSlashTerminalInput, isSlashCommandText } from '@/lib/slash-commands';

const mobileClockFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

// ── Attachments ──

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
  if (!selectedSessionKey || !files?.length) return;
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
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    const remaining = existing.filter((item) => item.id !== attachmentId);
    return { ...current, [sessionKey]: remaining };
  });
}

// ── Enhance ──

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

// ── Steer (send message) ──

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
  relaySlashCommand: (sessionKey: string, commandText: string) => Promise<boolean>;
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
  relaySlashCommand,
}: SteerSubmitArgs) {
  if (actionStateBySession[sessionKey] === 'steering') return;

  const targetSession = snapshot.sessions.find((session) => session.sessionKey === sessionKey);
  const isDiscoveredCodex = targetSession?.runtime === 'codex' && targetSession?.runtimeSurface?.ownership === 'discovered';
  const isOwnedCodex = targetSession?.runtime === 'codex' && targetSession?.runtimeSurface?.ownership === 'owned';
  const isClaudeCode = targetSession?.runtime === 'claude-code';
  const isChat = targetSession?.runtime === 'openclaw' || isDiscoveredCodex || isOwnedCodex || isClaudeCode;
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

  if (message && attachments.length === 0 && isSlashCommandText(message)) {
    const relayed = await relaySlashCommand(sessionKey, buildSlashTerminalInput(message));
    if (relayed) {
      playSendClick();
      const optimisticEntry: MobileTranscriptEntry = {
        id: `optimistic-${Date.now()}`,
        role: 'user',
        text: message,
        timestampLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      };
      setHistoryBySession((current) => ({
        ...current,
        [sessionKey]: [...(current[sessionKey] ?? []), optimisticEntry],
      }));
      setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
      setPreEnhanceDraft(null);
      setWaitingForResponse(false);
      setSurfaceNote('Slash command sent to terminal.');
      return;
    }
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
  attachments.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  setSurfaceNote(
    attachments.length > 0
      ? `Sent with ${attachments.length} image${attachments.length === 1 ? '' : 's'}.`
      : 'Sent.',
  );

  try {
    if (isDiscoveredCodex) {
      // For discovered (running) Codex sessions, send directly via exec resume.
      // The backend uses `codex exec resume <thread-id> <prompt>` to inject
      // the message into the existing conversation.
      if (targetSession?.status === 'running') {
        await runAction({ action: 'resume' as MobileActionRequest['action'], sessionKey, message });
        setSurfaceNote('Sent to Codex…');
      } else {
      // Only launch a new session if the discovered session is NOT running
      const cwd = targetSession?.runtimeSurface?.cwd ?? targetSession?.workspace ?? '';
      const existingOwned = snapshot.sessions.find((session) =>
        session.runtime === 'codex'
        && session.runtimeSurface?.ownership === 'owned'
        && (session.runtimeSurface?.cwd === cwd || session.workspace === cwd)
        && session.runtimeSurface?.lifecycle?.availability === 'ready-for-resume',
      );

      if (existingOwned) {
        await runAction({ action: 'resume' as MobileActionRequest['action'], sessionKey: existingOwned.sessionKey, message });
        setSelectedId(existingOwned.id);
        setSurfaceNote('Resuming Codex session…');
        await loadHistory(existingOwned.sessionKey, true).catch(() => undefined);
      } else {
        const launchResult = await runAction({ action: 'launch' as MobileActionRequest['action'], sessionKey, message, cwd });
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
      } // close outer else (non-running discovered codex)
    } else if (isOwnedCodex || isClaudeCode) {
      await runAction({ action: 'resume' as MobileActionRequest['action'], sessionKey, message });
      setSurfaceNote(isClaudeCode ? 'Sent to Claude Code…' : 'Sent to Codex…');
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

// ── Correction draft ──

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
    setActionNoteBySession((current) => ({ ...current, [sessionKey]: 'Review packet is still loading. Refresh and try again.' }));
    return;
  }
  setDraftBySession((current) => ({ ...current, [sessionKey]: buildOwnedCorrectionDraft(packet) }));
  setActionNoteBySession((current) => ({ ...current, [sessionKey]: 'Loaded correction draft from review packet.' }));
  window.requestAnimationFrame(() => composeRef.current?.focus());
}

// ── Owned resume ──

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
  relaySlashCommand: (sessionKey: string, commandText: string) => Promise<boolean>;
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
  relaySlashCommand,
}: OwnedResumeArgs) {
  if (actionStateBySession[sessionKey] === 'steering') return;

  const message = draftBySession[sessionKey]?.trim();
  if (!message) {
    setActionNoteBySession((current) => ({ ...current, [sessionKey]: 'Write an instruction or load the correction draft first.' }));
    return;
  }

  if (isSlashCommandText(message)) {
    const relayed = await relaySlashCommand(sessionKey, buildSlashTerminalInput(message));
    if (relayed) {
      playSendClick();
      setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
      setSurfaceNote('Slash command sent to terminal.');
      return;
    }
  }

  playSendClick();

  const pendingTurn: PendingOwnedTurn = {
    id: `pending-${Date.now()}`,
    prompt: message,
    createdAt: Date.now(),
    timestampLabel: mobileClockFormatter.format(new Date()),
  };

  setPendingOwnedTurnBySession((current) => ({ ...current, [sessionKey]: pendingTurn }));
  setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
  setSurfaceNote('Turn queued.');

  try {
    await runAction({ action: 'resume', sessionKey, message });
  } catch (error) {
    setPendingOwnedTurnBySession((current) => {
      if (!current[sessionKey]) return current;
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
