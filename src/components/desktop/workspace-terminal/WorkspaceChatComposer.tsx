/* eslint-disable @next/next/no-img-element -- composer previews are transient local data URIs */
/* eslint-disable react-hooks/refs -- the hook return is composer state, though the rule treats the typed object as a ref */
'use client';

import { memo, useCallback, useRef } from 'react';
import {
  MessageSquare,
  X,
} from '../lucide-shims';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_BG_CARD,
} from '@/components/desktop/workspace-terminal/constants';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import type { useWorkspaceChatPane } from '@/components/desktop/workspace-terminal/useWorkspaceChatPane';
import { useThoughtsComposerAttachments } from '@/components/desktop/thoughts/chat-panel/useThoughtsComposerAttachments';
import { PendingSteerCard } from '@/components/desktop/thoughts/chat-panel/PendingSteerCard';
import { InputButtons } from '@/components/desktop/thoughts/InputButtons';
import { useAgentVoiceMode } from '@/components/desktop/thoughts/chat-panel/useAgentVoiceMode';

type ChatPaneState = ReturnType<typeof useWorkspaceChatPane>;

interface WorkspaceChatComposerProps {
  active: boolean;
  chat: ChatPaneState;
  tab: TerminalTab;
  isLaneArchived: boolean;
  onSaveCheckpoint: (tabId: string) => void;
  onRestoreLatestCheckpoint: (tabId: string) => void;
}

/**
 * Composer for Codex + Claude Code agent sessions. Mirrors the orchestrator
 * composer shape without exposing controls that spawned agents should not own.
 * Agent sessions can be steered, but model/runtime/checkpoint chrome stays out
 * of the input so the surface reads like one clean message box.
 */
