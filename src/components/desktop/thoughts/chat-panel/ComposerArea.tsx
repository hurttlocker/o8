'use client';

import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { AgentStatusDot } from '@/components/desktop/AgentStatusDot';
import { InputButtons, type ThinkingEffort } from '../InputButtons';
import { SlashCommandPicker } from './SlashCommandPicker';
import { PendingSteerCard, type PendingSteer } from './PendingSteerCard';
import type { ThoughtsChatPermissionMode } from './types';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { getOrchestratorSlashCommandSuggestions, type OrchestratorSlashCommandDefinition } from '@/lib/slash-commands';
import { MODE_ROUTING_SLASH_COMMANDS } from '@/lib/composer-mode-routing';
import type { ThoughtsAttachedImage, ThoughtsComposerDragHandlers } from './useThoughtsComposerAttachments';

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
  awaitingReply,
}: {
  displayWaiting: boolean;
  runningTools: MobileTranscriptToolCall[];
  activeTargetLabel: string;
  latestUserMessageId: string | null;
  awaitingReply: boolean;
}) {
  const startedAtRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Render-visible mirror of startedAtRef for AgentStatusDot's pulse→orbit
  // switch (refs can't be read during render). Synced from the same tick that
  // drives `elapsed`, so it tracks the real turn-start without extra timers.
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const prevDisplayWaitingRef = useRef(displayWaiting);
  const prevLatestUserMessageIdRef = useRef<string | null>(latestUserMessageId);
  const hasRunningTools = runningTools.length > 0;
  // Turn-in-flight latch. orchStream.status flickers busy→ready→busy across a
  // single turn (it drops to 'ready' for the whole "thinking" gap between
  // accepting the send and the first streamed token), which made the indicator
  // vanish mid-turn. Latch ON when a turn starts (a new user message, or
  // displayWaiting rising on a tool-initiated cycle) and OFF only once the reply
  // has landed AND streaming has settled — so the bar stays put for the whole
  // turn. The rising-edge trigger means a reload whose last message is a user
  // message does NOT light the bar. 2026-06-18.
  const [turnLatched, setTurnLatched] = useState(false);
  const active = displayWaiting || hasRunningTools || turnLatched;

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
      setTurnLatched(true);
      const frame = window.requestAnimationFrame(() => {
        setElapsed(0);
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [displayWaiting, latestUserMessageId]);

  // Release the latch once the turn is genuinely done: the reply (or an error
  // note) has landed (awaitingReply false) AND we're no longer streaming
  // (displayWaiting false) AND no tools are running. Until all three hold, the
  // bar stays visible — bridging the thinking gap and any mid-turn flicker.
  useEffect(() => {
    if (turnLatched && !awaitingReply && !displayWaiting && !hasRunningTools) {
      setTurnLatched(false);
    }
  }, [turnLatched, awaitingReply, displayWaiting, hasRunningTools]);

  useEffect(() => {
    if (!active) {
      startedAtRef.current = null;
      const frame = window.requestAnimationFrame(() => { setTurnStart(null); setElapsed(0); });
      return () => window.cancelAnimationFrame(frame);
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    const tick = () => {
      const anchor = startedAtRef.current;
      setTurnStart(anchor);
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
      role="status"
      aria-live="polite"
      aria-label={`${activeTargetLabel} working for ${formatElapsed(elapsed)}`}
      title={runningSummary ? `Running ${runningSummary}` : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        height: 22,
        marginBottom: 8,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 2,
        background: 'transparent',
        border: 'none',
      }}
    >
      {/* Shared status vocabulary — accent pulse while working, flips to the
          binary orbit once this turn crosses the long-running threshold (7 min).
          startedAtRef holds the real turn-start (Date.now ms), so a genuinely
          long orchestrator turn surfaces the orbit. */}
      <AgentStatusDot state="running" startedAt={turnStart} color="var(--t-text-muted)" />
      <span style={{
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: '-0.01em',
        color: 'var(--t-text-muted)',
      }}>
        Working
      </span>
      <span style={{
        fontSize: 11,
        fontWeight: 500,
        fontFamily: '"SF Mono", ui-monospace, monospace',
        letterSpacing: '0',
        color: 'var(--t-text-faint)',
      }}>
        {formatElapsed(elapsed)}
      </span>
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
  /** Raw orchestrator model id — only meaningful in orchestrator mode. */
  modelId?: string;
  /** Orchestrator-mode model switching from the composer chip. */
  onModelChange?: (model: string) => void;
  effort: ThinkingEffort;
  onEffortChange: (next: ThinkingEffort) => void;
  adaptiveEnabled: boolean;
  /** UltraCode / swarm tier — surfaced in the thinking dropdown. */
  swarmEnabled?: boolean;
  onSetSwarm?: (enabled: boolean) => void;
  /** Collide / MoA tier — icon chip sibling to the permission toggle. */
  collideEnabled?: boolean;
  onSetCollide?: (enabled: boolean) => void;
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
  /** ⌘⏎ in the composer fires this. Consumer enqueues when busy, sends when idle. */
  onSteer?: () => void;
  /** Queued steers waiting for an idle agent. Rendered as a card above the composer. */
  pendingSteers?: PendingSteer[];
  /** Preempt: abort the running turn + bump this steer to fire next. */
  onSteerNow?: (id: string) => void;
  /** Discard a queued steer without firing. */
  onDeleteSteer?: (id: string) => void;
  /** Commit an inline-edit on a queued steer. */
  onEditSteer?: (id: string, text: string) => void;
  /** Notify the consumer when a row enters/leaves inline-edit. Used to pause auto-fire of the head while it's being edited. */
  onEditingSteerChange?: (id: string | null) => void;
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
  modelId,
  onModelChange,
  effort,
  onEffortChange,
  adaptiveEnabled,
  swarmEnabled,
  onSetSwarm,
  collideEnabled,
  onSetCollide,
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
  onSteer,
  pendingSteers,
  onSteerNow,
  onDeleteSteer,
  onEditSteer,
  onEditingSteerChange,
}, inputRef) {
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState<string | null>(null);
  // Conductor-style keyboard queue (borrow: @mattyp tweet). queueNavIndex !== null
  // means keyboard focus is "in" the steer queue (the index is the focused steer);
  // null means the composer has focus. autoEditSteerId asks PendingSteerCard to
  // begin an inline edit on that steer (the E key).
  const [queueNavIndex, setQueueNavIndex] = useState<number | null>(null);
  const [autoEditSteerId, setAutoEditSteerId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingSteers || pendingSteers.length === 0) {
      setQueueNavIndex(null);
      setAutoEditSteerId(null);
    }
  }, [pendingSteers]);
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
    composerPlaceholder = 'Ask anything · / for commands';
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
          awaitingReply={awaitingReply}
        />
      ) : null}
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
          onDragOver={dragHandlers?.onDragOver}
          onDragLeave={dragHandlers?.onDragLeave}
          onDrop={dragHandlers?.onDrop}
          style={{
            position: 'relative',
            borderRadius: 14,
            border: '1px solid var(--t-input-border)',
            background: 'var(--t-input-bg)',
            // Flat on the workspace — no drop shadow (operator request,
            // 2026-06-18). The border + input bg already define the composer.
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

          {pendingSteers && pendingSteers.length > 0 && onSteerNow && onDeleteSteer && onEditSteer ? (
            <PendingSteerCard
              steers={pendingSteers}
              focusedIndex={queueNavIndex}
              autoEditId={autoEditSteerId}
              onSteerNow={onSteerNow}
              onDelete={onDeleteSteer}
              onEdit={onEditSteer}
              onEditingChange={(id) => {
                onEditingSteerChange?.(id);
                if (id === null) {
                  // Inline edit finished — drop the E-trigger, exit queue nav, and
                  // return focus to the composer so ↑ can re-enter the queue.
                  setAutoEditSteerId(null);
                  setQueueNavIndex(null);
                  requestAnimationFrame(() => {
                    const node = inputRef && typeof inputRef !== 'function' && 'current' in inputRef ? inputRef.current : null;
                    node?.focus();
                  });
                }
              }}
            />
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
              // Conductor-style keyboard queue: when focus is "in" the steer queue,
              // ↑/↓ navigate, E edits, Return steers-now, Delete removes, Esc/any
              // other key returns to the composer. The textarea keeps DOM focus
              // (the queue is navigated virtually) until E moves focus into the
              // inline editor.
              if (queueNavIndex !== null && pendingSteers && pendingSteers.length > 0) {
                const count = pendingSteers.length;
                const idx = Math.min(queueNavIndex, count - 1);
                if (event.key === 'ArrowUp') { event.preventDefault(); setQueueNavIndex(Math.max(0, idx - 1)); return; }
                if (event.key === 'ArrowDown') { event.preventDefault(); setQueueNavIndex(idx >= count - 1 ? null : idx + 1); return; }
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSteerNow?.(pendingSteers[idx].id); setQueueNavIndex(null); return; }
                if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onDeleteSteer?.(pendingSteers[idx].id); setQueueNavIndex(count - 1 <= 0 ? null : Math.min(idx, count - 2)); return; }
                if (event.key === 'e' || event.key === 'E') { event.preventDefault(); setAutoEditSteerId(pendingSteers[idx].id); return; }
                if (event.key === 'Escape') { event.preventDefault(); setQueueNavIndex(null); return; }
                if (event.key === 'Shift' || event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt') { return; }
                // Any other key (typing) exits queue nav and falls through so the
                // keystroke lands in the composer.
                setQueueNavIndex(null);
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
                // ↑ on an empty composer enters the steer queue if one exists
                // (Conductor borrow); otherwise recall the last sent message.
                if (pendingSteers && pendingSteers.length > 0) {
                  setQueueNavIndex(pendingSteers.length - 1);
                  return;
                }
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
            modelId={isOrchestratorMode ? modelId : undefined}
            onModelChange={isOrchestratorMode ? onModelChange : undefined}
            effort={effort}
            onEffortChange={onEffortChange}
            adaptiveEnabled={adaptiveEnabled}
            swarmEnabled={isOrchestratorMode ? swarmEnabled : false}
            onSetSwarm={isOrchestratorMode ? onSetSwarm : undefined}
            collideEnabled={isOrchestratorMode ? collideEnabled : false}
            onSetCollide={isOrchestratorMode ? onSetCollide : undefined}
            permissionMode={permissionMode}
            onTogglePermission={onTogglePermission}
            repoLabel={showReasoningControls ? repoLabel : null}
            displayMessagesCount={displayMessagesCount}
            working={isOrchestratorMode && displayWaiting}
            onStop={isOrchestratorMode ? onStop : undefined}
            onUploadDiskFiles={onUploadDiskFiles}
            onFileReferenceSelect={handleFileReferenceSelect}
            repoPath={repoPath}
            workspaceTargets={workspaceTargets}
            selectedRepoPath={selectedRepoPath}
            onSelectRepoPath={onSelectRepoPath}
            inlineLeadingExtras={composerLeadingExtras}
            inlineMeterSlot={showReasoningControls ? footerMeterSlot : null}
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
