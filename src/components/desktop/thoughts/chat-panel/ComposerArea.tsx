'use client';

import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { InputButtons, type ThinkingEffort } from '../InputButtons';
import { composerModeSpec, type ComposerMode } from '../composer-mode';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { SlashCommandPicker } from './SlashCommandPicker';
import { ComposerStatusBar } from './ComposerStatusBar';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { getOrchestratorSlashCommandSuggestions, type OrchestratorSlashCommandDefinition } from '@/lib/slash-commands';
import { MODE_ROUTING_SLASH_COMMANDS } from '@/lib/composer-mode-routing';
import type { ThoughtsAttachedImage, ThoughtsComposerDragHandlers } from './useThoughtsComposerAttachments';
import { registerComposerCenter } from '../../composer-center-registry';
import { PromptStashRow } from '../PromptStashRow';
import { stashPrompt, type PromptStashContext } from '@/lib/orchestrator/prompt-stash';
import { OPEN_PROMPT_LIBRARY_EVENT, SAVE_PROMPT_LIBRARY_EVENT } from '@/lib/prompt-library/client';

interface ComposerAreaProps {
  activeComposer?: boolean;
  input: string;
  onInputChange: (next: string) => void;
  isOrchestratorMode: boolean;
  isChatMode?: boolean;
  isSingleMode?: boolean;
  displayWaiting: boolean;
  chatMessages: MobileTranscriptEntry[];
  activeTargetLabel: string;
  targetAgentExists: boolean;
  thoughtsBodyBackground: string;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSubmit: () => void;
  onStop?: () => void;
  onSlashCommand: (cmd: string) => void;
  modelLabel: string;
  /** Raw orchestrator model id — only meaningful in orchestrator mode. */
  modelId?: string;
  /** Orchestrator-mode model switching from the composer chip. */
  onModelChange?: (model: string) => void;
  activeBackend?: OrchestratorBackendSetting;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  effort: ThinkingEffort;
  onEffortChange: (next: ThinkingEffort) => void;
  adaptiveEnabled: boolean;
  /** UltraCode / swarm tier — surfaced in the thinking dropdown. */
  swarmEnabled?: boolean;
  onSetSwarm?: (enabled: boolean) => void;
  /** Collide / MoA tier — icon chip sibling to the permission toggle. */
  collideEnabled?: boolean;
  onSetCollide?: (enabled: boolean) => void;
  /** Clarify-first (#1489) — per-send interview-before-dispatch toggle. */
  /** Session rules (#1329) — forwarded to InputButtons; undefined hides the chip. */
  sessionRulesThreadId?: string | null;
  repoLabel?: string | null;
  displayMessagesCount: number;
  hasAssistantActivity: boolean;
  footerMeterSlot?: React.ReactNode;
  attachedImages?: ThoughtsAttachedImage[];
  attachedFiles?: string[];
  dragOver?: boolean;
  dragHandlers?: ThoughtsComposerDragHandlers;
  onAttachedImageRemove?: (index: number) => void;
  onAttachedImageAnnotate?: (index: number) => void;
  onAttachedFileRemove?: (fileName: string) => void;
  onUploadDiskFiles?: (files: FileList | File[]) => void;
  composerMode?: ComposerMode;
  onComposerModeChange?: (mode: ComposerMode) => void;
  repoPath?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
  composerLeadingExtras?: React.ReactNode;
  /** ⌘⏎ or Return while busy routes through the host send buffer. */
  onSteer?: () => void;
  sendBufferStatus?: React.ReactNode;
  promptStash?: PromptStashContext & { onRestore: (text: string) => void };
  voiceModeEnabled?: boolean;
  onVoiceModeChange?: (enabled: boolean) => void;
}

