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
  draftAttachmentsBySession: Record<string, DraftAttachment[]>;
  setSurfaceNote: Dispatch<SetStateAction<string | null>>;
  setDraftAttachmentsBySession: Dispatch<SetStateAction<Record<string, DraftAttachment[]>>>;
  composeRef: RefObject<HTMLTextAreaElement | null>;
}

export async function prepareImageAttachments({
  selectedSessionKey,
  files,
  isChatSession,
  draftAttachmentsBySession,
  setSurfaceNote,
  setDraftAttachmentsBySession,
  composeRef,
}: AttachmentSelectionArgs) {
  if (!selectedSessionKey || !files?.length) return;
  if (!isChatSession) {
    setSurfaceNote('Image attachments are only available for chat sessions right now.');
    return;
  }

  const existingAttachments = draftAttachmentsBySession[selectedSessionKey] ?? [];
  const availableSlots = Math.max(0, 4 - existingAttachments.length);
  if (availableSlots === 0) {
    setSurfaceNote('You can attach up to 4 images at a time.');
    return;
  }

  const chosenFiles = Array.from(files)
    .filter((file) => file.type.startsWith('image/'))
    .slice(0, availableSlots);
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
      [selectedSessionKey]: [...(current[selectedSessionKey] ?? []), ...nextAttachments],
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
  selectedSession?: MobileInboxSnapshot['sessions'][number];
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
  runAction: (payload: MobileActionRequest) => Promise<MobileActionResponse | undefined>;
  loadHistory: (sessionKey: string, force?: boolean) => Promise<unknown>;
  playSendClick: () => void;
  relaySlashCommand: (sessionKey: string, commandText: string) => Promise<boolean>;
}

export async function submitSteerTurn({
  sessionKey,
  actionStateBySession,
  snapshot,
  selectedSession,
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
  runAction,
  loadHistory,
  playSendClick,
  relaySlashCommand,
}: SteerSubmitArgs) {
  console.info('[mobile] submitSteerTurn called', {
    sessionKey,
    actionState: actionStateBySession[sessionKey] ?? 'idle',
    hasDraft: Boolean(draftBySession[sessionKey]?.trim()),
    hasSelectedSession: Boolean(selectedSession),
  });
  if (actionStateBySession[sessionKey] === 'steering') {
    console.warn('[mobile] submitSteerTurn BLOCKED — actionState stuck on steering');
    return;
  }

  const targetSession = snapshot.sessions.find((session) => session.sessionKey === sessionKey)
    ?? (selectedSession?.sessionKey === sessionKey ? selectedSession : undefined);
  if (targetSession && targetSession.runtimeSurface?.capabilities.sendInput === false) {
    const unavailableNote = targetSession.currentTask === 'Reconnecting…'
      ? 'Reconnecting… Input will be available once the desktop runtime reattaches.'
      : 'Idle. There is no live desktop runtime attached to this session yet.';
    setActionNoteBySession((current) => ({
      ...current,
      [sessionKey]: unavailableNote,
    }));
    return;
  }

  // Infer runtime from session key prefix when snapshot lookup misses.
  // This prevents falling through to the wrong runtime path when the
  // snapshot is stale but the session key clearly indicates a Codex/Claude session.
  const inferredRuntime = targetSession?.runtime
    ?? (sessionKey.startsWith('codex-owned:') ? 'codex'
      : sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:') ? 'codex'
      : sessionKey.startsWith('llm-chat:') ? 'chat'
      : sessionKey.startsWith('claude-code:') ? 'claude-code'
      : 'chat');
  const inferredOwnership = targetSession?.runtimeSurface?.ownership
    ?? (sessionKey.startsWith('codex-owned:') ? 'owned'
      : sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:') ? 'discovered'
      : undefined);

  const isDiscoveredCodex = inferredRuntime === 'codex' && inferredOwnership === 'discovered';
  const isOwnedCodex = inferredRuntime === 'codex' && inferredOwnership === 'owned';
  const isClaudeCode = inferredRuntime === 'claude-code';
  const isWorkspaceChat = inferredRuntime === 'chat';
  const isChat = isDiscoveredCodex || isOwnedCodex || isClaudeCode || isWorkspaceChat;
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
    if (isWorkspaceChat) {
      // llm-chat sessions route through the mobile chat send API, not WS steer
      if (sessionKey.startsWith('llm-chat:')) {
        const res = await fetch('/api/mobile/chat/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey, message }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error || 'Chat send failed');
        }
        setSurfaceNote('Sent…');
        void loadHistory(sessionKey, true).catch(() => undefined);
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
        setSurfaceNote('Sent to workspace chat…');
        void loadHistory(sessionKey, true).catch(() => undefined);
      }
    } else if (isDiscoveredCodex) {
      await runAction({ action: 'steer', sessionKey, message });
      setSurfaceNote('Sent to Codex…');
      void loadHistory(sessionKey, true).catch(() => undefined);
    } else if (isOwnedCodex || isClaudeCode) {
      await runAction({ action: 'resume' as MobileActionRequest['action'], sessionKey, message });
      setSurfaceNote(isClaudeCode ? 'Sent to Claude Code…' : 'Sent to Codex…');
      void loadHistory(sessionKey, true).catch(() => undefined);
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
  console.info('[mobile] submitOwnedResumeTurn called', {
    sessionKey,
    actionState: actionStateBySession[sessionKey] ?? 'idle',
    hasDraft: Boolean(draftBySession[sessionKey]?.trim()),
  });
  if (actionStateBySession[sessionKey] === 'steering') {
    console.warn('[mobile] submitOwnedResumeTurn BLOCKED — actionState stuck on steering');
    return;
  }

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
