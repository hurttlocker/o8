'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { CollapsiblePlanCard } from '@/components/desktop/CollapsiblePlanCard';
import { composeComposerModeMessage, resolveComposerExecutionMode, type ComposerMode } from './composer-mode';
import { formatModelLabel } from '@/lib/format';
import { orchestratorBackendDisplayLabel, orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import type { ManualThinkingEffort, ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  readAdaptiveThinkingEnabled,
  readStoredOrchestratorThinkingOverride,
  resolveInitialOrchestratorThinkingPreferences,
  subscribeOrchestratorThinkingPreferences,
  writeStoredOrchestratorThinkingOverride,
} from '@/lib/orchestrator/thinking-preferences';
import {
  queueOrchestratorSessionPrelude,
  readStoredOrchestratorModel,
  searchOrchestratorArchive,
  writeStoredOrchestratorModel,
} from '@/lib/orchestrator/store';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { serializeThreadToMarkdown } from '@/lib/llm/export-thread';
import {
  executeOrchestratorSlashCommand,
  parseOrchestratorSlashCommand,
  type SlashOrchestrationRequest,
} from '@/lib/slash-commands';
import type { AgentTarget, FleetAgent } from './types';
import {
  entrySignature,
  generateSuggestions,
  isRenderableThoughtEntry,
  isRunnableCliSession,
  mergeSameThreadHistoryLoad,
  mergeTranscriptEntries,
  resolveThreadLoadPlan,
} from './utils';
import { useOrchestratorStream } from './useOrchestratorStream';
import { useOrchestratorStatusFeed } from './useOrchestratorStatusFeed';
import { getPendingMissionCards } from './mission-complete-detector';
import { useOrchestratorContextResidency } from '@/components/desktop/orchestrator/context-residency';
import { useDictationHostOptional } from '@/components/desktop/dictation/DictationHost';
import { ProfiledChatMessageList as ChatMessageList } from './chat-panel/ProfiledChatMessageList';
import { SwarmStatusCard, type SwarmScoutView } from './chat-panel/SwarmStatusCard';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { track } from '@/lib/analytics/track';
import type { TurnSummary } from './chat-panel/TurnSummaryCard';
import { ChatToastStack } from './chat-panel/ChatToastStack';
import { ComposerArea } from './chat-panel/ComposerArea';
import { ComposerSendBufferStatus } from './chat-panel/ComposerSendBufferStatus';
import { useDefaultComposerSendBuffer } from './chat-panel/useDefaultComposerSendBuffer';
import { shouldApplyAutoRestoreAfterFetch } from './chat-panel/autoRestoreGuard';
import { loadOrchestrationMode, persistOrchestrationMode, type ChatModelId, type OrchestrationMode } from '@/components/desktop/orchestrator/ModePicker';
import { useReadyRuntimeCount } from './use-ready-runtimes';
import {
  consumePendingComposerDraft,
  parseModeRoutingPrefix,
  stashPendingComposerDraft,
} from '@/lib/composer-mode-routing';
import { getChatModelOption, loadChatModelChoice } from '@/components/desktop/orchestrator/chat-models';
import {
  createChatAssistantEntry,
  createChatUserEntry,
  mergeToolCallIntoEntry,
  mergeToolResultIntoEntry,
  sendScratchChatMessage,
} from '@/components/desktop/orchestrator/send-chat-message';
import { dedupeDisplayMessages } from './chat-panel/dedupe-display-messages';
import { EmptyStateCard } from './chat-panel/EmptyStateCard';
import { ThreadExportButton } from './chat-panel/ThreadExportButton';
import { useClearCommand } from './chat-panel/useClearCommand';
import { useOrchestratorReloadNotice } from './chat-panel/useOrchestratorReloadNotice';
import { usePersistChatThread } from './chat-panel/usePersistChatThread';
import { isFileEditCall } from './chat-panel/file-edits';
import { useSuggestedReplies } from './chat-panel/useSuggestedReplies';
import { useThoughtsComposerAttachments } from './chat-panel/useThoughtsComposerAttachments';
import { useThreadHistoryBackfill, type ThreadHistoryPage } from './chat-panel/useThreadHistoryBackfill';
import { ScreenshotAnnotator } from './chat-panel/ScreenshotAnnotator';
import { isAbortError } from '@/lib/active-long-lived-request';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import { useActiveLongLivedRequest } from '@/lib/use-active-long-lived-request';
import type {
  ThoughtsChatPanelChromeState,
  ThoughtsChatPanelHandle,
  ThoughtsChatPermissionMode,
  ThoughtsSendNowOptions,
} from './chat-panel/types';
import {
  fetchThoughtsOperatorDefaults,
  THOUGHTS_OPERATOR_DEFAULTS_FALLBACK,
  type ThoughtsOperatorDefaults,
  type OrchestratorBackendSetting,
} from './operator-defaults';
import {
  mapHistoryMessagesToTranscript,
  type ThoughtsHistoryMessage,
} from './history-transcript';

export type { ThoughtsChatPanelHandle, ThoughtsChatPanelChromeState, ThoughtsChatPermissionMode };

function isRuntimeSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith('claude-code:')
    || sessionKey.startsWith('codex:')
    || sessionKey.startsWith('codex-owned:')
    || sessionKey.startsWith('codex-discovered:')
    || sessionKey.startsWith('codex-live:')
    || sessionKey.startsWith('gemini-owned:')
    || sessionKey.startsWith('opencode-owned:');
}

function repoPathLabel(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  return path.split('/').filter(Boolean).pop() ?? path;
}

function resolveActiveComposerBackend(defaults: {
  orchestratorBackend: OrchestratorBackendSetting;
  inAppOrchestratorEnabled: boolean;
}): OrchestratorBackendSetting {
  if (defaults.orchestratorBackend !== 'auto') return defaults.orchestratorBackend;
  return defaults.inAppOrchestratorEnabled ? 'claude' : 'codex';
}

function formatComposerBackendLabel(backend: OrchestratorBackendSetting, model: string): string {
  if (backend === 'codex') return 'Codex GPT-5.6';
  if (backend === 'fable') return 'Fable 5';
  if (backend === 'openclaw') return 'OpenClaw';
  if (backend === 'hermes') return 'Hermes';
  if (backend === 'collide') return 'Collide';
  if (backend === 'o8') return 'o8';
  return formatModelLabel(model);
}

function composerBackendTurnOverride(backend: OrchestratorBackendSetting): OrchestratorBackendId | undefined {
  return backend === 'auto' ? undefined : backend;
}