function WorkspaceChatComposerBase({
  active,
  chat,
  tab,
  isLaneArchived,
}: WorkspaceChatComposerProps) {
  // Image attachment rendering (Pass 1) + in-composer footer parity with
  // the orchestrator (Pass 3). The footer is now the shared `InputButtons`
  // component — same model chip + permission shield + action icons the
  // orchestrator + llm-chat surfaces use, just fed by the Codex chat
  // pane state. The previous standalone send button + below-card chip
  // row (Pass 2) are gone.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const attachments = useThoughtsComposerAttachments({ hostRef });

  // Model chip label — runtime + model, e.g. "Codex GPT-5.5 xhigh".
  // Falls back to just the runtime label when the chat hasn't picked a
  // model yet (e.g., opencode awaiting providers).
  const modelLabel = chat.selectedModel?.label
    ? `${chat.runtimeLabel} ${chat.selectedModel.label}`
    : chat.runtimeLabel;

  // InputButtons leans on the orchestrator's enhance/undo flow. The
  // Codex composer doesn't surface enhance today — stub the callbacks
  // so the component renders without a no-op enhance button.
  const noop = useCallback(() => undefined, []);
  const fillVoiceDraft = useCallback((text: string) => {
    chat.setDraft(text);
    setTimeout(() => chat.composeRef.current?.focus(), 0);
  }, [chat]);
  const sendVoiceTurn = useCallback((text: string) => {
    const message = text.trim();
    if (!message || isLaneArchived) return false;
    chat.setDraft('');
    void chat.sendText(message);
    return true;
  }, [chat, isLaneArchived]);
  const voiceMode = useAgentVoiceMode({
    active,
    busy: chat.agentRunning,
    composerNodeRef: chat.composeRef,
    fillInput: fillVoiceDraft,
    messages: chat.messages,
    sendNow: sendVoiceTurn,
    surfaceKey: `workspace:${tab.id}`,
  });

  // Sub-pass B — wire attached images into the actual send payload.
  // Codex / Gemini / opencode CLIs accept a plain text prompt; the
  // bridge is to upload each dropped image to <repoPath>/o8-assets/
  // via the existing /api/repo-spec/asset writer (same path o8.md
  // images take) and append `![name](o8-assets/...)` markdown refs to
  // the prompt. The agent's filesystem tools can then read the file
  // by path. When the chat has no repo bound, image attachments are
  // dropped silently rather than crashing the send.
  const handleSubmit = useCallback(() => {
    const images = attachments.attachedImages;
    const repoPath = tab.repo?.localPath;
    void (async () => {
      const imageRefs: string[] = [];
      if (repoPath && images.length > 0) {
        for (const image of images) {
          try {
            const blob = dataUriToBlob(image.dataUri, image.mimeType);
            const res = await fetch(
              `/api/repo-spec/asset?repoPath=${encodeURIComponent(repoPath)}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': image.mimeType,
                  'x-filename': encodeURIComponent(image.name),
                },
                body: blob,
              },
            );
            const data = (await res.json().catch(() => null)) as
              | { ok?: boolean; relPath?: string }
              | null;
            if (res.ok && data?.ok && typeof data.relPath === 'string') {
              imageRefs.push(`![${image.name}](${data.relPath})`);
            }
          } catch {
            // Skip the image on upload failure; rest of the message still sends.
          }
        }
      }

      const baseDraft = chat.draft.trim();
      const queuedTexts = chat.queuedContextCards
        .map((card) => card.text.trim())
        .filter(Boolean);
      const text = [...queuedTexts, baseDraft, ...imageRefs]
        .filter(Boolean)
        .join('\n\n');
      if (!text) return;

      // Clear UI state up-front. handleRemoveQueuedContext is per-card
      // since the pane doesn't expose a bulk clearer; iterate over a
      // captured copy because the array mutates as we go.
      chat.setDraft('');
      const queuedCopy = [...chat.queuedContextCards];
      for (const card of queuedCopy) {
        chat.handleRemoveQueuedContext(card.id);
      }
      attachments.clearAttachments();

      await chat.sendText(text);
    })();
  }, [attachments, chat, tab.repo?.localPath]);

  return (
    <div
      style={{
        paddingTop: 12,
        paddingBottom: 16,
        // Match the orchestrator/chat composer's 12px side inset so the worker
        // steer composer is the same width, not thinner (Q ruling 2026-07-11).
        paddingLeft: 12,
        paddingRight: 12,
        // No divider line above the composer — matches the orchestrator/chat
        // composer, which floats with no top border (Q ruling 2026-07-11).
        background: 'transparent',
        opacity: isLaneArchived ? 0.5 : 1,
        pointerEvents: isLaneArchived ? 'none' : 'auto',
      }}
    >
      <div
        ref={hostRef}
        onDragOver={attachments.dragHandlers.onDragOver}
        onDragLeave={attachments.dragHandlers.onDragLeave}
        onDrop={attachments.dragHandlers.onDrop}
        style={{
          // Identical to the orchestrator/chat composer (Q ruling 2026-07-11):
          // full column width, no border, the same soft floating shadow, and a
          // drag-over accent outline. No 720 cap.
          width: '100%',
          borderRadius: 14,
          border: 'none',
          background: 'var(--t-chat-surface-input-bg, var(--t-input-bg))',
          boxShadow: '0 1px 3px rgba(40,30,20,0.05), 0 6px 20px rgba(40,30,20,0.07)',
          overflow: 'hidden',
          outline: attachments.dragOver ? '2px solid var(--t-accent)' : 'none',
          outlineOffset: -2,
        }}
      >
        {chat.pendingSteers.length > 0 ? (
          <PendingSteerCard
            steers={chat.pendingSteers}
            onSteerNow={chat.handleSteerNow}
            onDelete={chat.handleDeleteSteer}
            onEdit={chat.handleEditSteer}
            onEditingChange={chat.onEditingSteerChange}
          />
        ) : null}

        {chat.queuedContextCards.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              paddingTop: 14,
              paddingRight: 14,
              paddingBottom: 0,
              paddingLeft: 14,
              borderBottom: '1px solid var(--t-divider-subtle)',
            }}
          >
            {chat.queuedContextCards.map((card) => (
              <div
                key={card.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 12,
                  border: '1px solid var(--t-panel-border)',
                  background: THEME_BG_CARD,
                }}
              >
                {card.previewImageDataUri ? (
                  <img
                    src={card.previewImageDataUri}
                    alt="Captured design region"
                    style={{
                      width: 72,
                      height: 54,
                      borderRadius: 9,
                      border: '1px solid var(--t-border)',
                      objectFit: 'cover',
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 28,
                      height: 28,
                      borderRadius: 9,
                      background: THEME_ACCENT_SOFT,
                      color: THEME_ACCENT,
                      flexShrink: 0,
                    }}
                  >
                    <MessageSquare size={14} />
                  </div>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: THEME_ACCENT }}>
                    Staged Context
                  </div>
                  <div style={{ marginTop: 3, fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>
                    {card.title}
                  </div>
                  {card.meta.length > 0 ? (
                    <div style={{ marginTop: 3, display: 'flex', gap: 7, flexWrap: 'wrap', fontSize: 10, color: 'var(--t-text-muted)' }}>
                      {card.meta.slice(0, 2).map((entry) => (
                        <span key={entry}>{entry}</span>
                      ))}
                    </div>
                  ) : null}
                  {card.preview ? (
                    <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                      {card.preview.length > 120 ? `${card.preview.slice(0, 117).trimEnd()}…` : card.preview}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => chat.handleRemoveQueuedContext(card.id)}
                  title="Remove staged context"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'var(--t-border)',
                    background: 'transparent',
                    color: 'var(--t-text-muted)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {attachments.attachedImages.length > 0 ? (
          <div
            style={{
              display: 'flex',
              gap: 10,
              paddingTop: 12,
              paddingRight: 14,
              paddingBottom: 6,
              paddingLeft: 14,
              overflowX: 'auto',
            }}
          >
            {attachments.attachedImages.map((image, index) => (
              <div key={`${image.name}-${index}`} style={{ position: 'relative', width: 66, flexShrink: 0 }}>
                <img
                  src={image.dataUri}
                  alt={image.name}
                  style={{
                    display: 'block',
                    width: 56,
                    height: 56,
                    objectFit: 'cover',
                    borderRadius: 10,
                    border: '1px solid var(--t-input-border)',
                    background: 'var(--t-bg-card)',
                  }}
                />
                <div
                  style={{
                    width: 60,
                    marginTop: 4,
                    color: 'var(--t-text-faint)',
                    fontSize: 10,
                    lineHeight: 1.15,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-sans-system)',
                  }}
                >
                  {image.name}
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => attachments.removeAttachedImage(index)}
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: 4,
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    border: '1px solid var(--t-input-border)',
                    background: 'var(--t-input-bg)',
                    color: 'var(--t-text-muted)',
                    cursor: 'pointer',
                    fontSize: 11,
                    lineHeight: '16px',
                    textAlign: 'center',
                    paddingTop: 0,
                    paddingRight: 0,
                    paddingBottom: 0,
                    paddingLeft: 0,
                    boxShadow: 'var(--t-panel-shadow)',
                  }}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* Padding lives ON the textarea (border-box, inside minHeight 52) so
            the composer is the SAME height as the orchestrator/chat composer —
            the wrapper adds none (Q ruling 2026-07-11). */}
        <div style={{ paddingTop: attachments.attachedImages.length > 0 ? 2 : 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 }}>
          <textarea
            ref={chat.composeRef}
            data-o8-active-composer={active ? 'true' : undefined}
            name="workspaceComposeMessage"
            aria-label={`Message ${chat.runtimeLabel}`}
            value={chat.draft}
            onChange={(event) => {
              chat.setDraft(event.currentTarget.value);
              event.currentTarget.style.height = 'auto';
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 200)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void chat.handleSend();
              }
            }}
            placeholder={isLaneArchived
              ? 'Lane archived — transcript is read-only'
              : chat.isAgentTab ? `Steer this ${chat.runtimeLabel} agent...` : `Message ${chat.runtimeLabel}...`}
            rows={2}
            style={{
              width: '100%',
              minHeight: 52,
              maxHeight: 200,
              paddingTop: 11,
              paddingRight: 14,
              paddingBottom: 4,
              paddingLeft: 14,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: 'var(--font-sans-system)',
              lineHeight: 1.4,
              resize: 'none',
              boxSizing: 'border-box',
              // X hidden: wrapped textarea never h-scrolls, but WKWebView
              // misreports scrollWidth under fractional CSS zoom → phantom
              // h-scrollbar (2026-07-15, 80% zoom). See ComposerArea.tsx.
              overflowX: 'hidden',
              overflowY: 'auto',
            }}
          />
        </div>

        <InputButtons
          input={chat.draft}
          enhancing={false}
          preEnhanceInput={null}
          onEnhance={noop}
          onUndoEnhance={noop}
          onSubmit={handleSubmit}
          modelLabel={modelLabel}
          repoLabel={tab.repo?.name || tab.repo?.localPath?.split('/').pop() || null}
          repoPath={tab.repo?.localPath ?? null}
          displayMessagesCount={chat.messages.length}
          working={chat.agentRunning}
          voiceModeEnabled={voiceMode.enabled}
          onVoiceModeChange={voiceMode.setEnabled}
        />
      </div>
    </div>
  );
}

/** Convert a `data:<mime>;base64,<...>` URI into a Blob suitable for a fetch
 *  body. Used by the Codex composer's image-attachment send path so the
 *  thumbnails dropped onto the composer (held in memory as data URIs by
 *  useThoughtsComposerAttachments) can POST as raw bytes to
 *  /api/repo-spec/asset. */
function dataUriToBlob(dataUri: string, fallbackMime: string): Blob {
  const commaIdx = dataUri.indexOf(',');
  const head = commaIdx >= 0 ? dataUri.slice(0, commaIdx) : '';
  const b64 = commaIdx >= 0 ? dataUri.slice(commaIdx + 1) : dataUri;
  const mimeMatch = head.match(/data:([^;]+)/);
  const mime = mimeMatch?.[1] ?? fallbackMime;
  const decoded = typeof atob === 'function' ? atob(b64) : '';
  const arr = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) arr[i] = decoded.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export const WorkspaceChatComposer = memo(WorkspaceChatComposerBase);