export const ComposerArea = forwardRef<HTMLTextAreaElement, ComposerAreaProps>(function ComposerArea({
  activeComposer = false,
  input,
  onInputChange,
  isOrchestratorMode,
  isChatMode = false,
  isSingleMode = false,
  displayWaiting,
  chatMessages,
  activeTargetLabel,
  targetAgentExists,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  onStop,
  onSlashCommand,
  modelLabel,
  modelId,
  onModelChange,
  activeBackend,
  onBackendChange,
  effort,
  onEffortChange,
  adaptiveEnabled,
  swarmEnabled,
  onSetSwarm,
  collideEnabled,
  onSetCollide,
  sessionRulesThreadId,
  repoLabel,
  displayMessagesCount,
  hasAssistantActivity,
  footerMeterSlot,
  attachedImages = [],
  attachedFiles = [],
  dragOver = false,
  dragHandlers,
  onAttachedImageRemove,
  onAttachedImageAnnotate,
  onAttachedFileRemove,
  onUploadDiskFiles,
  composerMode,
  onComposerModeChange,
  repoPath,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  composerLeadingExtras,
  onSteer,
  sendBufferStatus,
  promptStash,
  voiceModeEnabled,
  onVoiceModeChange,
}, inputRef) {
  const composerCenterRef = useRef<HTMLDivElement>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState<string | null>(null);
  const [staleTurnSnapshot] = useState(Date.now);
  const runningTools = useMemo<MobileTranscriptToolCall[]>(() => {
    if (!isOrchestratorMode) return [];
    // Scan the latest assistant message for any tool calls still marked as
    // running. This is what the sticky status bar uses to stay visible even
    // if orchStream.status flickers — if there are live tool calls, the user
    // should see the bar regardless of the top-level status flag.
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i];
      if (msg.role !== 'assistant') continue;
      const tools = msg.toolCalls ?? [];
      const running = tools.filter((t) => t.status === 'running' || t.status === 'calling');
      if (running.length > 0) {
        // Stale-turn gate (Q's iMac, 2026-07-17: "225:16 · 1 running" — a
        // dead turn from a previous app run restores with a tool call whose
        // completion event never landed, and the bar counted forever while
        // the composer sat locked in "Queue for next turn"). A genuinely
        // live turn keeps the stream busy (displayWaiting) — including
        // durable-turn reattach — and stream flicker gaps are seconds, so an
        // idle stream plus a message older than the ceiling means the tool
        // is dead history, not work. Server-authoritative healing (#8) is
        // the structural fix; this stops the lie at the surface.
        const STALE_TURN_MS = 30 * 60 * 1000;
        const stale = !displayWaiting
          && typeof msg.timestamp === 'number'
          && staleTurnSnapshot - msg.timestamp > STALE_TURN_MS;
        return stale ? [] : running;
      }
      // Stop at the most recent assistant message — older tool calls are done.
      break;
    }
    return [];
  }, [chatMessages, displayWaiting, isOrchestratorMode, staleTurnSnapshot]);
  const latestUserEntry = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') return chatMessages[i];
    }
    return null;
  }, [chatMessages]);
  const latestUserMessageId = latestUserEntry?.id ?? null;
  // True while the latest message is the user's own — the orchestrator has been
  // handed the turn but hasn't streamed a reply yet (the "thinking" gap). The
  // working indicator must persist through this gap even though orchStream.status
  // drops to non-busy between accepting the send and the first token. 2026-06-18.
  const awaitingReply = chatMessages[chatMessages.length - 1]?.role === 'user';
  const slashSuggestions = useMemo(() => {
    const normalizedInput = input.trimStart();
    if (!isOrchestratorMode || dismissedSlashInput === input || !normalizedInput.startsWith('/')) {
      return [];
    }
    const commandToken = normalizedInput.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    return [
      ...getOrchestratorSlashCommandSuggestions(input),
      ...MODE_ROUTING_SLASH_COMMANDS.filter((item) => item.command.startsWith(commandToken)),
    ];
  }, [dismissedSlashInput, input, isOrchestratorMode]);

  // After the parent clears `input` (post-submit), force the textarea height
  // back to its minHeight. The onSubmit keydown handler already sets
  // height: 'auto' optimistically, but React's value-clear happens on the next
  // render so the autosize effect inside onChange never re-fires to shrink the
  // box — the result is a textarea that stays oversized with the "Queue for
  // next turn" placeholder showing at the grown height. Watching `input` for
  // the empty-string transition catches every clear path (submit, slash-route,
  // programmatic resets) without having to touch each call site.
  useEffect(() => {
    if (input !== '') return;
    const node = inputRef && 'current' in inputRef ? inputRef.current : null;
    if (!node) return;
    node.style.height = 'auto';
  }, [input, inputRef]);

  useEffect(() => {
    const composerCenter = composerCenterRef.current;
    if (!composerCenter) return;
    return registerComposerCenter(composerCenter);
  }, []);

  const acceptsDirectInput = isOrchestratorMode || isChatMode || isSingleMode;
  // Textarea stays typeable while the agent is busy so the user can compose a
  // steer. Enter queues through the parent's steer path; only the no-target
  // case disables the textarea outright.
  // The Send button itself still flips to Stop via `working` on InputButtons.
  const isDisabled = !acceptsDirectInput && !targetAgentExists;
  const showReasoningControls = (isOrchestratorMode || isSingleMode) && !isChatMode;
  const isWorkingLocked = acceptsDirectInput && (displayWaiting || runningTools.length > 0);
  let composerPlaceholder = `Message ${activeTargetLabel}…`;
  if (isWorkingLocked) {
    composerPlaceholder = 'Queue for next turn';
  } else if (isOrchestratorMode) {
    // Cursor-parity (Q 2026-07-17): the placeholder teaches the active mode;
    // the chip beside "+" is the persistent indicator.
    composerPlaceholder = composerModeSpec(composerMode ?? 'solo').placeholder;
  } else if (displayWaiting) {
    composerPlaceholder = `${activeTargetLabel} is thinking...`;
  }

  const activeSlashCommand = slashSuggestions[Math.min(activeSlashIndex, Math.max(0, slashSuggestions.length - 1))] ?? null;
  const footerLeadingSlot = hasAssistantActivity && !showReasoningControls ? <span>{displayMessagesCount} messages</span> : null;

  const updateInput = (nextValue: string) => {
    if (dismissedSlashInput !== null && dismissedSlashInput !== nextValue) {
      setDismissedSlashInput(null);
    }
    setActiveSlashIndex(0);
    onInputChange(nextValue);
  };

  const getInputNode = () => (
    inputRef && typeof inputRef !== 'function' && 'current' in inputRef ? inputRef.current : null
  );

  const handleTextareaPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items || !onUploadDiskFiles) return;

    const files: File[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].kind !== 'file') continue;
      const file = items[index].getAsFile();
      if (file) files.push(file);
    }

    if (files.length === 0) return;
    event.preventDefault();
    onUploadDiskFiles(files);
  };

  const handleFileReferenceSelect = (filePath: string) => {
    const node = getInputNode();
    const cursorPos = node?.selectionStart ?? input.length;
    const textBeforeCursor = input.slice(0, cursorPos);
    const textAfterCursor = input.slice(cursorPos);
    const atMatch = textBeforeCursor.match(/@[\w./-]*$/);

    let nextValue: string;
    let nextCursorPos: number;
    if (atMatch && typeof atMatch.index === 'number') {
      const beforeMatch = textBeforeCursor.slice(0, atMatch.index);
      nextValue = `${beforeMatch}@${filePath} ${textAfterCursor}`;
      nextCursorPos = beforeMatch.length + filePath.length + 2;
    } else {
      const spacer = textBeforeCursor.length === 0 || /\s$/.test(textBeforeCursor) ? '' : ' ';
      nextValue = `${textBeforeCursor}${spacer}@${filePath} ${textAfterCursor}`;
      nextCursorPos = textBeforeCursor.length + spacer.length + filePath.length + 2;
    }

    updateInput(nextValue);
    requestAnimationFrame(() => {
      const nextNode = getInputNode();
      nextNode?.focus();
      if (!nextNode) return;
      nextNode.selectionStart = nextCursorPos;
      nextNode.selectionEnd = nextCursorPos;
      nextNode.style.height = 'auto';
      nextNode.style.height = `${Math.min(nextNode.scrollHeight, 200)}px`;
    });
  };

  const handleSelectSlashCommand = (definition: OrchestratorSlashCommandDefinition) => {
    setDismissedSlashInput(null);
    if (definition.requiresArgument) {
      const nextValue = `${definition.command} `;
      updateInput(nextValue);
      requestAnimationFrame(() => {
        const node = inputRef && 'current' in inputRef ? inputRef.current : null;
        node?.focus();
        if (node) node.selectionStart = node.selectionEnd = node.value.length;
      });
      return;
    }
    onSlashCommand(definition.command);
  };

  return (
    <div style={{
      paddingTop: 24,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
      flexShrink: 0,
      // No background band (the "bar") — the composer floats; the transcript
      // fades behind it. (2026-07-02)
      background: 'transparent',
    }}>
      {promptStash ? <PromptStashRow onRestore={promptStash.onRestore} /> : null}
      {isOrchestratorMode ? (
        <ComposerStatusBar
          displayWaiting={displayWaiting}
          runningTools={runningTools}
          activeTargetLabel={activeTargetLabel}
          latestUserMessageId={latestUserMessageId}
          latestUserMessageAt={latestUserEntry?.timestamp ?? null}
          awaitingReply={awaitingReply}
        />
      ) : null}
      {sendBufferStatus}
      <div style={{ position: 'relative' }}>
        <SlashCommandPicker
          suggestions={slashSuggestions}
          activeIndex={activeSlashIndex}
          onSelect={handleSelectSlashCommand}
        />
        <div
          // The bottom status bar measures this element to center its branch
          // cluster directly under the composer — the column-width props it used
          // before ignored insets/gaps + a hidden right region and drifted ~125px.
          data-composer-center=""
          ref={composerCenterRef}
          onDragOver={dragHandlers?.onDragOver}
          onDragLeave={dragHandlers?.onDragLeave}
          onDrop={dragHandlers?.onDrop}
          style={{
            position: 'relative',
            borderRadius: 14,
            border: 'none',
            background: 'var(--t-chat-surface-input-bg, var(--t-input-bg))',
            // Floating composer (2026-07-02) — NO border; the input
            // bg + a soft warm lift define it, so the edge just FADES into the
            // transcript instead of drawing a boxed outline. (Supersedes the
            // earlier flat/no-shadow request.)
            boxShadow: '0 1px 3px rgba(40,30,20,0.05), 0 6px 20px rgba(40,30,20,0.07)',
            overflow: 'hidden',
            opacity: isDisabled ? 0.6 : 1,
            outline: dragOver ? '2px solid var(--t-accent)' : 'none',
            outlineOffset: -2,
          }}
        >
          {attachedImages.length > 0 ? (
            <div style={{
              display: 'flex',
              gap: 10,
              paddingTop: 12,
              paddingRight: 14,
              paddingBottom: 6,
              paddingLeft: 14,
              overflowX: 'auto',
            }}>
              {attachedImages.map((image, index) => (
                <div key={`${image.name}-${index}`} style={{ position: 'relative', width: 66, flexShrink: 0 }}>
                  <img
                    src={image.dataUri}
                    alt={image.name}
                    title={onAttachedImageAnnotate ? 'Click to annotate' : undefined}
                    onClick={onAttachedImageAnnotate ? () => onAttachedImageAnnotate(index) : undefined}
                    style={{
                      display: 'block',
                      width: 56,
                      height: 56,
                      objectFit: 'cover',
                      borderRadius: 10,
                      border: '1px solid var(--t-input-border)',
                      background: 'var(--t-bg-card)',
                      cursor: onAttachedImageAnnotate ? 'pointer' : 'default',
                    }}
                  />
                  {onAttachedImageAnnotate ? (
                    <button
                      type="button"
                      aria-label={`Annotate ${image.name}`}
                      title="Annotate"
                      onClick={() => onAttachedImageAnnotate(index)}
                      style={{
                        position: 'absolute',
                        top: 39,
                        right: 4,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 18,
                        height: 18,
                        borderRadius: 999,
                        border: '1px solid var(--t-input-border)',
                        background: 'var(--t-input-bg)',
                        color: 'var(--t-text-muted)',
                        cursor: 'pointer',
                        paddingTop: 0,
                        paddingRight: 0,
                        paddingBottom: 0,
                        paddingLeft: 0,
                        boxShadow: 'var(--t-panel-shadow)',
                      }}
                    >
                      <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                  ) : null}
                  <div style={{
                    width: 60,
                    marginTop: 4,
                    color: 'var(--t-text-faint)',
                    fontSize: 10,
                    lineHeight: 1.15,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-sans-system)',
                  }}>
                    {image.name}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => onAttachedImageRemove?.(index)}
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

          {attachedFiles.length > 0 ? (
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              paddingTop: attachedImages.length > 0 ? 2 : 12,
              paddingRight: 14,
              paddingBottom: 6,
              paddingLeft: 14,
            }}>
              {attachedFiles.map((fileName) => (
                <span key={fileName} style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  maxWidth: '100%',
                  paddingTop: 4,
                  paddingRight: 7,
                  paddingBottom: 4,
                  paddingLeft: 8,
                  borderRadius: 7,
                  border: '1px solid var(--t-accent-border)',
                  background: 'var(--t-accent-soft)',
                  color: 'var(--t-accent)',
                  fontSize: 11,
                  fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fileName.split('/').pop()}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${fileName}`}
                    onClick={() => onAttachedFileRemove?.(fileName)}
                    style={{
                      borderWidth: 0,
                      background: 'transparent',
                      color: 'var(--t-accent)',
                      cursor: 'pointer',
                      paddingTop: 0,
                      paddingRight: 0,
                      paddingBottom: 0,
                      paddingLeft: 0,
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <textarea
            ref={inputRef}
            data-o8-active-composer={activeComposer ? 'true' : undefined}
            value={input}
            onChange={(event) => {
              updateInput(event.target.value);
              const el = event.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            }}
            onKeyDown={(event) => {
              if (
                promptStash
                && event.key.toLowerCase() === 's'
                && event.metaKey
                && event.shiftKey
                && !event.ctrlKey
                && !event.altKey
                && input.trim().length > 0
              ) {
                event.preventDefault();
                const entry = stashPrompt({
                  text: input,
                  repoPath: promptStash.repoPath,
                  threadId: promptStash.threadId,
                });
                if (!entry) return;
                updateInput('');
                event.currentTarget.style.height = 'auto';
                return;
              }
              if (slashSuggestions.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveSlashIndex((current) => (current + 1) % slashSuggestions.length);
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveSlashIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDismissedSlashInput(input);
                  setActiveSlashIndex(0);
                  return;
                }
              }
              if (event.key === 'ArrowUp' && !input.trim()) {
                event.preventDefault();
                const lastUserMsg = [...chatMessages].reverse().find((message) => message.role === 'user');
                if (lastUserMsg) updateInput(lastUserMsg.text);
                return;
              }
              // ⌘⏎ / Ctrl+Enter — steer. Routes through the parent's enqueue path.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (!input.trim() || !onSteer) return;
                onSteer();
                if (event.currentTarget) {
                  event.currentTarget.style.height = 'auto';
                }
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (isWorkingLocked) {
                  if (!input.trim() || !onSteer) return;
                  onSteer();
                  if (event.currentTarget) {
                    event.currentTarget.style.height = 'auto';
                  }
                  return;
                }
                if (slashSuggestions.length > 0 && activeSlashCommand) {
                  const normalized = input.trim();
                  const [commandToken] = normalized.split(/\s+/, 1);
                  const commandAliases = activeSlashCommand.aliases ?? [];
                  const exactCommandToken = commandToken === activeSlashCommand.command
                    || commandAliases.includes(commandToken);
                  if (!exactCommandToken && normalized === commandToken) {
                    updateInput(`${activeSlashCommand.command}${activeSlashCommand.requiresArgument ? ' ' : ''}`);
                    return;
                  }
                  if (activeSlashCommand.requiresArgument && exactCommandToken && normalized === commandToken) {
                    updateInput(`${activeSlashCommand.command} `);
                    return;
                  }
                  const typedCommandMatches = normalized.startsWith(activeSlashCommand.command)
                    || commandAliases.some((alias) => normalized.startsWith(alias));
                  const nextCommand = typedCommandMatches
                    ? normalized
                    : activeSlashCommand.command;
                  onSlashCommand(nextCommand);
                  if (event.currentTarget) {
                    event.currentTarget.style.height = 'auto';
                  }
                  return;
                }
                onSubmit();
                if (event.currentTarget) {
                  event.currentTarget.style.height = 'auto';
                }
              }
            }}
            onPaste={handleTextareaPaste}
            placeholder={composerPlaceholder}
            disabled={isDisabled}
            rows={2}
            style={{
              width: '100%',
              minHeight: 52,
              maxHeight: 200,
              paddingTop: 11,
              paddingRight: 14,
              paddingBottom: 4,
              paddingLeft: 14,
              borderWidth: 0,
              background: 'transparent',
              fontSize: 13,
              color: 'var(--t-text)',
              resize: 'none',
              outline: 'none',
              fontFamily: 'var(--font-sans-system)',
              lineHeight: 1.4,
              boxSizing: 'border-box',
              // X hidden, not auto: text wraps (pre-wrap) so horizontal
              // overflow is never real — but WKWebView misreports textarea
              // scrollWidth under fractional CSS zoom and painted a phantom
              // h-scrollbar across the composer (operator screenshot
              // 2026-07-15, 80% zoom) that also ate clicks along its band.
              overflowX: 'hidden',
              overflowY: 'auto',
            }}
          />
          <InputButtons
            input={input}
            enhancing={enhancing}
            preEnhanceInput={preEnhanceInput}
            onEnhance={onEnhance}
            onUndoEnhance={onUndoEnhance}
            onSubmit={onSubmit}
            modelLabel={modelLabel}
            modelId={isOrchestratorMode ? modelId : undefined}
            onModelChange={isOrchestratorMode ? onModelChange : undefined}
            activeBackend={isOrchestratorMode ? activeBackend : undefined}
            onBackendChange={isOrchestratorMode ? onBackendChange : undefined}
            effort={effort}
            onEffortChange={onEffortChange}
            adaptiveEnabled={adaptiveEnabled}
            swarmEnabled={isOrchestratorMode ? swarmEnabled : false}
            onSetSwarm={isOrchestratorMode ? onSetSwarm : undefined}
            collideEnabled={isOrchestratorMode ? collideEnabled : false}
            onSetCollide={isOrchestratorMode ? onSetCollide : undefined}
            sessionRulesThreadId={sessionRulesThreadId}
            repoLabel={showReasoningControls ? repoLabel : null}
            displayMessagesCount={displayMessagesCount}
            working={isOrchestratorMode && displayWaiting}
            onStop={isOrchestratorMode ? onStop : undefined}
            onUploadDiskFiles={onUploadDiskFiles}
            composerMode={composerMode}
            onComposerModeChange={onComposerModeChange}
            onFileReferenceSelect={handleFileReferenceSelect}
            repoPath={repoPath}
            workspaceTargets={workspaceTargets}
            selectedRepoPath={selectedRepoPath}
            onSelectRepoPath={onSelectRepoPath}
            inlineLeadingExtras={composerLeadingExtras}
            inlineMeterSlot={showReasoningControls ? footerMeterSlot : null}
            voiceModeEnabled={voiceModeEnabled}
            onVoiceModeChange={onVoiceModeChange}
            onBrowsePrompts={isOrchestratorMode ? () => {
              window.dispatchEvent(new CustomEvent(OPEN_PROMPT_LIBRARY_EVENT));
            } : undefined}
            onSavePrompt={isOrchestratorMode ? (body) => {
              window.dispatchEvent(new CustomEvent(SAVE_PROMPT_LIBRARY_EVENT, {
                detail: { body, repoPath: repoPath ?? null },
              }));
            } : undefined}
          />
        </div>
      </div>

      {footerLeadingSlot ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 6, paddingLeft: 2, paddingRight: 2, fontSize: 10, color: 'var(--t-text-faint)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {footerLeadingSlot}
          </div>
        </div>
      ) : null}
    </div>
  );
});