export const ThoughtsChatPanel = forwardRef<ThoughtsChatPanelHandle, {
  open: boolean;
  draftInjection?: { id: string; text: string } | null;
  imageInjection?: { id: string; dataUri: string; name: string; mimeType: string } | null;
  onImageInjectionConsumed?: () => void;
  agents: FleetAgent[];
  missionState: OrchestratorMissionState;
  preferredRuntime: OrchestratorRuntime;
  sessionTargets: AgentTarget[];
  workspaceTargets: OrchestratorWorkspaceTarget[];
  repoPath?: string | null;
  thoughtsBodyBackground: string;
  thoughtsElevatedSurface: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
  thoughtsMutedGlass: string;
  permissionMode?: ThoughtsChatPermissionMode;
  /**
   * UltraCode / swarm tier (per-tab). When on, the orchestrator turn carries a
   * hint to fan work out in parallel — native Claude sub-agents via a workflow
   * plus Codex workers via o8 — and live agent cards surface inline in the
   * transcript.
   */
  swarmEnabled?: boolean;
  onSetSwarm?: (enabled: boolean) => void;
  collideEnabled?: boolean;
  onSetCollide?: (enabled: boolean) => void;
  repoLabel?: string | null;
  emptyStateOverride?: React.ReactNode;
  // Slot rendered BELOW the composer input when no messages have
  // landed yet. The OrchestratorEmptyState surface uses this for the
  // Worktree / Branch / Kind chip row (Antigravity / Cortex pattern).
  // Disappears once the first message renders (handled in caller).
  composerBelowSlot?: React.ReactNode;
  // Rail rendered to the RIGHT of the transcript (not the composer), so the
  // composer spans the full panel width even when the rail is up (Q ruling
  // 2026-07-11). The caller owns the rail's own width/animation wrapper.
  transcriptSideRail?: React.ReactNode;
  showInlineExport?: boolean;
  footerMeterSlot?: React.ReactNode;
  composerLeadingExtras?: React.ReactNode;
  // When set, the chooser surface is hidden and the mode is forced to
  // this value for the lifetime of the panel. Used by Single-runtime
  // tabs (lockedMode='single') and Chat tabs (lockedMode='chat').
  lockedMode?: OrchestrationMode;
  // Initial mode/runtime/chatModel sourced from the parent tab record.
  // Overrides the legacy global per-workspace localStorage load when
  // provided. Combine with onModePersist to round-trip changes.
  initialMode?: OrchestrationMode;
  initialSingleRuntime?: OrchestratorRuntime;
  initialChatModelId?: ChatModelId;
  // Optional pinned OpenRouter model for chat-mode requests (e.g.
  // 'openai/gpt-oss-120b:free'). Empty/undefined = use server chain.
  initialChatOpenrouterModel?: string;
  // Called when the operator picks a different mode/runtime/chatModel
  // in the chooser. Lets the parent persist to the tab record instead
  // of relying on global localStorage. When omitted, falls back to the
  // legacy per-workspace localStorage path.
  onModePersist?: (patch: {
    mode?: OrchestrationMode;
    singleRuntime?: OrchestratorRuntime;
    chatModelId?: ChatModelId;
    chatOpenrouterModel?: string | null;
  }) => void;
  // Spawn handlers forwarded to ModePicker so picking Single/Chat opens
  // a new tab instead of flipping the current tab's mode.
  onSpawnSingleTab?: (runtime: OrchestratorRuntime) => void;
  onSpawnChatTab?: () => void;
  onMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  onLaunchPacket?: (packet: OrchestratorPacket) => void;
  onChromeChange: (state: ThoughtsChatPanelChromeState) => void;
  // Called with the latest user message text in chat mode so the parent
  // can stash it on the tab record and the tab strip can show a 3-word
  // summary instead of the generic "Chat" label.
  onChatSummary?: (text: string) => void;
  // Isolated mounts (drag-to-split thread panes) bind to an explicit thread
  // via the imperative handle. The mount-time auto-restore pass must never
  // run for them — it could adopt an unrelated recently-touched thread in
  // the race window before loadThread lands.
  suppressAutoRestore?: boolean;
  /** True when the host tab is bound to a persisted thread whose history
   *  (incl. its backend) hasn't loaded yet. Until the load lands, the
   *  composer chip shows '…' instead of confidently claiming the DEFAULT
   *  backend — a wrong label on every tab right after boot/reload was the
   *  "they all say o8" report (2026-07-16). */
  expectsThreadLoad?: boolean;
}>(function ThoughtsChatPanel({
  open,
  draftInjection,
  imageInjection,
  onImageInjectionConsumed,
  agents,
  missionState,
  preferredRuntime,
  sessionTargets,
  workspaceTargets,
  repoPath: repoPathProp,
  thoughtsBodyBackground,
  thoughtsElevatedSurface,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
  thoughtsMutedGlass,
  permissionMode = 'full',
  swarmEnabled = false,
  onSetSwarm,
  collideEnabled = false,
  onSetCollide,
  repoLabel,
  emptyStateOverride,
  composerBelowSlot,
  transcriptSideRail,
  showInlineExport = true,
  footerMeterSlot,
  composerLeadingExtras,
  lockedMode,
  initialMode,
  initialSingleRuntime,
  initialChatModelId,
  initialChatOpenrouterModel,
  onModePersist,
  onSpawnSingleTab,
  onSpawnChatTab,
  onLaunchPacket,
  onChromeChange,
  onChatSummary,
  suppressAutoRestore = false,
  expectsThreadLoad = false,
}, ref) {
  const [input, setInput] = useState('');
  // Composer mode (Cursor-parity, Q 2026-07-17) — persists across sends until
  // switched, Cursor behavior. Ref mirrors state so handleTaskSend reads the
  // live value without growing its dependency list.
  const [composerMode, setComposerMode] = useState<ComposerMode>('solo');
  const composerModeRef = useRef<ComposerMode>('solo');
  composerModeRef.current = composerMode;
  // MoA IS the Collide backend — keep the chip and the model-picker's Mode
  // section telling the same truth in both directions.
  const handleComposerModeChange = useCallback((next: ComposerMode) => {
    setComposerMode(next);
    if (next === 'moa') onSetCollide?.(true);
    else if (collideEnabled) onSetCollide?.(false);
  }, [onSetCollide, collideEnabled]);
  useEffect(() => {
    if (collideEnabled && composerMode !== 'moa') setComposerMode('moa');
    else if (!collideEnabled && composerMode === 'moa') setComposerMode('solo');
  }, [collideEnabled, composerMode]);
  const [preEnhanceInput, setPreEnhanceInput] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  // Orchestration mode + runtime + chat-model selection. Per-tab when
  // the parent provides initial values + onModePersist (the orchestrator
  // tab path); otherwise falls back to the legacy per-workspace
  // localStorage store keyed off repoPath.
  const workspaceModeKey = repoPathProp ?? '__global__';
  const usesPerTabPersistence = Boolean(onModePersist) || lockedMode !== undefined || initialMode !== undefined;
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationMode>(
    () => lockedMode ?? initialMode ?? 'fleet',
  );
  // Installed runtime count → silent solo/fleet decision (see soloOrchestrator).
  const readyRuntimeCount = useReadyRuntimeCount();
  const [singleRuntime, setSingleRuntime] = useState<OrchestratorRuntime>(
    () => initialSingleRuntime ?? 'codex',
  );
  const [chatModelId, setChatModelId] = useState<ChatModelId>(
    () => initialChatModelId ?? 'o8-default',
  );
  const [chatOpenrouterModel, setChatOpenrouterModel] = useState<string | undefined>(
    () => initialChatOpenrouterModel,
  );
  // Re-sync the pinned OpenRouter model when the parent tab record
  // changes (e.g. operator picked a different model and the tab updated).
  useEffect(() => {
    setChatOpenrouterModel(initialChatOpenrouterModel);
  }, [initialChatOpenrouterModel]);
  const [orchestrationSettingsKey, setOrchestrationSettingsKey] = useState<string | null>(
    () => (usesPerTabPersistence ? workspaceModeKey : null),
  );
  // Consume any pending slash-routed draft (`/codex foo`, `/chat hi`, ...)
  // stashed by the source tab right before it called the spawn handler.
  // Fires once per tab mount; ignored when this panel isn't a spawn
  // target (Fleet panels never have a matching pending draft).
  const slashDraftConsumedRef = useRef(false);
  useEffect(() => {
    if (slashDraftConsumedRef.current) return;
    if (!lockedMode) return;
    const target = lockedMode === 'chat'
      ? ({ kind: 'chat' } as const)
      : lockedMode === 'single'
        ? ({ kind: 'single', runtime: initialSingleRuntime ?? 'codex' } as const)
        : null;
    if (!target) return;
    const body = consumePendingComposerDraft(target);
    slashDraftConsumedRef.current = true;
    if (body) {
      setInput(body);
      latestInputRef.current = body;
    }
  }, [initialSingleRuntime, lockedMode]);
  const orchestrationSettingsLoaded = orchestrationSettingsKey === workspaceModeKey;
  const selectedChatModel = useMemo(() => getChatModelOption(chatModelId), [chatModelId]);
  useEffect(() => {
    if (usesPerTabPersistence) {
      // Per-tab path: initial values came in via props; just mark as
      // loaded so downstream effects can run.
      setOrchestrationSettingsKey(workspaceModeKey);
      return;
    }
    const loaded = loadOrchestrationMode(workspaceModeKey);
    setOrchestrationMode(loaded.mode);
    setSingleRuntime(loaded.runtime);
    setChatModelId(loadChatModelChoice(workspaceModeKey));
    setOrchestrationSettingsKey(workspaceModeKey);
  }, [usesPerTabPersistence, workspaceModeKey]);
  const handleSelectOrchestrationMode = useCallback((next: OrchestrationMode) => {
    if (lockedMode) return;
    setOrchestrationMode(next);
    if (onModePersist) {
      onModePersist({ mode: next });
    } else {
      persistOrchestrationMode(workspaceModeKey, next, singleRuntime);
    }
  }, [lockedMode, onModePersist, singleRuntime, workspaceModeKey]);

  // Empty-state Kind chip lives outside this component but needs to
  // flip the same orchestrationMode state the in-composer ModeChip
  // owns — otherwise toggling to Chat in the chip leaves the composer
  // pill row still showing the Orchestrator's model. Window event is
  // the loose-coupling bridge; gated on `open` so only the active
  // panel responds.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!open) return;
    const onSetMode = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: OrchestrationMode }>).detail;
      if (!detail?.mode) return;
      handleSelectOrchestrationMode(detail.mode);
    };
    window.addEventListener('o8:set-orchestration-mode', onSetMode as EventListener);
    return () => window.removeEventListener('o8:set-orchestration-mode', onSetMode as EventListener);
  }, [handleSelectOrchestrationMode, open]);

  const [operatorDefaults, setOperatorDefaults] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK);
  const [orchestratorBackend, setOrchestratorBackend] = useState<OrchestratorBackendSetting>(
    () => resolveActiveComposerBackend(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK),
  );
  // Who chose the composer's backend: 'default' (operator default seeded it),
  // 'thread' (adopted from a loaded thread's stored backend), 'user' (picked
  // in the composer this session). Precedence user > thread > default — a
  // reload must NOT silently re-route an OpenClaw/Codex conversation onto the
  // operator default ("they all say o8", 2026-07-16): a thread-bound tab
  // continues on ITS backend; the default is for new sessions.
  const backendSourceRef = useRef<'default' | 'thread' | 'user'>('default');
  const [adaptiveThinkingEnabled, setAdaptiveThinkingEnabled] = useState(
    () => resolveInitialOrchestratorThinkingPreferences(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.thinkingEffort).adaptiveThinkingEnabled,
  );
  const [thinkingOverride, setThinkingOverride] = useState<ManualThinkingEffort | null>(
    () => resolveInitialOrchestratorThinkingPreferences(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.thinkingEffort).thinkingOverride,
  );
  const [orchestratorModel, setOrchestratorModel] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.orchestratorModel);
  // Clarify-first (#1489) — per-send toggle. When on, the next orchestrator
  // message carries the clarify-first directive (interview before dispatch) and
  // resets to off after it fires. Off → the outgoing message is unchanged.
  const [chatMessages, setChatMessages] = useState<MobileTranscriptEntry[]>([]);
  const [planText, setPlanText] = useState<string | null>(null);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [targetAgentKey, setTargetAgentKey] = useState<string>('__claude__');
  const thinkingPreferenceTouchedRef = useRef(false);
  const pollRef = useRef<number | null>(null);
  const pollDelayRef = useRef<number | null>(null);
  // Abort per transcript tick + on teardown so a stalled read cannot stack
  // ESTABLISHED sockets across the webview's small per-origin budget.
  const pollAbortRef = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  const chatStreamRequest = useActiveLongLivedRequest(open);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const suppressNextTranscriptAutoScrollRef = useRef(false);
  const seenServerEntriesRef = useRef<Map<string, string>>(new Map());
  const responseSeenRef = useRef(false);
  const idlePollsRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const orchestratorSessionRef = useRef<string | null>(null);
  const singleRuntimeSessionRef = useRef<string | null>(null);
  const singleRuntimeLaunchPromiseRef = useRef<Promise<string | null> | null>(null);
  const [orchestratorSpawning, setOrchestratorSpawning] = useState(false);
  const [singleRuntimeSpawning, setSingleRuntimeSpawning] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const [activeThreadBackend, setActiveThreadBackend] = useState<OrchestratorBackendId | null>(null);
  // Stored on thread load but no longer read for the composer label — the chip
  // predicts the next turn, which runs the backend's default agent (see the
  // activeBackendLabel note). Kept as a setter-only slot for the load pipeline.
  const [, setActiveThreadAgent] = useState<string | null>(null);
  // Sidebar trampoline guard: history load, restoreLastThread, and initialThreadId
  // can race. Block re-entry for the same tab while loading and briefly after.
  const inFlightLoadKeyRef = useRef<string | null>(null);
  const lastLoadKeyRef = useRef<string | null>(null);
  const lastLoadAtRef = useRef<number>(0);
  // Monotonic load generation. Every loadThread call bumps it; the async body
  // captures its value and refuses to APPLY results if a newer load has started
  // meanwhile. Without this, loading thread B while A's fetch is still in flight
  // let a late A response overwrite B — the tab showed the wrong conversation
  // (adversarial review 2026-07-15).
  const loadGenerationRef = useRef(0);
  const exportFeedbackTimerRef = useRef<number | null>(null);
  const [resolvedRepoPath, setResolvedRepoPath] = useState<string | null>(repoPathProp ?? null);
  const [exportState, setExportState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const { persistThread, persistThreadNow, cancelPendingPersist } = usePersistChatThread(resolvedRepoPath);
  const thinkingEffort: ThinkingEffort = thinkingOverride ?? (adaptiveThinkingEnabled ? 'adaptive' : 'max');
  const composerDropHostRef = useRef<HTMLDivElement>(null);
  const {
    attachedImages,
    addAttachedImage,
    attachedFiles,
    dragOver: attachmentDragOver,
    dragHandlers: attachmentDragHandlers,
    processFiles: processAttachmentFiles,
    removeAttachedImage,
    replaceAttachedImage,
    removeAttachedFile,
    clearAttachments,
  } = useThoughtsComposerAttachments({ hostRef: composerDropHostRef });
  // Index of the attachment currently open in the screenshot annotator (or null).
  const [annotatingIndex, setAnnotatingIndex] = useState<number | null>(null);
  const settledAssistantRefetchRef = useRef<() => void>(() => {});
  // 'single' means two different things by tab kind (operator, 2026-07-06):
  // on a LOCKED tab (kind:'chat', dedicated CLI session) it is the classic
  // single-runtime composer; on an unlocked ORCHESTRATOR tab it is SOLO —
  // the same Claude orchestrator, just forbidden from dispatching this turn.
  // Picking Single must never silently swap the orchestrator for a raw Codex
  // session (that was the stuck-on-Codex trap).
  const isSingleMode = lockedMode === 'single';
  const isChatMode = orchestrationMode === 'chat';
  // Solo vs fleet is now decided SILENTLY by installed runtime count (Q ruling
  // 2026-07-11) — the manual Fleet/Solo chip was removed. One usable runtime →
  // the orchestrator runs lean/inline (solo); two or more → fleet orchestration
  // (dispatch). While the one-time probe is loading (null), default to fleet —
  // dispatch is the thesis, and never gate the orchestrator's tools on a
  // pending fetch.
  const soloOrchestrator = readyRuntimeCount === 1 && lockedMode !== 'single' && !isChatMode;
  const isOrchestratorMode = !isSingleMode && !isChatMode && (targetAgentKey === '__claude__' || !sessionTargets.some((s) => s.key === targetAgentKey));

  const orchStream = useOrchestratorStream(isOrchestratorMode && orchestrationSettingsLoaded && !isChatMode ? resolvedRepoPath : null, {
    seededPlanText: planText,
    hasHistory: chatMessages.length > 0,
    threadId,
    onThreadIdMint: useCallback((id: string) => {
      if (threadIdRef.current === id) return;
      threadIdRef.current = id;
      setThreadId(id);
    }, []),
    onSettledAssistantMissing: useCallback(() => settledAssistantRefetchRef.current(), []),
  });
  // Surface per-packet lifecycle moments (merge, self-heal / needs-human) as
  // status cards in the orchestrator transcript. Also delivers the
  // Mission-complete card for MCP-dispatched missions (the chat-stream rotation
  // path only sees chat-driven ones); a shared carded set prevents double-cards.
  useOrchestratorStatusFeed({
    active: isOrchestratorMode && !isChatMode,
    repoPath: resolvedRepoPath,
    threadId,
    missionPackets: missionState?.packets ?? [],
    appendLocalEntries: orchStream.appendLocalEntries,
  });

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const defaults = await fetchThoughtsOperatorDefaults(controller.signal);
      if (controller.signal.aborted) return;
      setOperatorDefaults(defaults);
      // Late-landing defaults must not clobber a backend the thread (or the
      // user) already chose — default is the weakest source.
      if (backendSourceRef.current === 'default') {
        setOrchestratorBackend(resolveActiveComposerBackend(defaults));
      }
      if (thinkingPreferenceTouchedRef.current) return;
      const nextThinkingPreferences = resolveInitialOrchestratorThinkingPreferences(defaults.thinkingEffort);
      setAdaptiveThinkingEnabled(nextThinkingPreferences.adaptiveThinkingEnabled);
      setThinkingOverride(nextThinkingPreferences.thinkingOverride);
    })();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!resolvedRepoPath) {
      setOrchestratorModel(operatorDefaults.orchestratorModel);
      return;
    }
    setOrchestratorModel(readStoredOrchestratorModel(resolvedRepoPath) ?? operatorDefaults.orchestratorModel);
  }, [operatorDefaults.orchestratorModel, resolvedRepoPath]);

  useEffect(() => subscribeOrchestratorThinkingPreferences(() => {
    setAdaptiveThinkingEnabled(readAdaptiveThinkingEnabled());
    setThinkingOverride(readStoredOrchestratorThinkingOverride());
  }), []);

  useEffect(() => {
    if (!isOrchestratorMode) return;
    if (!orchStream.planText || planText) return;
    setPlanText(orchStream.planText);
  }, [isOrchestratorMode, orchStream.planText, planText]);

  const targetAgent = useMemo(
    () => isOrchestratorMode ? null : (sessionTargets.find((agent) => agent.key === targetAgentKey) ?? null),
    [isOrchestratorMode, sessionTargets, targetAgentKey],
  );
  const targetSessionKey = targetAgent?.key ?? null;
  const selectedWorkspaceTarget = useMemo(
    () => workspaceTargets.find((target) => target.localPath === resolvedRepoPath) ?? null,
    [resolvedRepoPath, workspaceTargets],
  );
  // When the empty-state surface is showing, the Project chip above
  // the composer already owns the repo selector — duplicating it
  // inside the composer pill row reads as visual redundancy (operator
  // dogfood call). Hide it until messages arrive; on first message
  // the composer slides down to its bottom rest and the repo chip
  // reappears in the pill row so the operator can re-target during
  // the conversation. Final `composerRepoLabel` is derived further
  // down (after `displayMessages`) so the check matches what the
  // empty-state slot uses.
  const composerRepoLabelBase = selectedWorkspaceTarget?.label
    ?? repoLabel
    ?? repoPathLabel(resolvedRepoPath);
  const handleSelectComposerRepoPath = useCallback((next: string) => {
    setResolvedRepoPath(next);
    setPlanText(null);
    setWaitingForReply(false);
    orchestratorSessionRef.current = null;
    singleRuntimeSessionRef.current = null;
    singleRuntimeLaunchPromiseRef.current = null;
  }, []);

  // Listen for the empty-state Project chip's selection. Only the
  // currently OPEN panel responds (gated on `open`) so a multi-tab
  // workspace doesn't fan the picker click out to every tab. Empty
  // path = "don't work in a project" → clears resolvedRepoPath.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!open) return;
    const onScope = (event: Event) => {
      const detail = (event as CustomEvent<{ repoPath?: string | null }>).detail;
      const nextPath = typeof detail?.repoPath === 'string' && detail.repoPath.trim()
        ? detail.repoPath
        : '';
      handleSelectComposerRepoPath(nextPath);
    };
    window.addEventListener('o8:select-workspace-scope', onScope as EventListener);
    return () => window.removeEventListener('o8:select-workspace-scope', onScope as EventListener);
  }, [handleSelectComposerRepoPath, open]);

  // ── Resolve repo path for orchestrator stream ──
  useEffect(() => {
    if (repoPathProp) {
      setResolvedRepoPath(repoPathProp);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await ipcFetch('/api/panel/repos');
        if (res.ok && !cancelled) {
          const data = await res.json() as { repos?: Array<{ localPath: string }> };
          const path = data.repos?.[0]?.localPath ?? null;
          if (path) setResolvedRepoPath(path);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [repoPathProp]);

  useEffect(() => {
    orchestratorSessionRef.current = null;
    singleRuntimeSessionRef.current = null;
    singleRuntimeLaunchPromiseRef.current = null;
  }, [resolvedRepoPath, singleRuntime]);

  const resolveRuntimeRepoPath = useCallback(async () => {
    if (resolvedRepoPath) return resolvedRepoPath;
    if (repoPathProp) return repoPathProp;
    try {
      const res = await fetch('/api/panel/repos');
      if (!res.ok) return null;
      const data = await res.json() as { repos?: Array<{ localPath: string }> };
      return data.repos?.[0]?.localPath ?? null;
    } catch {
      return null;
    }
  }, [repoPathProp, resolvedRepoPath]);

  const ensureSingleRuntimeSession = useCallback(async (initialMessage?: string): Promise<{ sessionKey: string; launched: boolean } | null> => {
    if (singleRuntimeSessionRef.current) {
      return { sessionKey: singleRuntimeSessionRef.current, launched: false };
    }
    if (singleRuntimeLaunchPromiseRef.current) {
      const sessionKey = await singleRuntimeLaunchPromiseRef.current;
      return sessionKey ? { sessionKey, launched: false } : null;
    }

    const launchPromise = (async () => {
      const repoPath = await resolveRuntimeRepoPath();
      if (!repoPath) return null;
      const runtimeLabel = orchestratorRuntimeTone(singleRuntime).label;
      const prompt = initialMessage?.trim() || `You are ${runtimeLabel} running as a single-runtime o8 workspace chat. Acknowledge ready.`;
      try {
        setSingleRuntimeSpawning(true);
        const launchRes = await fetch('/api/runtime/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runtime: singleRuntime,
            prompt,
            repoPath,
            cwd: repoPath,
            taskName: initialMessage?.trim() || undefined,
            skipSetup: true,
          }),
        });
        const data = await launchRes.json() as { ok?: boolean; surfaceId?: string; error?: string; note?: string };
        if (!data.ok || !data.surfaceId) {
          // A dead launch must SAY SO — on a plain non-git folder every spawn
          // failed and the chat just sat silent (#1551). Surface the server's
          // actual reason as a system line so the operator is never guessing.
          const reason = (data.error || data.note || '').trim();
          setChatMessages((prev) => [
            ...prev,
            {
              id: `local-error-${Date.now()}`,
              role: 'system',
              text: reason
                ? `Couldn't start the ${orchestratorRuntimeTone(singleRuntime).label} session: ${reason}`
                : `Couldn't start the ${orchestratorRuntimeTone(singleRuntime).label} session — the launch failed with no reason given. Check the runtime is installed and try again.`,
              timestamp: Date.now(),
              timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ]);
          return null;
        }
        singleRuntimeSessionRef.current = data.surfaceId;
        return data.surfaceId;
      } catch (err) {
        setChatMessages((prev) => [
          ...prev,
          {
            id: `local-error-${Date.now()}`,
            role: 'system',
            text: `Couldn't start the ${orchestratorRuntimeTone(singleRuntime).label} session: ${err instanceof Error ? err.message : 'network error'}`,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
        return null;
      } finally {
        setSingleRuntimeSpawning(false);
        singleRuntimeLaunchPromiseRef.current = null;
      }
    })();

    singleRuntimeLaunchPromiseRef.current = launchPromise;
    const sessionKey = await launchPromise;
    return sessionKey ? { sessionKey, launched: true } : null;
  }, [resolveRuntimeRepoPath, singleRuntime]);

  // ── Pre-warm orchestrator session on mount ──
  useEffect(() => {
    if (!isOrchestratorMode || !orchestrationSettingsLoaded || isChatMode || orchestratorSessionRef.current || orchestratorSpawning) return;

    let cancelled = false;
    (async () => {
      let repoPath = resolvedRepoPath;
      if (!repoPath) {
        try {
          const res = await ipcFetch('/api/panel/repos');
          if (res.ok) {
            const data = await res.json() as { repos?: Array<{ localPath: string }> };
            repoPath = data.repos?.[0]?.localPath ?? null;
          }
        } catch { /* silent */ }
      }
      if (!repoPath || cancelled) return;

      try {
        const invRes = await fetch('/api/runtime/inventory?fresh=1');
        if (invRes.ok && !cancelled) {
          const invData = await invRes.json() as { agents?: Array<{ sessionKey: string; runtime: string; status: string; workspace: string }> };
          const existing = (invData.agents ?? []).find(
            (a) => a.runtime === 'claude-code' && (a.status === 'idle' || a.status === 'reviewing') && a.workspace?.includes(repoPath!),
          );
          if (existing) {
            orchestratorSessionRef.current = existing.sessionKey;
            return;
          }
        }
      } catch { /* silent */ }

      if (cancelled) return;
      try {
        setOrchestratorSpawning(true);
        const launchRes = await fetch('/api/runtime/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runtime: 'claude-code',
            prompt: 'You are the orchestrator for o8. Acknowledge ready.',
            repoPath,
            cwd: repoPath,
            skipSetup: true,
          }),
        });
        const data = await launchRes.json() as { ok?: boolean; surfaceId?: string };
        if (data.ok && data.surfaceId && !cancelled) {
          orchestratorSessionRef.current = data.surfaceId;
        }
      } catch { /* silent */ } finally {
        if (!cancelled) setOrchestratorSpawning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isChatMode, isOrchestratorMode, orchestrationSettingsLoaded, orchestratorSpawning, resolvedRepoPath]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open || !draftInjection?.id) return;
    setInput((prev) => prev.trim()
      ? `${prev.trimEnd()}\n\n${draftInjection.text}\n\n`
      : `${draftInjection.text}\n\n`);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [draftInjection?.id, draftInjection?.text, open]);

  // Right-click "Add to chat" on an inline o8.md image relays here (via the
  // dashboard, so only the VISIBLE tab consumes it). Apply once per id (ref
  // guard) and tell the dashboard to clear it — the image lands in exactly one
  // composer and never duplicates on tab refocus.
  const appliedImageInjectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !imageInjection?.id) return;
    if (appliedImageInjectionRef.current === imageInjection.id) return;
    appliedImageInjectionRef.current = imageInjection.id;
    addAttachedImage({ name: imageInjection.name, dataUri: imageInjection.dataUri, mimeType: imageInjection.mimeType });
    onImageInjectionConsumed?.();
  }, [open, imageInjection?.id, imageInjection?.name, imageInjection?.dataUri, imageInjection?.mimeType, addAttachedImage, onImageInjectionConsumed]);

  // Clear stale composer drafts on tab refocus unless a fresh draft injection
  // arrived while hidden. Tabs are display:none, so composer state persists.
  const previousOpenRef = useRef(open);
  const inputAtBlurRef = useRef<string>('');
  const lastSeenDraftIdRef = useRef<string | null>(draftInjection?.id ?? null);
  const [showDraftClearedToast, setShowDraftClearedToast] = useState(false);
  const draftClearedToastTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (draftClearedToastTimerRef.current !== null) {
        window.clearTimeout(draftClearedToastTimerRef.current);
      }
    };
  }, []);
  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    if (wasOpen && !open) {
      inputAtBlurRef.current = input;
      lastSeenDraftIdRef.current = draftInjection?.id ?? null;
      return;
    }
    if (open && !wasOpen) {
      const staleDraft = inputAtBlurRef.current.trim();
      const newDraftArrived = (draftInjection?.id ?? null) !== lastSeenDraftIdRef.current;
      if (staleDraft && !newDraftArrived) {
        setInput('');
        setPreEnhanceInput(null);
        setShowDraftClearedToast(true);
        if (draftClearedToastTimerRef.current !== null) {
          window.clearTimeout(draftClearedToastTimerRef.current);
        }
        draftClearedToastTimerRef.current = window.setTimeout(() => {
          setShowDraftClearedToast(false);
          draftClearedToastTimerRef.current = null;
        }, 1800);
      }
      inputAtBlurRef.current = '';
      lastSeenDraftIdRef.current = draftInjection?.id ?? null;
    }
  }, [open, input, draftInjection?.id]);

  useEffect(() => {
    if (suppressNextTranscriptAutoScrollRef.current) {
      suppressNextTranscriptAutoScrollRef.current = false;
      return;
    }
    requestAnimationFrame(() => {
      // Smooth when idle (a fresh user turn jumps into view); instant while
      // streaming so it doesn't fight the per-frame pin below.
      // Container-scoped on purpose (body-scroll trigger hunt, 2026-07-16):
      // scrollIntoView scrolls EVERY scrollable ancestor up to the document —
      // on the zoomed root that displaces the whole app shell (the class the
      // dashboard shell-guard exists to snap back). Scroll only the transcript.
      const end = chatEndRef.current;
      const container = end?.closest('.thoughts-scroll') as HTMLElement | null;
      if (!container) return;
      container.scrollTo({ top: container.scrollHeight, behavior: orchStream.status === 'busy' ? 'auto' : 'smooth' });
    });
  }, [chatMessages, orchStream.messages, orchStream.status]);

  // Smooth stick-to-bottom while the orchestrator streams. The per-frame
  // smooth-text reveal grows the content BETWEEN message-array updates, so the
  // message-change effect above alone leaves the reveal scrolling below the
  // fold. Pin to the bottom each frame (instant scrollTop — reads as smooth as
  // the text grows) UNLESS the operator has scrolled up to read history.
  useEffect(() => {
    if (orchStream.status !== 'busy') return;
    const container = chatEndRef.current?.closest('.thoughts-scroll') as HTMLElement | null;
    if (!container) return;
    let raf = 0;
    const pin = () => {
      const fromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (fromBottom < 120) container.scrollTop = container.scrollHeight;
      raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [orchStream.status]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      if (pollDelayRef.current !== null) window.clearTimeout(pollDelayRef.current);
      if (pollAbortRef.current !== null) pollAbortRef.current.abort();
      if (exportFeedbackTimerRef.current !== null) window.clearTimeout(exportFeedbackTimerRef.current);
    };
  }, []);

  const clearPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollDelayRef.current !== null) {
      window.clearTimeout(pollDelayRef.current);
      pollDelayRef.current = null;
    }
    // Drop the in-flight transcript request too — clearing the timer alone
    // leaves a stalled fetch holding its socket open.
    if (pollAbortRef.current !== null) {
      pollAbortRef.current.abort();
      pollAbortRef.current = null;
    }
  }, []);

  const setExportFeedback = useCallback((next: 'idle' | 'copying' | 'copied' | 'error') => {
    setExportState(next);
    if (exportFeedbackTimerRef.current !== null) {
      window.clearTimeout(exportFeedbackTimerRef.current);
      exportFeedbackTimerRef.current = null;
    }
    if (next === 'copied' || next === 'error') {
      exportFeedbackTimerRef.current = window.setTimeout(() => {
        setExportState('idle');
        exportFeedbackTimerRef.current = null;
      }, 1800);
    }
  }, []);

  const transcriptUrl = useCallback((sessionKey: string) => {
    if (isRuntimeSessionKey(sessionKey)) {
      return `/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=20`;
    }
    return `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=20&fresh=1`;
  }, []);

  const captureServerSnapshot = useCallback(async (sessionKey: string) => {
    try {
      const res = await fetchWithLongLivedBudget(transcriptUrl(sessionKey));
      if (!res.ok) return;
      const data = await res.json();
      const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
      const nextSeen = new Map<string, string>();
      for (const entry of entries) {
        nextSeen.set(entry.id, entrySignature(entry));
      }
      seenServerEntriesRef.current = nextSeen;
    } catch {
      // silent
    }
  }, [transcriptUrl]);

  const isOwnedRuntimeSession = useCallback((sessionKey: string) => (
    sessionKey.startsWith('codex-owned:')
    || sessionKey.startsWith('gemini-owned:')
    || sessionKey.startsWith('opencode-owned:')
  ), []);

  // Owned CLI sessions unlock only after inventory says they can resume; a
  // transcript tail alone can arrive before the next steer is accepted.
  const checkOwnedSessionReady = useCallback(async (sessionKey: string) => {
    try {
      const res = await fetch('/api/runtime/inventory');
      if (!res.ok) return false;
      const data = await res.json();
      const agents = Array.isArray(data?.agents) ? data.agents : [];
      const agent = agents.find((entry: { sessionKey?: string }) => entry?.sessionKey === sessionKey);
      const availability = agent?.runtimeSurface?.lifecycle?.availability;
      const sendInput = agent?.runtimeSurface?.capabilities?.sendInput;
      return availability === 'ready-for-resume' || sendInput === true;
    } catch {
      return false;
    }
  }, []);

  const startPollingForSession = useCallback((sessionKey: string) => {
    clearPolling();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;

    let attempts = 0;
    const maxAttempts = 60;
    const requiresReadiness = isOwnedRuntimeSession(sessionKey);

    const finishPolling = () => {
      clearPolling();
      setWaitingForReply(false);
    };

    const poll = async () => {
      if (!openRef.current) {
        clearPolling();
        return;
      }
      attempts++;
      if (attempts > maxAttempts) {
        finishPolling();
        return;
      }

      // Cancel any still-in-flight tick before starting a new one so a stalled
      // transcript read can't pile up open sockets.
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;

      try {
        const res = await fetchWithLongLivedBudget(transcriptUrl(sessionKey), { signal: controller.signal });
        if (!res.ok) return;

        const data = await res.json();
        const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
        const nextSeen = new Map(seenServerEntriesRef.current);
        const incoming: MobileTranscriptEntry[] = [];

        for (const entry of entries) {
          const signature = entrySignature(entry);
          const previousSignature = nextSeen.get(entry.id);
          nextSeen.set(entry.id, signature);

          if (previousSignature === signature) continue;
          if (entry.role === 'user') continue;
          if (!isRenderableThoughtEntry(entry)) continue;
          incoming.push(entry);
        }

        seenServerEntriesRef.current = nextSeen;

        if (incoming.length > 0) {
          responseSeenRef.current = true;
          idlePollsRef.current = 0;
          setChatMessages((prev) => mergeTranscriptEntries(prev, incoming));
          return;
        }

        if (responseSeenRef.current) {
          idlePollsRef.current += 1;
          if (idlePollsRef.current >= 4) {
            if (requiresReadiness) {
              const ready = await checkOwnedSessionReady(sessionKey);
              if (!ready) {
                idlePollsRef.current = 3;
                return;
              }
            }
            finishPolling();
          }
        }
      } catch {
        // silent retry
      }
    };

    pollDelayRef.current = window.setTimeout(() => {
      void poll();
      pollRef.current = window.setInterval(() => {
        void poll();
      }, 2000);
    }, 400);
  }, [checkOwnedSessionReady, clearPolling, isOwnedRuntimeSession, transcriptUrl]);

  const startPolling = useCallback(() => {
    const sessionKey = isOrchestratorMode ? orchestratorSessionRef.current : targetSessionKey;
    if (!sessionKey) {
      setWaitingForReply(false);
      return;
    }
    startPollingForSession(sessionKey);
  }, [isOrchestratorMode, startPollingForSession, targetSessionKey]);

  const previousConnectionOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = previousConnectionOpenRef.current;
    previousConnectionOpenRef.current = open;
    if (wasOpen && !open) {
      clearPolling();
      chatStreamRequest.abort('inactive');
      return;
    }
    if (!wasOpen && open && waitingForReply && !isChatMode) {
      startPolling();
    }
  }, [chatStreamRequest, clearPolling, isChatMode, open, startPolling, waitingForReply]);

  const resetRemoteSession = useCallback(async () => {
    try {
      const response = await fetch('/api/orchestrator/reset-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resolvedRepoPath ? { repoPath: resolvedRepoPath } : {}),
      });
      return response.ok;
    } catch {
      return false;
    }
  }, [resolvedRepoPath]);

  const handleReset = useCallback(() => {
    setInput('');
    setPreEnhanceInput(null);
    setChatMessages([]);
    setPlanText(null);
    setWaitingForReply(false);
    clearPolling();
    seenServerEntriesRef.current.clear();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;
    orchStream.reset();
    // A fresh conversation drops any thread-adopted backend back to the
    // operator default (explicit user picks stay).
    if (backendSourceRef.current === 'thread') {
      backendSourceRef.current = 'default';
      setOrchestratorBackend(resolveActiveComposerBackend(operatorDefaults));
    }
    setActiveThreadBackend(composerBackendTurnOverride(orchestratorBackend) ?? null);
    setActiveThreadAgent(null);
    // #597 minted a fresh threadId AND eagerly persisted an empty placeholder
    // file "so History shows the slot before typing" — but the list route now
    // HIDES empty unpinned threads (and GCs them after an hour), so the eager
    // file was invisible churn: every reset trigger (thread deleted while
    // open, mission rotation, /clear) wrote a junk thoughts-*.json. The id
    // still mints here; the FILE is written by the persist effect on the
    // first real message.
    const placeholderId = isOrchestratorMode ? `thoughts-${Date.now()}` : `chat-${Date.now()}`;
    threadIdRef.current = placeholderId;
    setThreadId(placeholderId);
    autoRestoreAttemptedRef.current = true;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('o8:orchestrator:auto-restore-suppressed', '1');
    }
    cancelPendingPersist();
    singleRuntimeSessionRef.current = null;
    singleRuntimeLaunchPromiseRef.current = null;
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [cancelPendingPersist, clearPolling, orchStream, isOrchestratorMode, operatorDefaults, orchestratorBackend]);

  const handleEnhance = useCallback(async () => {
    if (!input.trim() || enhancing) return;
    setEnhancing(true);
    setPreEnhanceInput(input);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.enhanced) setInput(data.enhanced);
      }
    } catch {
      // silently fail
    } finally {
      setEnhancing(false);
    }
  }, [input, enhancing]);

  const handleUndoEnhance = useCallback(() => {
    if (preEnhanceInput !== null) {
      setInput(preEnhanceInput);
      setPreEnhanceInput(null);
    }
  }, [preEnhanceInput]);

  // ── Thread persistence ──

  useEffect(() => {
    if (!isOrchestratorMode || isChatMode || orchStream.messages.length === 0) return;
    if (!orchStream.messages.some((entry) => entry.role !== 'system')) return;
    setChatMessages((prev) => {
      if (
        prev.length === orchStream.messages.length
        && prev.every((entry, index) => {
          const liveEntry = orchStream.messages[index];
          if (!liveEntry) return false;
          return entry.id === liveEntry?.id
            && entry.role === liveEntry.role
            && entry.text === liveEntry.text
            && entry.thinking === liveEntry.thinking
            && entry.toolCalls === liveEntry.toolCalls
            && entry.statusEvent === liveEntry.statusEvent
            && entry.collide === liveEntry.collide;
        })
      ) {
        return prev;
      }
      return orchStream.messages;
    });
  }, [isChatMode, isOrchestratorMode, orchStream.messages]);

  useEffect(() => {
    if (!isOrchestratorMode) return;

    const msgs = orchStream.messages.length > 0 ? orchStream.messages : chatMessages;

    // If a thread already has a placeholder row (minted on + New), keep
    // writing even while empty so History reflects reality. Once a user
    // message arrives, the title auto-upgrades on the list endpoint.
    if (!threadIdRef.current) {
      if (msgs.length === 0) return;
      const hasUserMessage = msgs.some((m) => m.role === 'user');
      if (!hasUserMessage) return;
      const newId = `thoughts-${Date.now()}`;
      threadIdRef.current = newId;
      setThreadId(newId);
      persistThread(msgs, newId, planText);
      return;
    }

    persistThread(msgs, threadIdRef.current, planText);
  }, [chatMessages, orchStream.messages, isOrchestratorMode, persistThread, planText]);

  const autoRestoreAttemptedRef = useRef(false);
  const AUTO_RESTORE_SUPPRESSED_KEY = 'o8:orchestrator:auto-restore-suppressed';
  // #1459 — live view of "has the user done anything yet". The auto-restore
  // guard below is checked when the effect fires (transcript empty at mount),
  // but its fetches can resolve SECONDS later while the post-relaunch server
  // is still booting. A send in that window appends the user bubble and mints
  // a threadId; applying the restore afterwards would clobber the bubble (and
  // any delivery-failure entry) and re-route the live turn — the observed
  // "sent and nothing happened" total silence.
  const transcriptTouchedRef = useRef(false);
  useEffect(() => {
    transcriptTouchedRef.current = orchStream.messages.length > 0 || chatMessages.length > 0;
  }, [orchStream.messages, chatMessages]);
  useEffect(() => {
    if (suppressAutoRestore) return;
    if (!isOrchestratorMode || isChatMode) return;
    if (autoRestoreAttemptedRef.current) return;
    if (orchStream.messages.length > 0 || chatMessages.length > 0) return;
    autoRestoreAttemptedRef.current = true;
    if (typeof window !== 'undefined' && window.localStorage.getItem(AUTO_RESTORE_SUPPRESSED_KEY) === '1') {
      window.localStorage.removeItem(AUTO_RESTORE_SUPPRESSED_KEY);
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/v2/chat-history/list?include=orchestrator');
        if (!res.ok) return;
        const data = await res.json() as {
          conversations?: Array<{
            tabId: string;
            modifiedAt?: string;
            backend?: OrchestratorBackendId | null;
            agent?: string | null;
          }>;
        };
        const thoughtsThreads = (data.conversations ?? [])
          .filter((t) => t.tabId.startsWith('thoughts-'))
          .sort((a, b) => new Date(b.modifiedAt ?? 0).getTime() - new Date(a.modifiedAt ?? 0).getTime());
        if (thoughtsThreads.length === 0) return;

        const latest = thoughtsThreads[0];
        // Recovery window: only auto-restore if the thread was modified within
        // the last 60s (i.e. accidental reload mid-conversation). Anything
        // older = fresh start; the History sidebar handles intentional resume.
        const modifiedAt = latest.modifiedAt ? new Date(latest.modifiedAt).getTime() : 0;
        const ageMs = Date.now() - modifiedAt;
        if (!modifiedAt || ageMs > 60_000) {
          console.log(`[orchestrator] Skipping auto-restore — latest thread is ${Math.round(ageMs / 1000)}s old (>60s threshold)`);
          return;
        }

        const histRes = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(latest.tabId)}`);
        if (!histRes.ok) return;
        const histData = await histRes.json() as {
          messages?: ThoughtsHistoryMessage[];
          planText?: string | null;
          backend?: OrchestratorBackendId | null;
          agent?: string | null;
        };
        const msgs = mapHistoryMessagesToTranscript(histData.messages ?? []);
        // Hard cap: never auto-restore a thread above 100 messages — the user
        // almost certainly didn't want yesterday's giant thread paged back in
        // every reload. They can still pick it up explicitly from History.
        if (msgs.length > 100) {
          console.log(`[orchestrator] Skipping auto-restore — latest thread has ${msgs.length} messages (>100 cap)`);
          return;
        }
        // #1459 — re-check AFTER the awaits: if a send landed (bubble appended
        // and/or threadId minted) while the restore fetches were in flight,
        // applying the restore now would eat the user's message and re-route
        // the in-flight turn. The user acted first — they win; History still
        // offers the old thread explicitly.
        if (!shouldApplyAutoRestoreAfterFetch({
          transcriptTouched: transcriptTouchedRef.current,
          threadId: threadIdRef.current,
        })) {
          console.log('[orchestrator] Skipping auto-restore — user activity landed while restore was in flight (#1459)');
          return;
        }
        setPlanText(histData.planText ?? null);
        setActiveThreadBackend(histData.backend ?? latest.backend ?? null);
        setActiveThreadAgent(histData.agent ?? latest.agent ?? null);
        if (msgs.length > 0) {
          setChatMessages(msgs);
          orchStream.replaceTranscript(msgs);
          threadIdRef.current = latest.tabId;
          setThreadId(latest.tabId);
        }
      } catch {
        // silent
      }
    })();
  }, [chatMessages.length, isChatMode, isOrchestratorMode, orchStream, suppressAutoRestore]);

  const { showClearToast, handleClearCommand } = useClearCommand({
    isOrchestratorMode,
    orchStreamMessages: orchStream.messages,
    orchStreamPlanText: orchStream.planText,
    chatMessages,
    planText,
    threadIdRef,
    resolvedRepoPath,
    persistThreadNow,
    cancelPendingPersist,
    handleReset,
  });

  const { notice: reloadNotice, dismiss: dismissReloadNotice } = useOrchestratorReloadNotice(
    isOrchestratorMode ? resolvedRepoPath : null,
  );

  const fetchOlderThreadPage = useCallback(async (
    tabId: string,
    before: string,
  ): Promise<ThreadHistoryPage<ThoughtsHistoryMessage> | null> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 6000);
    try {
      const params = new URLSearchParams({ tabId, limit: '60', before });
      const res = await fetch(`/api/v2/chat-history?${params.toString()}`, { signal: controller.signal });
      if (!res.ok) return null;
      return await res.json() as ThreadHistoryPage<ThoughtsHistoryMessage>;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  const prependThreadHistoryPage = useCallback((historyMessages: ThoughtsHistoryMessage[]) => {
    const olderEntries = mapHistoryMessagesToTranscript(historyMessages);
    if (olderEntries.length === 0) return;
    suppressNextTranscriptAutoScrollRef.current = true;
    const liveTranscript = orchStream.messages.length > 0 ? orchStream.messages : chatMessages;
    const entries = mergeTranscriptEntries(olderEntries, liveTranscript);
    setChatMessages(entries);
    orchStream.replaceTranscript(entries);
  }, [chatMessages, orchStream]);

  const { startBackfill, cancelBackfill, onScroll: loadOlderHistoryOnScroll } = useThreadHistoryBackfill({
    fetchPage: fetchOlderThreadPage,
    getScrollContainer: () => chatEndRef.current?.closest('.thoughts-scroll') as HTMLElement | null,
    onPrepend: prependThreadHistoryPage,
  });

  const handleLoadThread = useCallback(async (tabId: string) => {
    const now = Date.now();
    if (inFlightLoadKeyRef.current === tabId) return;
    if (lastLoadKeyRef.current === tabId && now - lastLoadAtRef.current < 800) {
      return;
    }
    inFlightLoadKeyRef.current = tabId;
    lastLoadKeyRef.current = tabId;
    lastLoadAtRef.current = now;
    const myGeneration = ++loadGenerationRef.current;
    cancelBackfill();
    try {
      const fetchHistoryOnce = async (): Promise<Response | null> => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 6000);
        try {
          const params = new URLSearchParams({ tabId, limit: '60' });
          return await fetch(`/api/v2/chat-history?${params.toString()}`, { signal: controller.signal });
        } catch {
          return null;
        } finally {
          window.clearTimeout(timer);
        }
      };
      let res = await fetchHistoryOnce();
      if (!res || !res.ok) res = await fetchHistoryOnce();
      if (!res || !res.ok) {
        // Loud on purpose: a silent return here leaves the tab wearing the
        // thread's TITLE over an empty transcript (stale-header class).
        console.warn(`[orchestrator] loadThread ${tabId} — history fetch failed twice (server booting?)`);
        return;
      }
      const data = await res.json() as {
        messages?: ThoughtsHistoryMessage[];
        planText?: string | null;
        backend?: OrchestratorBackendId | null;
        agent?: string | null;
        page?: ThreadHistoryPage<ThoughtsHistoryMessage>['page'];
      };
      // A newer loadThread started while this one was awaiting the network — its
      // results are stale and must NOT overwrite the newer thread's state.
      if (loadGenerationRef.current !== myGeneration) {
        console.log(`[orchestrator] loadThread ${tabId} — superseded by a newer load, discarding`);
        return;
      }
      const msgs = mapHistoryMessagesToTranscript(data.messages ?? []);
      console.log(`[orchestrator] loadThread ${tabId} — applying ${msgs.length} messages`);
      const isSameOpenThread = threadIdRef.current === tabId;
      const liveTranscript = orchStream.messages.length > 0 ? orchStream.messages : chatMessages;
      const mergedLoad = isSameOpenThread
        ? mergeSameThreadHistoryLoad(liveTranscript, msgs)
        : { entries: msgs, preservedLiveEntries: false };
      // RC1 seam 2 — never reset() a live in-flight turn on a same-thread load.
      // reset() bumps the stream epoch + nulls the assistant, and the durable
      // server turn's remaining answer tokens are then discarded. A same-thread
      // (esp. busy) load is merge-only; only a genuine thread switch resets.
      const loadPlan = resolveThreadLoadPlan({
        isSameOpenThread,
        streamBusy: orchStream.status === 'busy',
        merged: mergedLoad,
      });
      setChatMessages(loadPlan.entries);
      setPlanText(data.planText ?? null);
      setActiveThreadBackend(data.backend ?? null);
      setActiveThreadAgent(data.agent ?? null);
      // Continue the conversation where it lives: adopt the thread's stored
      // backend for the next turn (chip + send both follow) unless the user
      // explicitly picked one this session. Not persisted — the operator
      // default is untouched; new sessions still start on it. `acp` is the
      // one OrchestratorBackendId with no composer setting — map it to its
      // hermes surface name.
      const adoptable: OrchestratorBackendSetting | null = data.backend === 'acp' ? 'hermes' : (data.backend ?? null);
      if (adoptable && backendSourceRef.current !== 'user') {
        backendSourceRef.current = 'thread';
        setOrchestratorBackend(adoptable);
      }
      threadIdRef.current = tabId;
      setThreadId(tabId);
      setWaitingForReply(false);
      clearPolling();
      if (loadPlan.reset) {
        orchStream.reset();
      }
      orchStream.replaceTranscript(loadPlan.entries);
      // A thread reload replaces the transcript wholesale, so deliver any
      // pending Mission-complete card owned by this exact loaded thread.
      if (isOrchestratorMode) {
        const missionCards = getPendingMissionCards(resolvedRepoPath, tabId);
        if (missionCards.length > 0) orchStream.appendLocalEntries(missionCards);
      }
      seenServerEntriesRef.current.clear();
      orchestratorSessionRef.current = null;
      singleRuntimeSessionRef.current = null;
      singleRuntimeLaunchPromiseRef.current = null;
      startBackfill(tabId, data.page);
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      // silent
    } finally {
      // Clear in-flight only if we still own the slot for this tabId —
      // a late-completing load shouldn't unblock a newer load that
      // already claimed the slot for a different tabId.
      if (inFlightLoadKeyRef.current === tabId) {
        inFlightLoadKeyRef.current = null;
      }
    }
  }, [cancelBackfill, chatMessages, clearPolling, orchStream, isOrchestratorMode, resolvedRepoPath, startBackfill]);

  settledAssistantRefetchRef.current = () => {
    const activeThreadId = threadIdRef.current;
    if (!activeThreadId) return;
    lastLoadKeyRef.current = null;
    lastLoadAtRef.current = 0;
    void handleLoadThread(activeThreadId);
  };
  const suggestions = useMemo(
    () => generateSuggestions(agents.filter(isRunnableCliSession), sessionTargets),
    [agents, sessionTargets],
  );
  const displayMessages = useMemo(() => {
    if (!isOrchestratorMode || isChatMode) return chatMessages;
    // Loaded history + the live stream overlap after a mid-conversation reload;
    // the same user turn can survive in both the restored (persisted id) and
    // the live-minted (optimistic id) form. Dedupe so it never double-renders.
    const base = orchStream.messages.length > 0 ? orchStream.messages : chatMessages;
    return dedupeDisplayMessages(base);
  }, [chatMessages, isChatMode, isOrchestratorMode, orchStream.messages]);
  // See `composerRepoLabelBase` for the rationale — derived here so
  // the empty-state check matches the empty-state-override condition.
  const composerRepoLabel = displayMessages.length === 0 ? null : composerRepoLabelBase;
  const displayWaiting = isChatMode ? false : isOrchestratorMode ? orchStream.status === 'busy' : (waitingForReply || (isSingleMode && singleRuntimeSpawning));
  const displayPlanText = isOrchestratorMode && !isChatMode && planText?.trim() ? planText.trim() : null;
  const hasAssistantActivity = displayMessages.some((message) => message.role !== 'user');
  const activeBackendIdentity = isOrchestratorMode
    ? (composerBackendTurnOverride(orchestratorBackend) ?? orchestratorBackend ?? activeThreadBackend ?? null)
    : null;
  const activeBackendLabel = activeBackendIdentity
    // No agent: the composer chip predicts the NEXT turn, and sends carry no
    // agent — ws-server resolves the backend's DEFAULT. Passing the loaded
    // thread's historical agent (e.g. an old OpenClaw 'mister-scribe' thread)
    // mislabels a turn that will actually run as the default agent (adversarial
    // review 2026-07-15). The label falls back to the default (OpenClaw → 'main').
    ? orchestratorBackendDisplayLabel({ backend: activeBackendIdentity, agent: null })
    : null;
  // A thread-bound tab whose history (incl. backend) hasn't loaded yet must
  // not claim the default backend — "…" is the truthful label until the load
  // lands (threadId flips non-null). See expectsThreadLoad prop doc.
  const backendHydrating = isOrchestratorMode && expectsThreadLoad && threadId === null;
  const activeTargetLabel = isChatMode
    ? selectedChatModel.label
    : isSingleMode
      ? orchestratorRuntimeTone(singleRuntime).label
      : isOrchestratorMode
        ? (backendHydrating ? '…' : activeBackendLabel ?? 'Claude Code')
        : (targetAgent?.name ?? orchestratorRuntimeTone(preferredRuntime).label);
  const activeTargetColor = isSingleMode
    ? orchestratorRuntimeTone(singleRuntime).color
    : isOrchestratorMode
      ? '#e07a3a'
      : (targetAgent?.color ?? orchestratorRuntimeTone(preferredRuntime).color);
  // #771 — Augment Intent-style chip row under the last assistant message.
  // Only fires in orchestrator mode; CLI lanes still steer via the composer.
  const {
    lastAssistantId: suggestedReplyMessageId,
    chipsForLastAssistant,
    isDismissedForLastAssistant: suggestedRepliesCollapsed,
    isPlaceholderVisibleForLastAssistant: suggestedRepliesPending,
    dismissChips: dismissSuggestedReplies,
    restoreChips: restoreSuggestedReplies,
  } = useSuggestedReplies({
    // Suggested-reply chips cut 2026-06-22 (operator: "i dont think we need
    // those"). Disabled at the source so the hook generates nothing and every
    // downstream prop stays wired (no dead-code ripple); flip back to
    // `isOrchestratorMode && !isChatMode` to restore.
    enabled: false,
    messages: displayMessages,
    isStreaming: displayWaiting,
  });

  // Memoize so a render triggered by composer state (input typing) doesn't
  // hand ChatMessageList a fresh `topContent` ref each keystroke.
  const transcriptTopContent = useMemo(() => displayPlanText ? (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      <CollapsiblePlanCard key={`plan-${threadId ?? 'active'}`} text={displayPlanText} />
    </div>
  ) : null, [displayPlanText, threadId]);

  useEffect(() => {
    onChromeChange({
      activeTargetLabel,
      waitingForReply: displayWaiting,
      hasMessages: displayMessages.length > 0,
      threadId,
      messageCount: displayMessages.length,
      orchestratorBusyState: orchStream.busyState,
    });
  }, [activeTargetLabel, displayMessages.length, displayWaiting, onChromeChange, orchStream.busyState, threadId]);

  // Fire onChatSummary whenever the latest user message changes in any chat
  // surface (orchestrator / chat / single runtime). The parent stashes it on
  // the tab record and the tab strip truncates it to ~3 words for the visible
  // label so the user can see at a glance what each tab is about.
  const lastReportedChatSummaryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onChatSummary) return;
    const source = isOrchestratorMode && !isChatMode ? displayMessages : chatMessages;
    const latestUser = [...source].reverse().find((entry) => (
      entry.role === 'user' && entry.text.trim()
    ));
    const text = latestUser?.text?.trim() ?? '';
    if (!text || text === lastReportedChatSummaryRef.current) return;
    lastReportedChatSummaryRef.current = text;
    onChatSummary(text);
  }, [chatMessages, displayMessages, isChatMode, isOrchestratorMode, onChatSummary]);

  // #1095 / #1096 — turn-end summary card. Tracks the turn lifecycle so the
  // ChatMessageList can render the rolled-up TurnSummaryCard (with the inner
  // ChatActionCard for "Edited N files" + Review/Undo) right after the last
  // assistant message of the turn.
  const [turnSummary, setTurnSummary] = useState<TurnSummary | null>(null);
  const turnStartRef = useRef<
    | { startedAt: number; messageCountAtStart: number; runningTotalAtStart: number }
    | null
  >(null);
  const prevOrchStatusRef = useRef<typeof orchStream.status>(orchStream.status);
  useEffect(() => {
    if (!isOrchestratorMode || isChatMode) {
      prevOrchStatusRef.current = orchStream.status;
      return;
    }
    const prev = prevOrchStatusRef.current;
    const next = orchStream.status;
    prevOrchStatusRef.current = next;

    if (prev !== 'busy' && next === 'busy') {
      // New turn started — clear stale summary and snapshot the baseline.
      setTurnSummary(null);
      turnStartRef.current = {
        startedAt: Date.now(),
        messageCountAtStart: displayMessages.length,
        runningTotalAtStart: orchStream.runningTotal,
      };
      return;
    }

    if (prev === 'busy' && next === 'ready') {
      const start = turnStartRef.current;
      if (!start) return;
      const newEntries = displayMessages.slice(start.messageCountAtStart);
      if (newEntries.length === 0) return;

      const toolNamesAll: string[] = [];
      let toolCount = 0;
      let firstAssistantId: string | null = null;
      let lastAssistantId: string | null = null;
      let turnHadEdits = false;
      for (const entry of newEntries) {
        if (entry.role === 'assistant') {
          if (!firstAssistantId) firstAssistantId = entry.id;
          lastAssistantId = entry.id;
        }
        if (entry.toolCalls?.length) {
          for (const call of entry.toolCalls) {
            toolCount += 1;
            const name = call.name?.trim();
            if (name) toolNamesAll.push(name);
            if (isFileEditCall(call)) turnHadEdits = true;
          }
        }
      }
      if (!lastAssistantId) return;

      const distinctNames: string[] = [];
      const seen = new Set<string>();
      for (const name of toolNamesAll) {
        if (!seen.has(name)) {
          seen.add(name);
          distinctNames.push(name);
        }
      }

      const elapsedMs = Math.max(0, Date.now() - start.startedAt);
      const tokensUsed = Math.max(0, orchStream.runningTotal - start.runningTotalAtStart);
      const baseSummary: TurnSummary = {
        assistantMessageId: lastAssistantId,
        firstAssistantMessageId: firstAssistantId,
        elapsedMs,
        toolCount,
        toolNames: distinctNames.slice(0, 3),
        toolNameTotal: distinctNames.length,
        filesEditedCount: 0,
        filePaths: [],
        tokensUsed,
        repoPath: resolvedRepoPath ?? null,
      };
      setTurnSummary(baseSummary);
      turnStartRef.current = null;

      // False-attribution guard (2026-07-13): the workspace snapshot counts
      // EVERY working-tree change, including edits this turn never made
      // (other agents, pre-existing dirt). Only stamp "Edited N files" when
      // the turn actually ran a file-edit tool.
      if (resolvedRepoPath && turnHadEdits) {
        const repoForFetch = resolvedRepoPath;
        const targetAssistantId = lastAssistantId;
        void (async () => {
          try {
            const response = await fetch(`/api/review/workspace?workspace=${encodeURIComponent(repoForFetch)}&strictBranch=1`);
            if (!response.ok) return;
            const snapshot = await response.json() as { changedFiles?: Array<{ path?: string }> };
            const paths = (snapshot.changedFiles ?? [])
              .map((file) => file?.path)
              .filter((p): p is string => typeof p === 'string' && p.length > 0);
            setTurnSummary((prevSummary) => (
              prevSummary && prevSummary.assistantMessageId === targetAssistantId
                ? { ...prevSummary, filesEditedCount: paths.length, filePaths: paths }
                : prevSummary
            ));
          } catch {
            // Swallow — card still shows the elapsed/tools/tokens summary.
          }
        })();
      }
    }
  }, [displayMessages, isChatMode, isOrchestratorMode, orchStream.runningTotal, orchStream.status, resolvedRepoPath]);

  // Clear the summary when the thread changes — stale cards from a prior
  // thread should not bleed into the new one.
  useEffect(() => {
    setTurnSummary(null);
    turnStartRef.current = null;
  }, [threadId, resolvedRepoPath, isOrchestratorMode, isChatMode]);

  // #587 — publish live transcript + running token total into the context
  // residency provider so the ContextInspector side panel (mounted at the
  // OrchestratorTab level) can render rows without prop-drilling.
  const residency = useOrchestratorContextResidency();
  useEffect(() => {
    if (!residency) return;
    if (!isOrchestratorMode || isChatMode) {
      residency.publish({ messages: [], runningTotal: 0, activeAssistantId: null });
      return;
    }
    let activeAssistantId: string | null = null;
    if (orchStream.status === 'busy') {
      for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
        if (displayMessages[index]?.role === 'assistant') {
          activeAssistantId = displayMessages[index].id;
          break;
        }
      }
    }
    residency.publish({
      messages: displayMessages,
      runningTotal: orchStream.runningTotal,
      activeAssistantId,
    });
  }, [displayMessages, isChatMode, isOrchestratorMode, orchStream.runningTotal, orchStream.status, residency]);

  // Ref used so sendNow() can flush the latest input value without a re-render.
  const latestInputRef = useRef('');
  useEffect(() => { latestInputRef.current = input; }, [input]);

  const startSlashOrchestration = useCallback(async (request: SlashOrchestrationRequest) => {
    const localEntriesAfterUser = request.commandEntry ? [request.commandEntry] : [];
    orchStream.send(request.prompt, {
      permissionMode,
      backend: composerBackendTurnOverride(orchestratorBackend),
      thinkingEffort,
      model: orchestratorModel,
      displayMessage: request.displayMessage,
      localEntriesAfterUser,
      orchestrationMode: resolveComposerExecutionMode('multitask', swarmEnabled, soloOrchestrator),
      collide: collideEnabled,
    });
  }, [orchStream, orchestratorBackend, orchestratorModel, permissionMode, thinkingEffort, swarmEnabled, soloOrchestrator, collideEnabled]);

  const runLocalOrchestratorSlash = useCallback(async (rawInput: string) => {
    if (!isOrchestratorMode || isChatMode) return false;

    const parsedCommand = parseOrchestratorSlashCommand(rawInput);
    const suppressCommandEntries = parsedCommand?.command.name === 'clear';
    const handled = await executeOrchestratorSlashCommand(rawInput, {
      repoPath: resolvedRepoPath,
      transcript: displayMessages,
      missionState,
      runningTotal: orchStream.runningTotal,
      currentModel: orchestratorModel,
      setCurrentModel: (model) => {
        setOrchestratorModel(model);
        writeStoredOrchestratorModel(resolvedRepoPath, model);
      },
      replaceTranscript: orchStream.replaceTranscript,
      compactNow: orchStream.compactNow,
      resetRemoteSession,
      queuePrelude: (prelude, mode) => queueOrchestratorSessionPrelude(resolvedRepoPath, prelude, mode, threadIdRef.current),
      searchArchive: (query, limit) => searchOrchestratorArchive(resolvedRepoPath, query, limit),
      fetchTelemetry: async () => {
        const snapshot = await orchStream.fetchTelemetrySnapshot();
        return {
          totalTokens: snapshot.totalTokens,
          estimatedCostUsd: snapshot.estimatedCostUsd,
          model: snapshot.model,
        };
      },
      startOrchestration: startSlashOrchestration,
      appendEntries: suppressCommandEntries ? () => {} : orchStream.appendLocalEntries,
      clearThread: handleClearCommand,
      // Session-rules add-path (Q ruling 2026-07-11) — `/rule` POSTs directly,
      // `/rules` opens the manager. Both reach the chip via window events so
      // there's no prop-drilling through the composer tree.
      addSessionRule: async (text: string) => {
        const threadId = threadIdRef.current;
        if (!threadId) return false;
        try {
          const res = await fetch('/api/orchestrator/session-rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId, text }),
          });
          const data = await res.json().catch(() => null) as { ok?: boolean } | null;
          if (data?.ok) {
            window.dispatchEvent(new CustomEvent('o8:session-rules-changed'));
            return true;
          }
        } catch { /* ignore */ }
        return false;
      },
      openRulesManager: () => window.dispatchEvent(new CustomEvent('o8:open-session-rules')),
    });
    if (!handled.handled) return false;
    latestInputRef.current = '';
    return true;
  }, [
    displayMessages,
    handleClearCommand,
    isChatMode,
    isOrchestratorMode,
    missionState,
    orchStream,
    orchestratorModel,
    resetRemoteSession,
    resolvedRepoPath,
    startSlashOrchestration,
  ]);

  const handleTaskSend = useCallback(async (explicitText?: string) => {
    const rawMsg = (explicitText ?? input).trim();
    if (!rawMsg) return;
    // The mode directive goes to the model, while bubbles and auto-titles keep
    // the operator's exact words. Slash commands pass through untouched.
    const turnOrchestrationMode = resolveComposerExecutionMode(composerModeRef.current, swarmEnabled, soloOrchestrator);
    const promptMode = turnOrchestrationMode === 'fusion' && composerModeRef.current === 'solo'
      ? 'multitask'
      : composerModeRef.current;
    const { displayMessage, wireMessage } = composeComposerModeMessage(rawMsg, promptMode);

    track('orchestrator.message'); // coarse usage signal (analytics epic #1249) — no content

    // Mode-routing slash prefix (`/chat ...`, `/codex ...`, `/gemini ...`,
    // `/opencode ...`) — peel the prefix, stash the body for the spawned
    // tab to pick up on mount, and dispatch to the appropriate spawn
    // handler instead of dispatching on this tab. Only honor when the
    // tab is not lockedMode (Fleet-level Orchestrator tabs only).
    if (!lockedMode) {
      const routing = parseModeRoutingPrefix(wireMessage);
      if (routing) {
        if (routing.target.kind === 'single' && onSpawnSingleTab) {
          stashPendingComposerDraft(routing.target, routing.body);
          onSpawnSingleTab(routing.target.runtime);
          setInput('');
          latestInputRef.current = '';
          return;
        }
        if (routing.target.kind === 'chat' && onSpawnChatTab) {
          stashPendingComposerDraft(routing.target, routing.body);
          onSpawnChatTab();
          setInput('');
          latestInputRef.current = '';
          return;
        }
        if (routing.target.kind === 'fleet') {
          const body = routing.body.trim();
          if (!body) {
            setInput('');
            latestInputRef.current = '';
            return;
          }
          if (orchStream.status === 'busy') return;

          const attachments = attachedImages.length > 0
            ? attachedImages.map((img) => ({ dataUri: img.dataUri, name: img.name }))
            : undefined;
          setInput('');
          latestInputRef.current = '';
          orchStream.send(body, {
            permissionMode,
            backend: composerBackendTurnOverride(orchestratorBackend),
            thinkingEffort,
            model: orchestratorModel,
            orchestrationMode: resolveComposerExecutionMode('multitask', swarmEnabled, soloOrchestrator),
            collide: collideEnabled,
            ...(attachments ? { attachments } : {}),
          });
          clearAttachments();
          return;
        }
        // No spawn handler available — fall through and dispatch as a
        // normal Fleet message so the user isn't silently swallowed.
      }
    }

    const effectiveWaiting = isChatMode ? waitingForReply : isOrchestratorMode ? orchStream.status === 'busy' : waitingForReply;
    if (effectiveWaiting) return;

    if (isChatMode) {
      setInput('');
      latestInputRef.current = '';
      const userEntry = createChatUserEntry(displayMessage);
      const assistantEntry = createChatAssistantEntry(selectedChatModel, (userEntry.timestamp ?? Date.now()) + 1);
      let assistantText = '';
      setChatMessages((prev) => [...prev, userEntry, assistantEntry]);
      clearAttachments();
      setWaitingForReply(true);
      const streamController = chatStreamRequest.begin();
      try {
        // Chat-mode streams through scratch-chat; modelOverride pins the
        // per-tab picker choice server-side.
        await sendScratchChatMessage({
          history: chatMessages,
          message: wireMessage,
          context: resolvedRepoPath ? { repoPath: resolvedRepoPath } : undefined,
          enableTools: true,
          modelOverride: chatOpenrouterModel ?? null,
          signal: streamController.signal,
          onDelta: (text) => {
            assistantText += text;
            setChatMessages((prev) => prev.map((entry) => (
              entry.id === assistantEntry.id ? { ...entry, text: assistantText } : entry
            )));
          },
          onToolCall: (call) => {
            setChatMessages((prev) => prev.map((entry) => (
              entry.id === assistantEntry.id ? mergeToolCallIntoEntry(entry, call) : entry
            )));
          },
          onToolResult: (result) => {
            setChatMessages((prev) => prev.map((entry) => (
              entry.id === assistantEntry.id ? mergeToolResultIntoEntry(entry, result) : entry
            )));
          },
        });
      } catch (error) {
        const message = streamController.signal.aborted || isAbortError(error)
          ? 'Stream paused because this tab became inactive. Send again when you return.'
          : error instanceof Error ? error.message : 'Chat request failed.';
        setChatMessages((prev) => prev.map((entry) => (
          entry.id === assistantEntry.id
            ? { ...entry, text: assistantText ? `${assistantText}\n\n${message}` : message }
            : entry
        )));
      } finally {
        chatStreamRequest.finish(streamController);
        setWaitingForReply(false);
      }
      return;
    }

    if (isSingleMode) {
      setInput('');
      latestInputRef.current = '';

      const userMsg: MobileTranscriptEntry = {
        id: `local-user-${Date.now()}`,
        role: 'user',
        text: displayMessage,
        timestamp: Date.now(),
        timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setChatMessages((prev) => [...prev, userMsg]);
      clearAttachments();
      setWaitingForReply(true);

      try {
        const launch = await ensureSingleRuntimeSession(wireMessage);
        if (!launch?.sessionKey) {
          throw new Error('Unable to launch selected runtime');
        }
        const { sessionKey } = launch;
        await captureServerSnapshot(sessionKey);
        if (!launch.launched) {
          const response = await fetch('/api/runtime/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'steer', surfaceId: sessionKey, message: wireMessage }),
          });

          if (!response.ok) {
            const body = await response.json().catch(() => null) as { note?: string; error?: string } | null;
            const reason = body?.note?.trim() || body?.error?.trim();
            throw new Error(reason || 'Send failed');
          }
        }

        startPollingForSession(sessionKey);
      } catch (err) {
        const runtimeLabel = orchestratorRuntimeTone(singleRuntime).label;
        const rawMessage = err instanceof Error ? err.message.trim() : '';
        const fallback = `Unable to reach the selected ${runtimeLabel} lane. Make sure the runtime is available.`;
        setChatMessages((prev) => [
          ...prev,
          {
            id: `local-error-${Date.now()}`,
            role: 'system',
            text: rawMessage || fallback,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
        setWaitingForReply(false);
      }
      return;
    }

    if (isOrchestratorMode && await runLocalOrchestratorSlash(wireMessage)) {
      setInput('');
      return;
    }

    if (isOrchestratorMode) {
      const attachments = attachedImages.length > 0
        ? attachedImages.map((img) => ({ dataUri: img.dataUri, name: img.name }))
        : undefined;
      const outgoing = wireMessage;
      const orchOptions = {
        permissionMode,
        backend: composerBackendTurnOverride(orchestratorBackend),
        thinkingEffort,
        model: orchestratorModel,
        orchestrationMode: turnOrchestrationMode,
        collide: collideEnabled,
        ...(attachments ? { attachments } : {}),
      };
      if (!resolvedRepoPath) {
        // No workspace — orchStream.send() appends a guiding "add a repo" notice.
        // KEEP the composer text so the user's message isn't lost to the void
        // (the fresh-user "I typed and nothing happened" trap). Leave the toggle
        // armed — nothing dispatched, so the clarify intent still stands.
        orchStream.send(outgoing, { ...orchOptions, displayMessage });
        return;
      }
      setInput('');
      orchStream.send(outgoing, { ...orchOptions, displayMessage });
      clearAttachments();
      return;
    }

    setInput('');

    const userMsg: MobileTranscriptEntry = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      text: displayMessage,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    clearAttachments();

    const sessionKey = targetSessionKey;
    if (!sessionKey) return;
    setWaitingForReply(true);

    try {
      await captureServerSnapshot(sessionKey);

      const isRuntimeSession = isRuntimeSessionKey(sessionKey);
      const response = await fetch(isRuntimeSession ? '/api/runtime/action' : '/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isRuntimeSession
          ? JSON.stringify({ action: 'steer', surfaceId: sessionKey, message: wireMessage })
          : JSON.stringify({ action: 'resume', sessionKey, message: wireMessage }),
      });

      if (!response.ok) {
        throw new Error('Send failed');
      }

      startPolling();
    } catch {
      const laneRuntimeLabel = targetAgent ? getRuntimeCapability(targetAgent.runtime).label : 'CLI';
      setChatMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'system',
          text: `Unable to reach the selected CLI lane. Make sure the ${laneRuntimeLabel} session is available.`,
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setWaitingForReply(false);
    }
  }, [attachedImages, captureServerSnapshot, chatMessages, chatOpenrouterModel, chatStreamRequest, clearAttachments, ensureSingleRuntimeSession, input, isChatMode, isOrchestratorMode, isSingleMode, lockedMode, onSpawnChatTab, onSpawnSingleTab, orchStream, orchestratorBackend, orchestratorModel, permissionMode, resolvedRepoPath, runLocalOrchestratorSlash, selectedChatModel, singleRuntime, startPolling, startPollingForSession, targetAgent, targetSessionKey, thinkingEffort, swarmEnabled, soloOrchestrator, collideEnabled, waitingForReply]);

  const sendNow = useCallback((text?: string, options?: ThoughtsSendNowOptions) => {
    const msg = (typeof text === 'string' ? text : latestInputRef.current).trim();
    if (!msg) return false;
    if (isChatMode) {
      if (waitingForReply) return false;
      setInput(msg);
      latestInputRef.current = msg;
      setTimeout(() => { void handleTaskSend(msg); }, 0);
      return true;
    }
    if (isOrchestratorMode) {
      if (orchStream.status === 'busy') return false;
      void (async () => {
        if (await runLocalOrchestratorSlash(msg)) {
          setInput('');
          latestInputRef.current = '';
          return;
        }
        setInput('');
        latestInputRef.current = '';
        const attachments = options?.attachments ?? (attachedImages.length > 0
          ? attachedImages.map((img) => ({ dataUri: img.dataUri, name: img.name }))
          : undefined);
        orchStream.send(msg, {
          permissionMode,
          backend: composerBackendTurnOverride(orchestratorBackend),
          thinkingEffort,
          model: orchestratorModel,
          orchestrationMode: resolveComposerExecutionMode(composerModeRef.current, swarmEnabled, soloOrchestrator),
          collide: collideEnabled,
          ...(attachments ? { attachments } : {}),
        });
        if (!options?.attachments) clearAttachments();
      })();
      return true;
    }

    setInput(msg);
    latestInputRef.current = msg;
    setTimeout(() => { void handleTaskSend(msg); }, 0);
    return true;
  }, [attachedImages, clearAttachments, handleTaskSend, isChatMode, isOrchestratorMode, orchStream, orchestratorBackend, orchestratorModel, permissionMode, runLocalOrchestratorSlash, thinkingEffort, swarmEnabled, soloOrchestrator, collideEnabled, waitingForReply]);

  const dispatchBufferedOrchestratorSend = useCallback((text: string, images: Array<{ name: string; dataUri: string }>) => {
    if (!isOrchestratorMode) return null;
    const turnOrchestrationMode = resolveComposerExecutionMode(composerModeRef.current, swarmEnabled, soloOrchestrator);
    const promptMode = turnOrchestrationMode === 'fusion' && composerModeRef.current === 'solo'
      ? 'multitask'
      : composerModeRef.current;
    const { displayMessage, wireMessage } = composeComposerModeMessage(text, promptMode);
    track('orchestrator.message');
    return orchStream.send(wireMessage, {
      permissionMode,
      backend: composerBackendTurnOverride(orchestratorBackend),
      thinkingEffort,
      model: orchestratorModel,
      displayMessage,
      orchestrationMode: turnOrchestrationMode,
      collide: collideEnabled,
      ...(images.length > 0 ? { attachments: images } : {}),
    });
  }, [collideEnabled, isOrchestratorMode, orchStream, orchestratorBackend, orchestratorModel, permissionMode, soloOrchestrator, swarmEnabled, thinkingEffort]);

  const { sendBuffer, handleSend: handleComposerSend } = useDefaultComposerSendBuffer({
    active: isOrchestratorMode,
    busy: displayWaiting,
    threadId,
    repoPath: resolvedRepoPath,
    attachedImages,
    latestInputRef,
    inputRef,
    setInput,
    addAttachedImage,
    clearAttachments,
    dispatch: dispatchBufferedOrchestratorSend,
    interrupt: orchStream.interrupt,
    undoSend: orchStream.undoSend,
    shouldBypass: (text) => Boolean(parseOrchestratorSlashCommand(text) || parseModeRoutingPrefix(text)),
    sendUnbuffered: (text) => { void handleTaskSend(text); },
  });

  const handleCopyMarkdownRef = useRef<() => Promise<boolean>>(async () => false);

  const fillInput = useCallback((text: string) => {
    if (!text) return;
    setInput((prev) => {
      const trimmed = prev.trimEnd();
      if (!trimmed) return text;
      const needsSpace = !/\s$/.test(prev);
      return `${prev}${needsSpace ? ' ' : ''}${text}`;
    });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // Dictation bridge — register this composer with the dashboard-level
  // DictationHost on focus. Registration is sticky: clicking the mic
  // button blurs the textarea, but the host should still route the
  // polished transcript here. Another composer focusing will take over;
  // unmount clears the registration.
  const dictationHost = useDictationHostOptional();
  // Pull the stable callback out — depending on the whole host value
  // would re-run this effect every state transition (snapshotState is
  // in the host's memo deps), unregistering us mid-recording.
  const setActiveComposer = dictationHost?.setActiveComposer;
  useEffect(() => {
    if (!setActiveComposer) return;
    const node = inputRef.current;
    if (!node) return;
    const claim = () => {
      setActiveComposer({ node, fill: fillInput });
    };
    // Eager-claim on mount so the user can press the mic button or
    // Ctrl+Z without first clicking into the textarea.
    claim();
    node.addEventListener('focus', claim);
    return () => {
      node.removeEventListener('focus', claim);
      setActiveComposer(null);
    };
  }, [setActiveComposer, fillInput]);

  useImperativeHandle(ref, () => ({
    focusInput() {
      inputRef.current?.focus();
    },
    reset: handleReset,
    loadThread: handleLoadThread,
    sendNow,
    fillInput,
    copyAsMarkdown: () => handleCopyMarkdownRef.current(),
  }), [handleReset, handleLoadThread, sendNow, fillInput]);

  const fallbackEmptyState = useMemo(() => (
    <EmptyStateCard
      isOrchestratorMode={isOrchestratorMode}
      targetAgent={targetAgent}
      activeTargetLabel={activeTargetLabel}
      activeTargetColor={activeTargetColor}
      thoughtsElevatedSurface={thoughtsElevatedSurface}
      thoughtsElevatedBorder={thoughtsElevatedBorder}
      thoughtsElevatedShadow={thoughtsElevatedShadow}
      suggestions={suggestions}
      onSelectSuggestion={(suggestion) => {
        setTargetAgentKey(suggestion.agent.key);
        setInput(suggestion.action);
        setTimeout(() => inputRef.current?.focus(), 50);
      }}
    />
  ), [
    activeTargetColor,
    activeTargetLabel,
    isOrchestratorMode,
    suggestions,
    targetAgent,
    thoughtsElevatedBorder,
    thoughtsElevatedShadow,
    thoughtsElevatedSurface,
  ]);

  const handleSlashCommand = useCallback((cmd: string) => {
    setInput(cmd);
    latestInputRef.current = cmd;
    void handleTaskSend(cmd);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [handleTaskSend]);

  const handleEffortChange = useCallback((next: ThinkingEffort) => {
    thinkingPreferenceTouchedRef.current = true;
    const nextOverride = next === 'adaptive' ? null : next;
    setThinkingOverride(nextOverride);
    writeStoredOrchestratorThinkingOverride(nextOverride);
  }, []);

  const handleBackendChange = useCallback((next: OrchestratorBackendSetting) => {
    backendSourceRef.current = 'user';
    setOrchestratorBackend(next);
    setActiveThreadBackend(composerBackendTurnOverride(next) ?? null);
    setActiveThreadAgent(null);
    void fetch('/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orchestratorBackend: next }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { values?: Partial<ThoughtsOperatorDefaults>; error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to persist orchestrator backend.');
        }
        return payload;
      })
      .then((payload: { values?: Partial<ThoughtsOperatorDefaults> } | null) => {
        if (!payload?.values) return;
        const defaults: ThoughtsOperatorDefaults = {
          ...operatorDefaults,
          ...payload.values,
        };
        setOperatorDefaults(defaults);
        setOrchestratorBackend(resolveActiveComposerBackend(defaults));
      })
      .catch((error) => {
        console.log('[thoughts] failed to persist orchestrator backend', error);
        setOrchestratorBackend(resolveActiveComposerBackend(operatorDefaults));
      });
  }, [operatorDefaults]);

  const handleCopyMarkdown = useCallback(async (): Promise<boolean> => {
    if (displayMessages.length === 0) return false;
    if (!navigator.clipboard?.writeText) {
      console.log('[export-thread] Clipboard API unavailable for active thread export');
      setExportFeedback('error');
      return false;
    }

    setExportFeedback('copying');
    try {
      const markdown = serializeThreadToMarkdown(displayMessages, { threadId });
      await navigator.clipboard.writeText(markdown);
      console.log(`[export-thread] Copied active thread ${threadId ?? 'unsaved-thread'} to clipboard`);
      setExportFeedback('copied');
      return true;
    } catch (error) {
      console.log('[export-thread] Failed to copy active thread markdown', error);
      setExportFeedback('error');
      return false;
    }
  }, [displayMessages, setExportFeedback, threadId]);

  useEffect(() => {
    handleCopyMarkdownRef.current = handleCopyMarkdown;
  }, [handleCopyMarkdown]);

  // Native Claude scouts (Task-tool sub-agents) fanned out this turn. They
  // aren't packets, so we surface them in the live crew card by reading the
  // active assistant turn's Task tool calls. Status is tied to the turn
  // (busy → running) rather than per-tool completion: parallel scouts fire
  // together and the serial tool-done heuristic can't track them individually.
  const orchestratorScouts: SwarmScoutView[] = (() => {
    if (!isOrchestratorMode) return [];
    const assistants = displayMessages.filter((message) => message.role === 'assistant');
    const lastAssistant = assistants[assistants.length - 1];
    const tasks = (lastAssistant?.toolCalls ?? []).filter(
      (tool) => tool.name === 'Task' || tool.name.toLowerCase() === 'task',
    );
    return tasks.map((tool, index) => {
      const args = tool.args ?? {};
      const description = typeof args.description === 'string' ? args.description.trim() : '';
      const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type.trim() : '';
      const label = description || subagentType || `Scout ${index + 1}`;
      const status: SwarmScoutView['status'] =
        tool.status === 'done' ? 'done' : displayWaiting ? 'running' : 'done';
      return { id: tool.id ?? `scout-${index}`, label, status };
    });
  })();

  return (
    <div
      style={{
        // containerType: 'size' makes `cqh` resolve to the local chat
        // column instead of the viewport — the compose-first composer
        // lift uses `translateY(-32cqh)` which now scales with the
        // workspace area (shrinks when the bottom panel is open).
        // 'display: contents' would skip layout — we need a real flex
        // column so the chat list + composer flow correctly.
        containerType: 'size',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      } as React.CSSProperties}
    >
      {displayMessages.length > 0 && showInlineExport ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 10,
            paddingRight: 16,
            paddingBottom: 0,
            paddingLeft: 16,
            flexShrink: 0,
          }}
        >
          <ThreadExportButton state={exportState} onClick={() => { void handleCopyMarkdown(); }} />
        </div>
      ) : null}

      <div
        ref={composerDropHostRef}
        onDragOver={attachmentDragHandlers.onDragOver}
        onDragLeave={attachmentDragHandlers.onDragLeave}
        onDrop={attachmentDragHandlers.onDrop}
        style={{
          position: 'relative',
          display: 'flex',
          flex: 1,
          minHeight: 0,
          background: thoughtsBodyBackground,
          outline: attachmentDragOver ? '2px solid var(--t-accent)' : 'none',
          outlineOffset: -2,
        }}
      >
        {/* Transcript fills; the optional side rail sits to its RIGHT so the
            composer below spans the full panel width (Q ruling 2026-07-11). */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <ChatMessageList
            ref={chatEndRef}
            displayMessages={displayMessages}
            displayWaiting={displayWaiting}
            repoPath={resolvedRepoPath}
            activeTargetLabel={activeTargetLabel}
            activeTargetColor={activeTargetColor}
            thoughtsMutedGlass={thoughtsMutedGlass}
            thoughtsElevatedBorder={thoughtsElevatedBorder}
            thoughtsElevatedShadow={thoughtsElevatedShadow}
            emptyStateOverride={emptyStateOverride}
            emptyStateFallback={fallbackEmptyState}
            topContent={transcriptTopContent}
            bottomContent={isOrchestratorMode && displayMessages.length > 0 ? (
              <SwarmStatusCard
                packets={missionState?.packets ?? []}
                scouts={orchestratorScouts}
                onFocusPacket={onLaunchPacket ? (packet) => { void onLaunchPacket(packet); } : undefined}
              />
            ) : null}
            isOrchestratorMode={isOrchestratorMode}
            suggestedReplyMessageId={suggestedReplyMessageId}
            suggestedReplies={chipsForLastAssistant}
            suggestedRepliesCollapsed={suggestedRepliesCollapsed}
            suggestedRepliesPending={suggestedRepliesPending}
            onSelectSuggestion={(chip) => { sendNow(chip); }}
            onDismissSuggestions={dismissSuggestedReplies}
            onRestoreSuggestions={restoreSuggestedReplies}
            turnSummary={turnSummary}
            onRetryDelivery={orchStream.retryPendingSend}
            onScroll={loadOlderHistoryOnScroll}
          />
        </div>
        {transcriptSideRail ?? null}
      </div>
      <ChatToastStack
        reloadNotice={reloadNotice}
        onDismissReloadNotice={dismissReloadNotice}
        showClearToast={showClearToast}
        showDraftClearedToast={showDraftClearedToast}
        thoughtsBodyBackground={thoughtsBodyBackground}
      />

      <div
        // Compose-first lift — when the transcript is empty, the composer
        // rises from its bottom-of-column rest position so the operator
        // types in the middle of the canvas (Codex / Cortex pattern). On
        // first message it eases back to 0 and the transcript fills the
        // space above.
        //
        // Lift is expressed in `cqh` (container query height) rather than
        // `vh` so the translation scales with the actual workspace area
        // — when the bottom panel halves the workspace, the lift halves
        // too. The parent ThoughtsChatPanel root carries
        // `containerType: 'size'` (set below) to make `cqh` resolve to
        // the local column, not the viewport.
        //
        // 38cqh on a full ~960 px workspace ≈ 365 px lift. With the
        // title+quick-action block sitting around 28cqh from the top
        // and ~80 px tall, the composer lands just under the question
        // pills with a tight gap (operator pass 2026-05-27). On a
        // shrunken 600 px workspace, the same 38cqh shrinks to ~228
        // px so the relationship holds when the bottom panel opens.
        style={{
          flexShrink: 0,
          // Compose-first positioning is handled by the empty-state flex layout
          // (OrchestratorEmptyState centers the title + quick-actions in the list
          // area; the composer rests at the bottom of the column). The old
          // translateY(-38cqh) lift was a *visual* move that reserved no space, so
          // it painted the composer over the title/quick-actions whenever the
          // hand-tuned cqh offsets didn't match the container size — the overlap
          // bug on resize. Plain flow + flex centering reflows at any size.
          transform: 'none',
        }}
      >
      <ComposerArea
        ref={inputRef} activeComposer={open}
        input={input}
        onInputChange={setInput}
        isOrchestratorMode={isOrchestratorMode}
        isChatMode={isChatMode}
        isSingleMode={isSingleMode}
        displayWaiting={displayWaiting}
        chatMessages={displayMessages}
        activeTargetLabel={activeTargetLabel}
        targetAgentExists={Boolean(targetAgent)}
        // Feed the EFFECTIVE transcript (orchestrator streams live into
        // orchStream.messages, not the raw chatMessages state). The status bar's
        // awaitingReply / runningTools / latestUserMessageId derive from this —
        // with raw chatMessages the streamed reply never lands here, so
        // awaitingReply stays true forever and the Working latch never releases
        // (#stuck-working-indicator, 2026-06-19). displayMessagesCount below
        // already used displayMessages; this aligns the list with it.
        thoughtsBodyBackground={thoughtsBodyBackground}
        enhancing={enhancing}
        preEnhanceInput={preEnhanceInput}
        onEnhance={handleEnhance}
        onUndoEnhance={handleUndoEnhance}
        onSubmit={handleComposerSend}
        onStop={sendBuffer.stopOrUndo}
        onSteer={handleComposerSend}
        sendBufferStatus={isOrchestratorMode ? (
          <ComposerSendBufferStatus
            undoArmed={sendBuffer.undoArmed}
            undoSequence={sendBuffer.undoSequence}
            queued={sendBuffer.queued}
            onUndo={sendBuffer.stopOrUndo}
            onCancelQueued={sendBuffer.cancelQueued}
          />
        ) : null}
        onSlashCommand={handleSlashCommand}
        modelLabel={isChatMode ? selectedChatModel.label : isSingleMode ? activeTargetLabel : isOrchestratorMode ? activeBackendLabel ?? formatComposerBackendLabel(orchestratorBackend, orchestratorModel) : activeTargetLabel}
        modelId={isOrchestratorMode ? orchestratorModel : undefined}
        onModelChange={isOrchestratorMode ? (model) => {
          setOrchestratorModel(model);
          writeStoredOrchestratorModel(resolvedRepoPath, model);
        } : undefined}
        activeBackend={isOrchestratorMode ? orchestratorBackend : undefined}
        onBackendChange={isOrchestratorMode ? handleBackendChange : undefined}
        effort={thinkingEffort}
        onEffortChange={handleEffortChange}
        adaptiveEnabled={adaptiveThinkingEnabled}
        swarmEnabled={swarmEnabled}
        onSetSwarm={onSetSwarm}
        collideEnabled={collideEnabled}
        onSetCollide={onSetCollide}
        // Session rules (#1329) — orchestrator threads only. null (not yet
        // minted) still shows the read-only Repo/Global tiers in the chip.
        sessionRulesThreadId={isOrchestratorMode && !isChatMode ? threadId : undefined}
        repoLabel={composerRepoLabel}
        displayMessagesCount={displayMessages.length}
        hasAssistantActivity={hasAssistantActivity}
        footerMeterSlot={footerMeterSlot}
        composerLeadingExtras={composerLeadingExtras}
        attachedImages={attachedImages}
        attachedFiles={attachedFiles}
        dragOver={attachmentDragOver}
        dragHandlers={attachmentDragHandlers}
        onAttachedImageRemove={removeAttachedImage}
        onAttachedImageAnnotate={setAnnotatingIndex}
        onAttachedFileRemove={removeAttachedFile}
        onUploadDiskFiles={processAttachmentFiles}
        composerMode={isOrchestratorMode && !isChatMode ? composerMode : undefined}
        onComposerModeChange={isOrchestratorMode && !isChatMode ? handleComposerModeChange : undefined}
        repoPath={resolvedRepoPath}
        workspaceTargets={workspaceTargets}
        selectedRepoPath={resolvedRepoPath}
        onSelectRepoPath={handleSelectComposerRepoPath}
      />
      {displayMessages.length === 0 && composerBelowSlot ? composerBelowSlot : null}
      {annotatingIndex !== null && attachedImages[annotatingIndex] ? (() => {
        const idx = annotatingIndex;
        const target = attachedImages[idx];
        if (!target) return null;
        return (
          <ScreenshotAnnotator
            image={target}
            onCancel={() => setAnnotatingIndex(null)}
            onDone={(dataUri) => {
              const mime = dataUri.slice(5, dataUri.indexOf(';')) || 'image/png';
              replaceAttachedImage(idx, { ...target, dataUri, mimeType: mime });
              setAnnotatingIndex(null);
            }}
          />
        );
      })() : null}
      </div>
    </div>
  );
});
