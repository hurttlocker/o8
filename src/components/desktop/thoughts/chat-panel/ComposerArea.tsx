'use client';

import { forwardRef, isValidElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { InputButtons, ThinkingChip, type ThinkingEffort } from '../InputButtons';
import { useTokenEstimate } from '../useTokenEstimate';
import { SlashCommandPicker } from './SlashCommandPicker';
import type { ThoughtsChatPermissionMode } from './types';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { getOrchestratorSlashCommandSuggestions, type OrchestratorSlashCommandDefinition } from '@/lib/slash-commands';
import { MODE_ROUTING_SLASH_COMMANDS } from '@/lib/composer-mode-routing';
import { formatTokens } from '@/lib/util/format-tokens';
import type { ThoughtsAttachedImage, ThoughtsComposerDragHandlers } from './useThoughtsComposerAttachments';

const compactUsdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface FooterMeterSlotProps {
  onClick?: () => void;
  runningTotal?: number;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(1, '0')}:${s.toString().padStart(2, '0')}`;
}

function ComposerStatusBar({
  displayWaiting,
  runningTools,
  activeTargetLabel,
  latestUserMessageId,
}: {
  displayWaiting: boolean;
  runningTools: MobileTranscriptToolCall[];
  activeTargetLabel: string;
  latestUserMessageId: string | null;
}) {
  const startedAtRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const prevDisplayWaitingRef = useRef(displayWaiting);
  const prevLatestUserMessageIdRef = useRef<string | null>(latestUserMessageId);
  const hasRunningTools = runningTools.length > 0;
  const active = displayWaiting || hasRunningTools;

  // Reset the elapsed anchor on turn boundaries — either the user sent a new
  // message (which includes steer messages fired while a previous turn is
  // still running) or displayWaiting rose from false to true (fresh thinking
  // starts). A single trigger doesn't cover both cases: a steer sent mid-turn
  // never flips displayWaiting, and a fresh thinking cycle without a new user
  // message (tool-initiated work) never bumps the user id.
  useEffect(() => {
    const risingEdge = displayWaiting && !prevDisplayWaitingRef.current;
    const newUserMessage = latestUserMessageId !== null
      && latestUserMessageId !== prevLatestUserMessageIdRef.current;
    prevDisplayWaitingRef.current = displayWaiting;
    prevLatestUserMessageIdRef.current = latestUserMessageId;
    if (risingEdge || newUserMessage) {
      startedAtRef.current = Date.now();
      const frame = window.requestAnimationFrame(() => {
        setElapsed(0);
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [displayWaiting, latestUserMessageId]);

  useEffect(() => {
    if (!active) {
      startedAtRef.current = null;
      const frame = window.requestAnimationFrame(() => setElapsed(0));
      return () => window.cancelAnimationFrame(frame);
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    const tick = () => {
      const anchor = startedAtRef.current;
      setElapsed(anchor === null ? 0 : Date.now() - anchor);
    };
    const frame = window.requestAnimationFrame(tick);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(id);
    };
  }, [active]);

  if (!active) return null;

  const runningSummary = hasRunningTools
    ? runningTools.slice(0, 2).map((t) => t.name).join(', ') + (runningTools.length > 2 ? ` +${runningTools.length - 2}` : '')
    : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(37, 99, 235, 0.22)',
        borderRadius: 12,
        background: 'linear-gradient(180deg, rgba(37, 99, 235, 0.07), rgba(37, 99, 235, 0.03))',
        boxShadow: '0 8px 22px rgba(37, 99, 235, 0.08)',
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#2563eb"
        strokeWidth="3"
        strokeLinecap="round"
        style={{ animation: 'spin 0.9s linear infinite', flexShrink: 0 }}
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-6.22-8.56" />
      </svg>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
        }}>
          <span>{activeTargetLabel} is working</span>
          <span style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: '#2563eb',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            letterSpacing: '0',
          }}>
            {formatElapsed(elapsed)}
          </span>
        </div>
        {runningSummary ? (
          <div style={{
            fontSize: 10.5,
            color: 'var(--t-text-muted)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            running: {runningSummary}
          </div>
        ) : null}
      </div>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: '#2563eb',
            opacity: 0.8,
            animation: `llmDot 1.2s ease-in-out ${index * 0.18}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

interface ComposerAreaProps {
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
  effort: ThinkingEffort;
  onEffortChange: (next: ThinkingEffort) => void;
  adaptiveEnabled: boolean;
  permissionMode: ThoughtsChatPermissionMode;
  onTogglePermission?: () => void;
  repoLabel?: string | null;
  displayMessagesCount: number;
  hasAssistantActivity: boolean;
  footerMeterSlot?: React.ReactNode;
  attachedImages?: ThoughtsAttachedImage[];
  attachedFiles?: string[];
  dragOver?: boolean;
  dragHandlers?: ThoughtsComposerDragHandlers;
  onAttachedImageRemove?: (index: number) => void;
  onAttachedFileRemove?: (fileName: string) => void;
  onUploadDiskFiles?: (files: FileList | File[]) => void;
  repoPath?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
  composerLeadingExtras?: React.ReactNode;
}

export const ComposerArea = forwardRef<HTMLTextAreaElement, ComposerAreaProps>(function ComposerArea({
  input,
  onInputChange,
  isOrchestratorMode,
  isChatMode = false,
  isSingleMode = false,
  displayWaiting,
  chatMessages,
  activeTargetLabel,
  targetAgentExists,
  thoughtsBodyBackground,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  onStop,
  onSlashCommand,
  modelLabel,
  effort,
  onEffortChange,
  adaptiveEnabled,
  permissionMode,
  onTogglePermission,
  repoLabel,
  displayMessagesCount,
  hasAssistantActivity,
  footerMeterSlot,
  attachedImages = [],
  attachedFiles = [],
  dragOver = false,
  dragHandlers,
  onAttachedImageRemove,
  onAttachedFileRemove,
  onUploadDiskFiles,
  repoPath,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  composerLeadingExtras,
}, inputRef) {
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState<string | null>(null);
  const workingLockHintId = useId();
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
      if (running.length > 0) return running;
      // Stop at the most recent assistant message — older tool calls are done.
      break;
    }
    return [];
  }, [chatMessages, isOrchestratorMode]);
  const latestUserMessageId = useMemo<string | null>(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') return chatMessages[i].id;
    }
    return null;
  }, [chatMessages]);
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
  const acceptsDirectInput = isOrchestratorMode || isChatMode || isSingleMode;
  const isDisabled = (displayWaiting || runningTools.length > 0) || (!acceptsDirectInput && !targetAgentExists);
  const showReasoningControls = (isOrchestratorMode || isSingleMode) && !isChatMode;
  const isWorkingLocked = acceptsDirectInput && (displayWaiting || runningTools.length > 0);
  const workingTargetLabel = activeTargetLabel.trim() || 'The agent';
  const canStopWorkingTurn = isOrchestratorMode && displayWaiting && Boolean(onStop);
  const workingLockReason = runningTools.length > 0
    ? `${workingTargetLabel} is running tools.`
    : `${workingTargetLabel} is finishing the current turn.`;
  const workingLockAction = canStopWorkingTurn
    ? 'Use Stop to interrupt, or wait for the next turn.'
    : 'Wait for the next turn before typing.';
  let composerPlaceholder = `Message ${activeTargetLabel}…`;
  if (isWorkingLocked) {
    composerPlaceholder = 'Composer unlocks when this turn finishes';
  } else if (isOrchestratorMode) {
    composerPlaceholder = 'Ask anything · / for commands';
  } else if (displayWaiting) {
    composerPlaceholder = `${activeTargetLabel} is thinking...`;
  }

  const activeSlashCommand = slashSuggestions[Math.min(activeSlashIndex, Math.max(0, slashSuggestions.length - 1))] ?? null;
  const footerLeadingSlot = showReasoningControls ? (
    <ThinkingChip effort={effort} adaptiveEnabled={adaptiveEnabled} onChange={onEffortChange} />
  ) : hasAssistantActivity ? <span>{displayMessagesCount} messages</span> : null;
  const footerMeterProps = isValidElement<FooterMeterSlotProps>(footerMeterSlot) ? footerMeterSlot.props : null;
  const tokenEstimate = useTokenEstimate({
    enabled: showReasoningControls,
    input,
    model: modelLabel,
    runningTotal: footerMeterProps?.runningTotal ?? 0,
  });

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
      paddingTop: 10,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
      borderTop: '1px solid var(--t-divider-subtle)',
      flexShrink: 0,
      background: thoughtsBodyBackground,
    }}>
      {isOrchestratorMode ? (
        <ComposerStatusBar
          displayWaiting={displayWaiting}
          runningTools={runningTools}
          activeTargetLabel={activeTargetLabel}
          latestUserMessageId={latestUserMessageId}
        />
      ) : null}
      <div style={{ position: 'relative' }}>
        <SlashCommandPicker
          suggestions={slashSuggestions}
          activeIndex={activeSlashIndex}
          onSelect={handleSelectSlashCommand}
        />
        <div
          onDragOver={dragHandlers?.onDragOver}
          onDragLeave={dragHandlers?.onDragLeave}
          onDrop={dragHandlers?.onDrop}
          style={{
            position: 'relative',
            borderRadius: 14,
            border: '1px solid var(--t-input-border)',
            background: 'var(--t-input-bg)',
            boxShadow: '0 14px 30px rgba(15, 23, 42, 0.08)',
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

          {isWorkingLocked ? (
            <div
              id={workingLockHintId}
              role="status"
              aria-live="polite"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                marginTop: attachedImages.length > 0 || attachedFiles.length > 0 ? 6 : 10,
                marginRight: 12,
                marginBottom: 0,
                marginLeft: 12,
                paddingTop: 7,
                paddingRight: 10,
                paddingBottom: 7,
                paddingLeft: 10,
                borderRadius: 10,
                border: '1px solid rgba(249, 115, 22, 0.2)',
                background: 'rgba(249, 115, 22, 0.08)',
                color: 'var(--t-text-muted)',
                fontSize: 11,
                lineHeight: 1.35,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  background: 'rgba(249, 115, 22, 0.13)',
                  color: '#f97316',
                  flexShrink: 0,
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
              </span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <span style={{ color: 'var(--t-text)', fontWeight: 700 }}>Composer locked.</span>{' '}
                {workingLockReason} {workingLockAction}
              </span>
            </div>
          ) : null}

          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => {
              updateInput(event.target.value);
              const el = event.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            }}
            onKeyDown={(event) => {
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
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
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
            aria-describedby={isWorkingLocked ? workingLockHintId : undefined}
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
              overflow: 'auto',
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
            effort={effort}
            onEffortChange={onEffortChange}
            adaptiveEnabled={adaptiveEnabled}
            permissionMode={permissionMode}
            onTogglePermission={onTogglePermission}
            repoLabel={showReasoningControls ? repoLabel : null}
            working={isOrchestratorMode && displayWaiting}
            onStop={isOrchestratorMode ? onStop : undefined}
            onUploadDiskFiles={onUploadDiskFiles}
            onFileReferenceSelect={handleFileReferenceSelect}
            repoPath={repoPath}
            workspaceTargets={workspaceTargets}
            selectedRepoPath={selectedRepoPath}
            onSelectRepoPath={onSelectRepoPath}
          />
        </div>
      </div>

      {footerLeadingSlot || composerLeadingExtras || footerMeterSlot ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 6, paddingLeft: 2, paddingRight: 2, fontSize: 10, color: 'var(--t-text-faint)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {footerLeadingSlot}
            {composerLeadingExtras}
          </div>
          {tokenEstimate || footerMeterSlot ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
              {tokenEstimate ? (
                <button
                  type="button"
                  onClick={() => { footerMeterProps?.onClick?.(); }}
                  title={`Projected next turn: ${formatTokens(tokenEstimate.projectedTokens).replace(/K$/u, 'k')} tokens · ${tokenEstimate.projectedPercent}% of context`}
                  style={{
                    borderWidth: 0,
                    background: 'transparent',
                    color: tokenEstimate.warnAtContextThreshold ? '#FF5A1F' : 'var(--t-text-faint)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: footerMeterProps?.onClick ? 'pointer' : 'default',
                    minWidth: 0,
                    fontSize: 11,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                    fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
                    paddingTop: 0,
                    paddingRight: 0,
                    paddingBottom: 0,
                    paddingLeft: 0,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {`~${formatTokens(tokenEstimate.projectedTokens).replace(/K$/u, 'k')} tokens`}
                    {tokenEstimate.costUsd !== null ? ` · ~${compactUsdFormatter.format(tokenEstimate.costUsd)}` : ''}
                  </span>
                </button>
              ) : null}
              {footerMeterSlot ? <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{footerMeterSlot}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
