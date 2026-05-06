'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { CollapsiblePlanCard } from '@/components/desktop/CollapsiblePlanCard';
import { formatModelLabel } from '@/lib/format';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
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
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { serializeThreadToMarkdown, type ExportThreadMessage } from '@/lib/llm/export-thread';
import { executeOrchestratorSlashCommand, parseOrchestratorSlashCommand } from '@/lib/slash-commands';
import type { AgentTarget, FleetAgent } from './types';
import {
  entrySignature,
  generateSuggestions,
  isRenderableThoughtEntry,
  isRunnableCliSession,
  mergeTranscriptEntries,
} from './utils';
import { useOrchestratorStream } from './useOrchestratorStream';
import { useOrchestratorContextResidency } from '@/components/desktop/orchestrator/context-residency';
import { ChatMessageList } from './chat-panel/ChatMessageList';
import { ChatToastStack } from './chat-panel/ChatToastStack';
import { ComposerArea } from './chat-panel/ComposerArea';
import { IntentChips } from '@/components/desktop/orchestrator/IntentChips';
import { ModePicker, loadOrchestrationMode, persistOrchestrationMode, type ChatModelId, type OrchestrationMode } from '@/components/desktop/orchestrator/ModePicker';
import { WaitingFooter } from '@/components/desktop/orchestrator/WaitingFooter';
import { getChatModelOption, loadChatModelChoice } from '@/components/desktop/orchestrator/chat-models';
import {
  createChatAssistantEntry,
  createChatUserEntry,
  mergeToolCallIntoEntry,
  mergeToolResultIntoEntry,
  sendScratchChatMessage,
} from '@/components/desktop/orchestrator/send-chat-message';
import { EmptyStateCard } from './chat-panel/EmptyStateCard';
import { ThreadExportButton } from './chat-panel/ThreadExportButton';
import { useClearCommand } from './chat-panel/useClearCommand';
import { useOrchestratorReloadNotice } from './chat-panel/useOrchestratorReloadNotice';
import { usePersistChatThread } from './chat-panel/usePersistChatThread';
import { useSuggestedReplies } from './chat-panel/useSuggestedReplies';
import { useThoughtsComposerAttachments } from './chat-panel/useThoughtsComposerAttachments';
import type {
  ThoughtsChatPanelChromeState,
  ThoughtsChatPanelHandle,
  ThoughtsChatPermissionMode,
} from './chat-panel/types';
import {
  fetchThoughtsOperatorDefaults,
  THOUGHTS_OPERATOR_DEFAULTS_FALLBACK,
} from './operator-defaults';

export type { ThoughtsChatPanelHandle, ThoughtsChatPanelChromeState, ThoughtsChatPermissionMode };

type ThoughtsHistoryMessage = ExportThreadMessage & {
  id: string;
  role: MobileTranscriptEntry['role'];
  media?: MobileTranscriptEntry['media'];
  thinkingSteps?: MobileTranscriptEntry['thinkingSteps'];
  thinkingDurationMs?: MobileTranscriptEntry['thinkingDurationMs'];
  recalledFacts?: MobileTranscriptEntry['recalledFacts'];
  command?: MobileTranscriptEntry['command'];
  isPartial?: boolean;
  isCompaction?: boolean;
};

function mapHistoryMessagesToTranscript(messages: ThoughtsHistoryMessage[]): MobileTranscriptEntry[] {
  return messages
    .filter((message) => !message.isPartial)
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text ?? message.content ?? '',
      type: message.type ?? (message.compaction || message.isCompaction ? 'compaction' : 'message'),
      media: message.media,
      toolCalls: message.toolCalls,
      timestamp: message.timestamp ?? Date.now(),
      timestampLabel: message.timestampLabel ?? (message.timestamp
        ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : ''),
      model: message.model,
      tokens: message.tokens,
      costUsd: message.costUsd,
      sources: message.sources,
      thinking: message.thinking,
      thinkingSteps: message.thinkingSteps,
      thinkingDurationMs: message.thinkingDurationMs,
      recalledFacts: message.recalledFacts,
      command: message.command,
      compaction: message.compaction,
    }));
}

function isRuntimeSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith('claude-code:')
    || sessionKey.startsWith('codex:')
    || sessionKey.startsWith('codex-owned:')
    || sessionKey.startsWith('codex-discovered:')
    || sessionKey.startsWith('codex-live:')
    || sessionKey.startsWith('gemini-owned:')
    || sessionKey.startsWith('opencode-owned:');
}

export const ThoughtsChatPanel = forwardRef<ThoughtsChatPanelHandle, {
  open: boolean;
  draftInjection?: { id: string; text: string } | null;
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
  onTogglePermission?: () => void;
  repoLabel?: string | null;
  emptyStateOverride?: React.ReactNode;
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
}>(function ThoughtsChatPanel({
  open,
  draftInjection,
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
  onTogglePermission,
  repoLabel,
  emptyStateOverride,
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
  onChromeChange,
  onChatSummary,
}, ref) {
  const [input, setInput] = useState('');
  const [preEnhanceInput, setPreEnhanceInput] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  // #888/#891 — repo + branch chips below the composer once intent has
  // text. The chips advise scope; the orchestrator still reads its own
  // truth at dispatch time. Default repo = parent-provided repoPathProp.
  const [intentRepoPath, setIntentRepoPath] = useState<string | null>(repoPathProp ?? null);
  const [intentBranch, setIntentBranch] = useState<string>('main');
  // Orchestration mode + runtime + chat-model selection. Per-tab when
  // the parent provides initial values + onModePersist (the orchestrator
  // tab path); otherwise falls back to the legacy per-workspace
  // localStorage store keyed off repoPath.
  const workspaceModeKey = repoPathProp ?? '__global__';
  const usesPerTabPersistence = Boolean(onModePersist) || lockedMode !== undefined || initialMode !== undefined;
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationMode>(
    () => lockedMode ?? initialMode ?? 'fleet',
  );
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
  const handleSelectSingleRuntime = useCallback((next: OrchestratorRuntime) => {
    setSingleRuntime(next);
    if (onModePersist) {
      onModePersist({ singleRuntime: next });
    } else {
      persistOrchestrationMode(workspaceModeKey, orchestrationMode, next);
    }
  }, [onModePersist, orchestrationMode, workspaceModeKey]);
  const handleSelectChatModel = useCallback((next: ChatModelId) => {
    setChatModelId(next);
    onModePersist?.({ chatModelId: next });
  }, [onModePersist]);
  const [operatorDefaults, setOperatorDefaults] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK);
  const [adaptiveThinkingEnabled, setAdaptiveThinkingEnabled] = useState(
    () => resolveInitialOrchestratorThinkingPreferences(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.thinkingEffort).adaptiveThinkingEnabled,
  );
  const [thinkingOverride, setThinkingOverride] = useState<ManualThinkingEffort | null>(
    () => resolveInitialOrchestratorThinkingPreferences(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.thinkingEffort).thinkingOverride,
  );
  const [orchestratorModel, setOrchestratorModel] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.orchestratorModel);
  const [chatMessages, setChatMessages] = useState<MobileTranscriptEntry[]>([]);
  const [planText, setPlanText] = useState<string | null>(null);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [targetAgentKey, setTargetAgentKey] = useState<string>('__claude__');
  const thinkingPreferenceTouchedRef = useRef(false);
  const pollRef = useRef<number | null>(null);
  const pollDelayRef = useRef<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const seenServerEntriesRef = useRef<Map<string, string>>(new Map());
  const responseSeenRef = useRef(false);
  const idlePollsRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const orchestratorSessionRef = useRef<string | null>(null);
  const singleRuntimeSessionRef = useRef<string | null>(null);
  const singleRuntimeLaunchPromiseRef = useRef<Promise<string | null> | null>(null);
  const [orchestratorSpawning, setOrchestratorSpawning] = useState(false);
  const [singleRuntimeSpawning, setSingleRuntimeSpawning] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const exportFeedbackTimerRef = useRef<number | null>(null);
  const [resolvedRepoPath, setResolvedRepoPath] = useState<string | null>(repoPathProp ?? null);
  const [exportState, setExportState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const { persistThread, persistThreadNow, cancelPendingPersist } = usePersistChatThread(resolvedRepoPath);
  const thinkingEffort: ThinkingEffort = thinkingOverride ?? (adaptiveThinkingEnabled ? 'adaptive' : 'max');
  const {
    attachedImages,
    attachedFiles,
    dragOver: attachmentDragOver,
    dragHandlers: attachmentDragHandlers,
    processFiles: processAttachmentFiles,
    removeAttachedImage,
    removeAttachedFile,
    clearAttachments,
  } = useThoughtsComposerAttachments();

  const isSingleMode = orchestrationMode === 'single';
  const isChatMode = orchestrationMode === 'chat';
  const isOrchestratorMode = !isSingleMode && !isChatMode && (targetAgentKey === '__claude__' || !sessionTargets.some((s) => s.key === targetAgentKey));

  const orchStream = useOrchestratorStream(isOrchestratorMode && orchestrationSettingsLoaded && !isChatMode ? resolvedRepoPath : null, {
    seededPlanText: planText,
    hasHistory: chatMessages.length > 0,
  });

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const defaults = await fetchThoughtsOperatorDefaults(controller.signal);
      if (controller.signal.aborted) return;
      setOperatorDefaults(defaults);
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

  // ── Resolve repo path for orchestrator stream ──
  useEffect(() => {
    if (repoPathProp) {
      setResolvedRepoPath(repoPathProp);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/panel/repos');
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
        const data = await launchRes.json() as { ok?: boolean; surfaceId?: string };
        if (!data.ok || !data.surfaceId) return null;
        singleRuntimeSessionRef.current = data.surfaceId;
        return data.surfaceId;
      } catch {
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
      let repoPath = repoPathProp;
      if (!repoPath) {
        try {
          const res = await fetch('/api/panel/repos');
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
            prompt: 'You are the orchestrator for Cortex IDE. Acknowledge ready.',
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
  }, [isChatMode, isOrchestratorMode, orchestrationSettingsLoaded, orchestratorSpawning, repoPathProp]);

  useEffect(() => {
    if (!open || !draftInjection?.id) return;
    setInput((prev) => prev.trim()
      ? `${prev.trimEnd()}\n\n${draftInjection.text}\n\n`
      : `${draftInjection.text}\n\n`);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [draftInjection?.id, draftInjection?.text, open]);

  // Phase 4 friction fix #1: clear stale composer drafts on tab refocus.
  // The composer state is preserved across tab switches (the parent uses
  // display:none, not unmount), so a directive review draft sitting in
  // the textarea before the user navigated away ends up appended to
  // whatever they type next time they return. Snapshot the input on
  // tab-blur (open: true→false) and clear + toast on next refocus
  // (open: false→true) IF that snapshot was non-empty AND no fresh
  // draft injection arrived in the interim. The newDraftArrived check
  // prevents the clear from wiping a legitimate inject; the
  // inject effect declared above runs first in declaration order, so
  // we observe the post-inject input here.
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
    requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, [chatMessages, orchStream.messages]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      if (pollDelayRef.current !== null) window.clearTimeout(pollDelayRef.current);
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
      const res = await fetch(transcriptUrl(sessionKey));
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

  // Owned codex/gemini/opencode sessions can't accept the next turn until
  // their CLI emits a thread id and the lifecycle flips to ready-for-resume.
  // The transcript poller can declare "response done" before that happens
  // (the launch banner counts as a non-user entry), so the composer would
  // unlock and the next steer call would 501 with "cannot accept the next
  // input yet". Gate the composer on the inventory snapshot for these
  // sessions to keep the user from sending into a not-yet-resumable lane.
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
      attempts++;
      if (attempts > maxAttempts) {
        finishPolling();
        return;
      }

      try {
        const res = await fetch(transcriptUrl(sessionKey));
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
    // #597 — immediately mint a fresh threadId and persist an empty
    // placeholder row so History shows the slot even before the first
    // message. The title becomes `New thread · HH:MM` server-side until
    // the first user message replaces it.
    const placeholderId = isOrchestratorMode ? `thoughts-${Date.now()}` : `chat-${Date.now()}`;
    threadIdRef.current = placeholderId;
    setThreadId(placeholderId);
    autoRestoreAttemptedRef.current = true;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('o8:orchestrator:auto-restore-suppressed', '1');
    }
    cancelPendingPersist();
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    singleRuntimeSessionRef.current = null;
    singleRuntimeLaunchPromiseRef.current = null;
    if (isOrchestratorMode) {
      void persistThreadNow([], placeholderId, null);
    }
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [cancelPendingPersist, clearPolling, orchStream, isOrchestratorMode, persistThreadNow]);

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
  useEffect(() => {
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
        const data = await res.json() as { conversations?: Array<{ tabId: string; modifiedAt?: string }> };
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
        };
        const msgs = mapHistoryMessagesToTranscript(histData.messages ?? []);
        // Hard cap: never auto-restore a thread above 100 messages — the user
        // almost certainly didn't want yesterday's giant thread paged back in
        // every reload. They can still pick it up explicitly from History.
        if (msgs.length > 100) {
          console.log(`[orchestrator] Skipping auto-restore — latest thread has ${msgs.length} messages (>100 cap)`);
          return;
        }
        setPlanText(histData.planText ?? null);
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
  }, [chatMessages.length, isChatMode, isOrchestratorMode, orchStream]);

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

  const handleLoadThread = useCallback(async (tabId: string) => {
    try {
      const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`);
      if (!res.ok) return;
      const data = await res.json() as {
        messages?: ThoughtsHistoryMessage[];
        planText?: string | null;
      };
      const msgs = mapHistoryMessagesToTranscript(data.messages ?? []);
      setChatMessages(msgs);
      setPlanText(data.planText ?? null);
      threadIdRef.current = tabId;
      setThreadId(tabId);
      setWaitingForReply(false);
      clearPolling();
      orchStream.reset();
      orchStream.replaceTranscript(msgs);
      seenServerEntriesRef.current.clear();
      orchestratorSessionRef.current = null;
      singleRuntimeSessionRef.current = null;
      singleRuntimeLaunchPromiseRef.current = null;
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      // silent
    }
  }, [clearPolling, orchStream]);

  const suggestions = useMemo(
    () => generateSuggestions(agents.filter(isRunnableCliSession), sessionTargets),
    [agents, sessionTargets],
  );
  const displayMessages = useMemo(() => {
    if (!isOrchestratorMode || isChatMode) return chatMessages;
    return orchStream.messages.length > 0 ? orchStream.messages : chatMessages;
  }, [chatMessages, isChatMode, isOrchestratorMode, orchStream.messages]);
  const displayWaiting = isChatMode ? false : isOrchestratorMode ? orchStream.status === 'busy' : (waitingForReply || (isSingleMode && singleRuntimeSpawning));
  const displayPlanText = isOrchestratorMode && !isChatMode && planText?.trim() ? planText.trim() : null;
  const hasAssistantActivity = displayMessages.some((message) => message.role !== 'user');
  const activeTargetLabel = isChatMode
    ? selectedChatModel.label
    : isSingleMode
      ? orchestratorRuntimeTone(singleRuntime).label
      : isOrchestratorMode
        ? 'Claude Code'
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
    isPlaceholderVisibleForLastAssistant: suggestedRepliesPending,
    dismissChips: dismissSuggestedReplies,
  } = useSuggestedReplies({
    enabled: isOrchestratorMode && !isChatMode,
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
      queuePrelude: (prelude, mode) => queueOrchestratorSessionPrelude(resolvedRepoPath, prelude, mode),
      searchArchive: (query, limit) => searchOrchestratorArchive(resolvedRepoPath, query, limit),
      fetchTelemetry: async () => {
        const snapshot = await orchStream.fetchTelemetrySnapshot();
        return {
          totalTokens: snapshot.totalTokens,
          estimatedCostUsd: snapshot.estimatedCostUsd,
          model: snapshot.model,
        };
      },
      appendEntries: suppressCommandEntries ? () => {} : orchStream.appendLocalEntries,
      clearThread: handleClearCommand,
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
  ]);

  const handleTaskSend = useCallback(async (explicitText?: string) => {
    const msg = (explicitText ?? input).trim();
    if (!msg) return;

    const effectiveWaiting = isChatMode ? waitingForReply : isOrchestratorMode ? orchStream.status === 'busy' : waitingForReply;
    if (effectiveWaiting) return;

    if (isChatMode) {
      setInput('');
      latestInputRef.current = '';
      const userEntry = createChatUserEntry(msg);
      const assistantEntry = createChatAssistantEntry(selectedChatModel, (userEntry.timestamp ?? Date.now()) + 1);
      let assistantText = '';
      setChatMessages((prev) => [...prev, userEntry, assistantEntry]);
      clearAttachments();
      setWaitingForReply(true);
      try {
        // Chat-mode always routes through the OpenRouter scratch-chat
        // path with tools wired. The model is picked per-tab via the
        // ChatOpenRouterPicker chip; modelOverride pins it server-side.
        // BYOK is no longer a separate UI tier — operators with their
        // own OpenRouter key supply it through env / Settings and the
        // server-side resolver picks it automatically.
        await sendScratchChatMessage({
          history: chatMessages,
          message: msg,
          context: resolvedRepoPath ? { repoPath: resolvedRepoPath } : undefined,
          enableTools: true,
          modelOverride: chatOpenrouterModel ?? null,
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
        const message = error instanceof Error ? error.message : 'Chat request failed.';
        setChatMessages((prev) => prev.map((entry) => (
          entry.id === assistantEntry.id
            ? { ...entry, text: assistantText ? `${assistantText}\n\n${message}` : message }
            : entry
        )));
      } finally {
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
        text: msg,
        timestamp: Date.now(),
        timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setChatMessages((prev) => [...prev, userMsg]);
      clearAttachments();
      setWaitingForReply(true);

      try {
        const launch = await ensureSingleRuntimeSession(msg);
        if (!launch?.sessionKey) {
          throw new Error('Unable to launch selected runtime');
        }
        const { sessionKey } = launch;
        await captureServerSnapshot(sessionKey);
        if (!launch.launched) {
          const response = await fetch('/api/runtime/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'steer', surfaceId: sessionKey, message: msg }),
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

    if (isOrchestratorMode && await runLocalOrchestratorSlash(msg)) {
      setInput('');
      return;
    }

    setInput('');

    if (isOrchestratorMode) {
      const attachments = attachedImages.length > 0
        ? attachedImages.map((img) => ({ dataUri: img.dataUri, name: img.name }))
        : undefined;
      orchStream.send(msg, {
        permissionMode,
        thinkingEffort,
        model: orchestratorModel,
        ...(attachments ? { attachments } : {}),
      });
      clearAttachments();
      return;
    }

    const userMsg: MobileTranscriptEntry = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      text: msg,
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
          ? JSON.stringify({ action: 'steer', surfaceId: sessionKey, message: msg })
          : JSON.stringify({ action: 'resume', sessionKey, message: msg }),
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
  }, [captureServerSnapshot, chatMessages, clearAttachments, ensureSingleRuntimeSession, input, isChatMode, isOrchestratorMode, isSingleMode, orchStream, orchestratorModel, permissionMode, runLocalOrchestratorSlash, selectedChatModel, singleRuntime, startPolling, startPollingForSession, targetAgent, targetSessionKey, thinkingEffort, waitingForReply]);

  const sendNow = useCallback((text?: string) => {
    const msg = (typeof text === 'string' ? text : latestInputRef.current).trim();
    if (!msg) return;

    if (isChatMode) {
      if (waitingForReply) return;
      setInput(msg);
      latestInputRef.current = msg;
      setTimeout(() => { void handleTaskSend(msg); }, 0);
      return;
    }

    if (isOrchestratorMode) {
      if (orchStream.status === 'busy') return;
      void (async () => {
        if (await runLocalOrchestratorSlash(msg)) {
          setInput('');
          latestInputRef.current = '';
          return;
        }
        setInput('');
        latestInputRef.current = '';
        const attachments = attachedImages.length > 0
          ? attachedImages.map((img) => ({ dataUri: img.dataUri, name: img.name }))
          : undefined;
        orchStream.send(msg, {
          permissionMode,
          thinkingEffort,
          model: orchestratorModel,
          ...(attachments ? { attachments } : {}),
        });
        clearAttachments();
      })();
      return;
    }

    setInput(msg);
    latestInputRef.current = msg;
    setTimeout(() => { void handleTaskSend(msg); }, 0);
  }, [clearAttachments, handleTaskSend, isChatMode, isOrchestratorMode, orchStream, orchestratorModel, permissionMode, runLocalOrchestratorSlash, thinkingEffort, waitingForReply]);

  const handleCopyMarkdownRef = useRef<() => Promise<boolean>>(async () => false);

  useImperativeHandle(ref, () => ({
    focusInput() {
      inputRef.current?.focus();
    },
    reset: handleReset,
    loadThread: handleLoadThread,
    sendNow,
    copyAsMarkdown: () => handleCopyMarkdownRef.current(),
  }), [handleReset, handleLoadThread, sendNow]);

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

  return (
    <>
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
        onDragOver={attachmentDragHandlers.onDragOver}
        onDragLeave={attachmentDragHandlers.onDragLeave}
        onDrop={attachmentDragHandlers.onDrop}
        style={{
          position: 'relative',
          display: 'flex',
          flex: 1,
          minHeight: 0,
          outline: attachmentDragOver ? '2px solid var(--t-accent)' : 'none',
          outlineOffset: -2,
        }}
      >
        <ChatMessageList
          ref={chatEndRef}
          displayMessages={displayMessages}
          displayWaiting={displayWaiting}
          repoPath={resolvedRepoPath}
          activeTargetLabel={activeTargetLabel}
          activeTargetColor={activeTargetColor}
          thoughtsBodyBackground={thoughtsBodyBackground}
          thoughtsMutedGlass={thoughtsMutedGlass}
          thoughtsElevatedBorder={thoughtsElevatedBorder}
          thoughtsElevatedShadow={thoughtsElevatedShadow}
          emptyStateOverride={emptyStateOverride}
          emptyStateFallback={fallbackEmptyState}
          topContent={transcriptTopContent}
          isOrchestratorMode={isOrchestratorMode}
          suggestedReplyMessageId={suggestedReplyMessageId}
          suggestedReplies={chipsForLastAssistant}
          suggestedRepliesPending={suggestedRepliesPending}
          onSelectSuggestion={(chip) => { sendNow(chip); }}
          onDismissSuggestions={dismissSuggestedReplies}
        />
      </div>

      <ChatToastStack
        reloadNotice={reloadNotice}
        onDismissReloadNotice={dismissReloadNotice}
        showClearToast={showClearToast}
        showDraftClearedToast={showDraftClearedToast}
        thoughtsBodyBackground={thoughtsBodyBackground}
      />

      <WaitingFooter
        count={isOrchestratorMode && displayWaiting ? Math.max(1, agents.filter((a) => a.status === 'running').length) : 0}
        onStop={orchStream.interrupt}
      />

      <IntentChips
        visible={input.trim().length > 0}
        workspaceTargets={workspaceTargets ?? []}
        selectedRepoPath={intentRepoPath}
        onSelectRepoPath={setIntentRepoPath}
        selectedBranch={intentBranch}
        onSelectBranch={setIntentBranch}
      />

      <ModePicker
        visible={!lockedMode && input.trim().length > 0}
        workspaceKey={workspaceModeKey}
        selectedMode={orchestrationMode}
        onSelectMode={handleSelectOrchestrationMode}
        selectedSingleRuntime={singleRuntime}
        onSelectSingleRuntime={handleSelectSingleRuntime}
        onSpawnSingleTab={onSpawnSingleTab}
        onSpawnChatTab={onSpawnChatTab}
      />

      <ComposerArea
        ref={inputRef}
        input={input}
        onInputChange={setInput}
        isOrchestratorMode={isOrchestratorMode}
        isChatMode={isChatMode}
        isSingleMode={isSingleMode}
        displayWaiting={displayWaiting}
        chatMessages={chatMessages}
        activeTargetLabel={activeTargetLabel}
        targetAgentExists={Boolean(targetAgent)}
        thoughtsBodyBackground={thoughtsBodyBackground}
        enhancing={enhancing}
        preEnhanceInput={preEnhanceInput}
        onEnhance={handleEnhance}
        onUndoEnhance={handleUndoEnhance}
        onSubmit={() => { void handleTaskSend(); }}
        onStop={orchStream.interrupt}
        onSlashCommand={handleSlashCommand}
        modelLabel={isChatMode ? selectedChatModel.label : isSingleMode ? activeTargetLabel : isOrchestratorMode ? formatModelLabel(orchestratorModel) : activeTargetLabel}
        effort={thinkingEffort}
        onEffortChange={handleEffortChange}
        adaptiveEnabled={adaptiveThinkingEnabled}
        permissionMode={permissionMode}
        onTogglePermission={onTogglePermission}
        repoLabel={repoLabel}
        displayMessagesCount={displayMessages.length}
        hasAssistantActivity={hasAssistantActivity}
        footerMeterSlot={footerMeterSlot}
        composerLeadingExtras={composerLeadingExtras}
        attachedImages={attachedImages}
        attachedFiles={attachedFiles}
        dragOver={attachmentDragOver}
        dragHandlers={attachmentDragHandlers}
        onAttachedImageRemove={removeAttachedImage}
        onAttachedFileRemove={removeAttachedFile}
        onUploadDiskFiles={processAttachmentFiles}
        repoPath={resolvedRepoPath}
      />
    </>
  );
});
