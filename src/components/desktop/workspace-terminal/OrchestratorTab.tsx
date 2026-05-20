'use client';

/**
 * OrchestratorTab — full-workspace O8 operator chat surface inside a
 * WorkspaceTerminal tab.
 *
 * The tab centers ThoughtsChatPanel as the primary surface and layers in
 * optional chrome around it: history drawer, tiled live sessions, comparison
 * picker, context meter/inspector, and the Cmd+K quick-action palette.
 *
 * Data comes from OrchestratorDataContext at the dashboard level so the
 * workspace shell does not prop-drill mission, agent, or packet state.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ComparisonPicker } from '@/components/desktop/ComparisonPicker';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import { loadOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestrationMode, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { ChatModelId } from '@/components/desktop/orchestrator/chat-models';
import { ChatOpenRouterPicker } from '@/components/desktop/orchestrator/ChatOpenRouterPicker';
import { useWorkspaceSpawn } from '@/components/desktop/workspace-terminal/spawn-context';
import {
  readLastOrchestratorThreadId,
  writeLastOrchestratorThread,
} from '@/components/desktop/workspace-terminal/orchestrator-thread-restore';
import {
  OrchestratorEmptyState,
  timeOfDayGreeting,
} from '@/components/desktop/OrchestratorEmptyState';
import { ContextMeter } from '@/components/desktop/orchestrator/ContextMeter';
import { QuickActionPalette } from '@/components/desktop/orchestrator/QuickActionPalette';
import type { QuickAction } from '@/lib/orchestrator/quick-actions';
import { OrchestratorContextResidencyProvider } from '@/components/desktop/orchestrator/context-residency';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { BranchDetailsLauncher } from '@/components/desktop/BranchDetailsLauncher';
import {
  ThoughtsChatPanel,
  type ThoughtsChatPanelChromeState,
  type ThoughtsChatPanelHandle,
  type ThoughtsChatPermissionMode,
} from '@/components/desktop/thoughts/ThoughtsChatPanel';
import { ORCHESTRATOR_TOKEN_EVENT, type OrchestratorTokenUsageDetail } from '@/components/desktop/thoughts/useOrchestratorStream';
import { buildAgentTargets } from '@/components/desktop/thoughts/utils';
import { SessionPillContextMenu } from '@/components/desktop/SessionPillContextMenu';
import { SessionTileSurface } from './SessionTileSurface';
import { useSessionTiles, buildPillContextMenuItems } from './use-session-tiles';
// Issue #663: SessionTileSurface replaces the legacy flat AgentTileLayout
// row. The old layout component is no longer imported here.

interface OrchestratorTabProps {
  tabId: string;
  active: boolean;
  repoPath?: string | null;
  repoLabel?: string | null;
  // When set, ThoughtsChatPanel's mode chooser is hidden and the mode is
  // forced. Single-runtime tabs pass 'single', Chat tabs pass 'chat'.
  lockedMode?: OrchestrationMode;
  // Per-tab initial state sourced from the TerminalTab record. Replaces
  // the legacy per-workspace localStorage load when provided.
  initialMode?: OrchestrationMode;
  initialSingleRuntime?: OrchestratorRuntime;
  initialChatModelId?: ChatModelId;
  // Pinned OpenRouter model slug for chat-mode requests on this tab.
  // Empty/undefined = use server's env-configured fallback chain.
  initialChatOpenrouterModel?: string;
  initialThreadId?: string | null;
  // Forwarded to ThoughtsChatPanel — fires with the latest user message
  // text in chat mode so the tab strip can show a 3-word summary instead
  // of the generic "Chat" label.
  onChatSummary?: (text: string) => void;
}

function permissionStorageKey(tabId: string): string {
  return `cortex-ide:orchestrator-permission:tab:${tabId}`;
}

// Persistence helpers for the cross-reload thread restore live in a
// shared module so the workspace controller can read the same values
// at tab-creation time (pre-set tab.label) without re-implementing.

function readStoredPermissionMode(tabId: string): ThoughtsChatPermissionMode {
  if (typeof window === 'undefined') return 'full';
  try {
    const raw = window.localStorage.getItem(permissionStorageKey(tabId));
    return raw === 'plan' ? 'plan' : 'full';
  } catch {
    return 'full';
  }
}

function persistPermissionMode(tabId: string, mode: ThoughtsChatPermissionMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(permissionStorageKey(tabId), mode);
  } catch {
    // ignore
  }
}

const USERS_THREE_ICON_PATH = 'M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1-7.37-4.89,8,8,0,0,1,0-6.22A8,8,0,0,1,192,112a24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.84,8,57,57,0,0,0-98.16,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z';

function isComparisonPacketComplete(packet: OrchestratorPacket): boolean {
  return packet.status === 'awaiting_review'
    || packet.status === 'released'
    || packet.status === 'archived'
    || packet.status === 'failed'
    || Boolean(packet.review);
}

function HeaderToggleButton({
  active,
  label,
  title,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        height: 28,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        flexShrink: 0,
        fontSize: 11.5,
        fontWeight: 500,
        letterSpacing: '-0.005em',
        transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms cubic-bezier(0.22, 1, 0.36, 1), color 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        fontFamily: 'var(--font-sans-system)',
      }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.background = 'var(--t-bg-card)';
        event.currentTarget.style.borderColor = 'var(--t-border)';
        event.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.borderColor = 'var(--t-border)';
        event.currentTarget.style.color = 'var(--t-text-secondary)';
      }}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function ClockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function RocketIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function UsersThreeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d={USERS_THREE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

export function OrchestratorTab(props: OrchestratorTabProps) {
  return (
    <OrchestratorContextResidencyProvider>
      <OrchestratorTabInner {...props} />
    </OrchestratorContextResidencyProvider>
  );
}

function OrchestratorTabInner({
  tabId,
  active,
  repoPath,
  repoLabel,
  lockedMode,
  initialMode,
  initialSingleRuntime,
  initialChatModelId,
  initialChatOpenrouterModel,
  initialThreadId,
  onChatSummary,
}: OrchestratorTabProps) {
  const data = useOrchestratorData();
  const spawnHandlers = useWorkspaceSpawn();
  const handleModePersist = useCallback((patch: {
    mode?: OrchestrationMode;
    singleRuntime?: OrchestratorRuntime;
    chatModelId?: ChatModelId;
    chatOpenrouterModel?: string | null;
  }) => {
    spawnHandlers?.updateTabMode(tabId, patch);
  }, [spawnHandlers, tabId]);
  const handlePickChatOpenRouterModel = useCallback((slug: string | null) => {
    spawnHandlers?.updateTabMode(tabId, { chatOpenrouterModel: slug });
  }, [spawnHandlers, tabId]);

  const [permissionMode, setPermissionMode] = useState<ThoughtsChatPermissionMode>(
    () => readStoredPermissionMode(tabId),
  );
  const [preferredRuntime, setPreferredRuntime] = useState<OrchestratorRuntime>(
    () => readOrchestratorRuntimePreference(),
  );
  const [chatChromeState, setChatChromeState] = useState<ThoughtsChatPanelChromeState>({
    activeTargetLabel: orchestratorRuntimeTone(readOrchestratorRuntimePreference()).label,
    waitingForReply: false,
    hasMessages: false,
    threadId: null,
    messageCount: 0,
    orchestratorBusyState: null,
  });
  const [contextUsage, setContextUsage] = useState({ tokenCount: 0, runningTotal: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteDraft, setPaletteDraft] = useState<{ id: string; text: string } | null>(null);
  const chatPanelRef = useRef<ThoughtsChatPanelHandle>(null);
  const loadedInitialThreadRef = useRef<string | null>(null);
  const autoTiledComparisonGroupIdRef = useRef<string | null>(null);

  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);

  // Broadcast the chat-history thread id whenever it changes so the
  // dashboard's rename / archive / share menu can target the correct
  // file in ~/.o8/chat-history/. The workspace tab id (e.g.
  // `orchestrator-f5d7d5c7-…`) is NOT the same as the chat-history
  // thread id (e.g. `thoughts-1779296462456`). Without this bridge the
  // PATCH writes to the wrong file (issue #1100).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!active) return;
    window.dispatchEvent(new CustomEvent('o8:workspace-thread-id', {
      detail: { tabId, threadId: chatChromeState.threadId },
    }));
  }, [active, tabId, chatChromeState.threadId]);

  // When the loaded thread changes, fetch the chat-history record and
  // sync its title into the workspace tab's label so the header strip
  // reads the operator's chosen name (e.g. "o8.v1") instead of the
  // default "Orchestrator". Mirrors what handleTitleRenameSubmit does
  // after a rename, but reactive to thread switches + reload restores.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const threadId = chatChromeState.threadId;
    if (!threadId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : null;
        if (cancelled || !title) return;
        // Persist the title alongside the threadId so the next reload
        // can pre-set tab.label at tab-creation time (no "Orchestrator"
        // flash before the chat-history fetch completes).
        if (active) writeLastOrchestratorThread(threadId, title);
        window.dispatchEvent(new CustomEvent('o8:chat-history-updated', {
          detail: { tabId, threadId, title },
        }));
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [active, tabId, chatChromeState.threadId]);

  // Persist the last-active orchestrator thread id globally so dev
  // reloads drop the operator back into their last conversation. Only
  // persists when the active thread HAS messages — without this guard
  // the placeholder-mint pattern (#597) would overwrite the saved id
  // with a fresh empty thread the moment a new tab mounted, defeating
  // the whole point of the restore.
  useEffect(() => {
    if (!active) return;
    if (!chatChromeState.hasMessages) return;
    if (chatChromeState.threadId) {
      // Don't clear the title here — only the threadId update fires this
      // effect. The title-sync effect above handles the (threadId, title)
      // tuple write. Pass `undefined` to leave the stored title alone.
      writeLastOrchestratorThread(chatChromeState.threadId);
    }
  }, [active, chatChromeState.threadId, chatChromeState.hasMessages]);

  // On mount, if no explicit initialThreadId was passed (which is the
  // case for default Orchestrator tabs spawned on first launch / reload),
  // restore the last-active thread from localStorage and load it once.
  // The guard ref is set ONLY AFTER loadThread runs successfully —
  // setting it pre-emptively used to break under React StrictMode's
  // double-effect (the cleanup cancelled the first timer, but the ref
  // was already flagged so the second effect bailed → no restore).
  //
  // `isRestoringThread` gates the empty-state vs shimmer swap below:
  // true from the moment we know we're going to restore until the
  // chat panel has actually loaded the messages (hasMessages flips).
  const restoredThreadRef = useRef<string | null>(null);
  const [isRestoringThread, setIsRestoringThread] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    // Only orchestrator tabs in default mode (no explicit initialThreadId)
    // participate in the restore path.
    if (initialThreadId) return false;
    return Boolean(readLastOrchestratorThreadId());
  });
  useEffect(() => {
    if (!active) return;
    if (initialThreadId) return; // explicit thread wins
    const restored = readLastOrchestratorThreadId();
    if (!restored) return;
    if (restoredThreadRef.current === restored) return; // already loaded
    let cancelled = false;
    let attempts = 0;
    const tryLoad = () => {
      if (cancelled) return;
      if (restoredThreadRef.current === restored) return;
      const handle = chatPanelRef.current;
      if (handle) {
        handle.loadThread(restored);
        restoredThreadRef.current = restored;
        return;
      }
      attempts += 1;
      if (attempts < 40) window.setTimeout(tryLoad, 50);
    };
    const timer = window.setTimeout(tryLoad, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, initialThreadId]);

  // Drop the restoring flag once messages arrive (hasMessages flips
  // true). Also bail out if the restore has been running for ~3s —
  // covers the edge case where chat-history has no messages (empty
  // restore target) so hasMessages would never flip and the shimmer
  // would sit forever.
  useEffect(() => {
    if (!isRestoringThread) return;
    if (chatChromeState.hasMessages) {
      setIsRestoringThread(false);
      return;
    }
    const fallback = window.setTimeout(() => setIsRestoringThread(false), 3000);
    return () => window.clearTimeout(fallback);
  }, [isRestoringThread, chatChromeState.hasMessages]);

  useEffect(() => {
    if (!active) return;
    const timeout = window.setTimeout(() => chatPanelRef.current?.focusInput(), 60);
    return () => window.clearTimeout(timeout);
  }, [active]);

  useEffect(() => {
    setContextUsage({ tokenCount: 0, runningTotal: 0 });
    const handleTokenUsage = (event: Event) => {
      const detail = (event as CustomEvent<OrchestratorTokenUsageDetail>).detail;
      if (!detail || detail.repoPath !== (repoPath ?? null)) return;
      setContextUsage({ tokenCount: detail.tokenCount, runningTotal: detail.runningTotal });
    };
    window.addEventListener(ORCHESTRATOR_TOKEN_EVENT, handleTokenUsage);
    return () => window.removeEventListener(ORCHESTRATOR_TOKEN_EVENT, handleTokenUsage);
  }, [repoPath]);

  const agents = useMemo(() => data?.agents ?? [], [data?.agents]);
  const comparisonGroups = useMemo(() => {
    const missionState = data?.missionState;
    if (!missionState) {
      return [] as Array<{ groupId: string; packets: OrchestratorPacket[] }>;
    }

    return (missionState.activeComparisonGroups ?? [])
      .map((groupId) => ({
        groupId,
        packets: missionState.packets.filter((packet) => packet.comparisonGroupId === groupId),
      }))
      .filter((group) => group.packets.length > 0);
  }, [data?.missionState]);
  const readyComparisonGroups = useMemo(
    () => comparisonGroups.filter((group) => group.packets.every(isComparisonPacketComplete)),
    [comparisonGroups],
  );
  const sessionTargets = useMemo(
    () => buildAgentTargets(agents, preferredRuntime),
    [agents, preferredRuntime],
  );
  const liveSessionKeys = useMemo(
    () => agents.map((agent) => agent.sessionKey).filter((key): key is string => Boolean(key)),
    [agents],
  );
  const sessionTiles = useSessionTiles({ tabId, liveSessionKeys });

  useEffect(() => {
    const activeGroupIds = comparisonGroups.map((group) => group.groupId);
    if (
      autoTiledComparisonGroupIdRef.current
      && !activeGroupIds.includes(autoTiledComparisonGroupIdRef.current)
    ) {
      autoTiledComparisonGroupIdRef.current = null;
    }

    const nextAutoTileGroup = comparisonGroups.find((group) => (
      group.groupId !== autoTiledComparisonGroupIdRef.current
      && group.packets.length > 1
      && group.packets.every((packet) => Boolean(packet.lane?.sessionKey))
    ));
    if (!nextAutoTileGroup) {
      return;
    }

    const sessionKeys = nextAutoTileGroup.packets
      .map((packet) => packet.lane?.sessionKey ?? null)
      .filter((sessionKey): sessionKey is string => Boolean(sessionKey));
    if (sessionKeys.length !== nextAutoTileGroup.packets.length) {
      return;
    }

    autoTiledComparisonGroupIdRef.current = nextAutoTileGroup.groupId;
    sessionTiles.autoTileSessions(sessionKeys);
    console.log(`[best-of-n] Auto-tiled comparison group ${nextAutoTileGroup.groupId}`);
  // Narrow to the stable callback — listing the whole `sessionTiles` object
  // would re-fire on every render because useSessionTiles returns a fresh
  // literal each time. autoTileSessions is wrapped in useCallback inside the
  // hook, so it's stable as long as its own deps don't change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparisonGroups, sessionTiles.autoTileSessions]);

  const handleTogglePermission = useCallback(() => {
    setPermissionMode((current) => {
      const next: ThoughtsChatPermissionMode = current === 'full' ? 'plan' : 'full';
      persistPermissionMode(tabId, next);
      return next;
    });
  }, [tabId]);

  useEffect(() => {
    if (!active || !initialThreadId) return;
    if (loadedInitialThreadRef.current === initialThreadId) return;
    loadedInitialThreadRef.current = initialThreadId;
    const timer = window.setTimeout(() => {
      chatPanelRef.current?.loadThread(initialThreadId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, initialThreadId]);

  useEffect(() => {
    const handleLoadHistoryThread = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; historyTabId?: string }>).detail;
      if (!detail?.historyTabId) return;
      if (detail.tabId && detail.tabId !== tabId && !active) return;
      chatPanelRef.current?.loadThread(detail.historyTabId);
      window.setTimeout(() => chatPanelRef.current?.focusInput(), 40);
    };
    window.addEventListener('o8:load-history-thread', handleLoadHistoryThread);
    return () => window.removeEventListener('o8:load-history-thread', handleLoadHistoryThread);
  }, [active, tabId]);

  const handleQuickAction = useCallback((prompt: string) => {
    chatPanelRef.current?.sendNow(prompt);
  }, []);

  // Cmd+K opens the quick-action palette — EXCEPT when focus is
  // already inside the composer textarea (the composer owns that
  // keystroke for its own shortcuts).
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const isMac = event.metaKey;
      const isCtrl = event.ctrlKey;
      if (event.key !== 'k' || !(isMac || isCtrl)) return;
      const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
      if (activeTag === 'TEXTAREA') return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  const handlePalettePick = useCallback((action: QuickAction) => {
    // Piggy-back the existing `draftInjection` pipeline: changing the
    // id triggers ThoughtsChatPanel's useEffect which appends the text
    // to the composer input. Operator can edit before sending.
    setPaletteDraft({
      id: `quick-action-${action.id}-${Date.now()}`,
      text: action.promptTemplate,
    });
    setTimeout(() => chatPanelRef.current?.focusInput(), 40);
  }, []);

  const effectiveDraftInjection = paletteDraft ?? data?.draftInjection ?? null;

  const handleDismissComparisonGroup = useCallback((groupId: string) => {
    if (!data) {
      return;
    }

    data.onMissionStateChange((current) => ({
      ...current,
      activeComparisonGroups: (current.activeComparisonGroups ?? []).filter((candidate) => candidate !== groupId),
    }));
  }, [data]);

  const handlePickComparisonWinner = useCallback(async (packetId: string) => {
    try {
      const response = await fetch('/api/orchestrator/comparison-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        result?: { merged?: boolean; note?: string };
        error?: { message?: string };
      } | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to pick the comparison winner.');
      }

      if (payload.result?.merged === false) {
        console.warn('[best-of-n] Comparison winner selected but merge did not complete.', payload.result?.note);
      }

      await loadOrchestratorMissionState();
    } catch (error) {
      console.error('[best-of-n] Failed to pick comparison winner.', error);
    }
  }, []);

  const greeting = useMemo(() => timeOfDayGreeting(), []);
  const runtimeLabel = lockedMode === 'single'
    ? orchestratorRuntimeTone(initialSingleRuntime ?? 'codex').label
    : 'O8 Operator';

  const emptyStateNode = useMemo(
    () => (
      <OrchestratorEmptyState
        greeting={greeting}
        runtimeLabel={runtimeLabel}
        onActionClick={handleQuickAction}
      />
    ),
    [greeting, runtimeLabel, handleQuickAction],
  );

  // Restoring shimmer — swaps in for the "Good morning" empty state
  // while we're loading the last-active thread from localStorage. Keeps
  // the operator from seeing a confusing empty greeting that immediately
  // gets replaced with a real conversation.
  const restoringShimmerNode = useMemo(
    () => (
      <ThreadRestoreShimmer />
    ),
    [],
  );

  const emptyOrShimmerNode = isRestoringThread ? restoringShimmerNode : emptyStateNode;

  const hasMessages = chatChromeState.hasMessages;

  const thoughtsBodyBackground = 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%)';
  const thoughtsElevatedSurface = 'var(--t-glass-elevated)';
  const thoughtsElevatedBorder = '1px solid var(--t-glass-border-strong)';
  const thoughtsElevatedShadow = 'var(--t-glass-shadow)';
  const thoughtsMutedGlass = 'var(--t-glass-muted-strong)';

  const composerLeadingExtras = lockedMode === 'chat' && spawnHandlers ? (
    <ChatOpenRouterPicker
      selectedSlug={initialChatOpenrouterModel}
      onSelect={handlePickChatOpenRouterModel}
    />
  ) : null;

  const isFullAccess = permissionMode === 'full';

  if (!data) {
    return (
      <div
        style={{
          flex: 1,
          display: active ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--t-chat-surface-bg, #ffffff)',
          color: 'var(--t-text-muted)',
          fontSize: 12,
        }}
      >
        Orchestrator data unavailable.
      </div>
    );
  }

  const thoughtsChatPanel = (
    <ThoughtsChatPanel
      ref={chatPanelRef}
      open={active}
      draftInjection={effectiveDraftInjection}
      agents={agents}
      missionState={data.missionState}
      preferredRuntime={preferredRuntime}
      sessionTargets={sessionTargets}
      workspaceTargets={data.workspaceTargets ?? []}
      repoPath={repoPath ?? null}
      thoughtsBodyBackground={thoughtsBodyBackground}
      thoughtsElevatedSurface={thoughtsElevatedSurface}
      thoughtsElevatedBorder={thoughtsElevatedBorder}
      thoughtsElevatedShadow={thoughtsElevatedShadow}
      thoughtsMutedGlass={thoughtsMutedGlass}
      permissionMode={permissionMode}
      onTogglePermission={handleTogglePermission}
      repoLabel={repoLabel}
      emptyStateOverride={emptyOrShimmerNode}
      showInlineExport={false}
      lockedMode={lockedMode}
      initialMode={initialMode}
      initialSingleRuntime={initialSingleRuntime}
      initialChatModelId={initialChatModelId}
      initialChatOpenrouterModel={initialChatOpenrouterModel}
      onModePersist={spawnHandlers ? handleModePersist : undefined}
      onSpawnSingleTab={spawnHandlers?.spawnSingleRuntimeTab
        ? (runtime) => { spawnHandlers.spawnSingleRuntimeTab(runtime); }
        : undefined}
      onSpawnChatTab={spawnHandlers?.spawnChatTab
        ? () => { spawnHandlers.spawnChatTab(); }
        : undefined}
      onChatSummary={onChatSummary}
      footerMeterSlot={(
        <ContextMeter
          tokenCount={contextUsage.tokenCount}
          runningTotal={contextUsage.runningTotal}
        />
      )}
      composerLeadingExtras={composerLeadingExtras}
      onMissionStateChange={data.onMissionStateChange}
      onLaunchPacket={data.onLaunchPacket}
      onChromeChange={setChatChromeState}
    />
  );

  return (
    <div
      style={{
        flex: 1,
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--t-chat-surface-bg, #ffffff)',
      }}
    >

      {/* Plan-mode banner */}
      {!isFullAccess ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 7,
            paddingRight: 14,
            paddingBottom: 7,
            paddingLeft: 14,
            borderBottomWidth: '0.5px',
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
            background: 'var(--t-panel-hover)',
            color: 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Read-only mode — Claude will inspect but cannot modify files or run side-effecting commands.
        </div>
      ) : null}

      {readyComparisonGroups.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
            background: 'var(--t-chat-surface-bg, #ffffff)',
          }}
        >
          {readyComparisonGroups.map((group) => (
            <ComparisonPicker
              key={group.groupId}
              groupId={group.groupId}
              packets={group.packets}
              onPickWinner={handlePickComparisonWinner}
              onDismiss={() => handleDismissComparisonGroup(group.groupId)}
            />
          ))}
        </div>
      ) : null}

      {/* Body: chat (flex) | branch details (self-hides). Threads/Archive
          moved into LeftPanelProjectFocus → Chats + Agents tabs. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
        }}
      >
        {/* Chat body */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}
        >
          {sessionTiles.isTiled ? (
            <SessionTileSurface
              layout={sessionTiles.layout}
              focusedSessionKey={sessionTiles.focusedSessionKey}
              chatSlot={thoughtsChatPanel}
              onResizeSplit={sessionTiles.resizeSplit}
              onCloseLeaf={sessionTiles.closeSessionLeafById}
              onFocusSession={sessionTiles.setFocusedSessionKey}
            />
          ) : thoughtsChatPanel}
        </div>

        {/* Right: Branch details launcher (Codex pattern). Self-hides when
            the wide O8 right panel is open and when no packet is selected. */}
        <BranchDetailsLauncher />
      </div>
      <span style={{ display: 'none' }} aria-hidden data-chrome={chatChromeState.activeTargetLabel} />
      <QuickActionPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={handlePalettePick}
      />
      {sessionTiles.pillContextMenu ? (
        <SessionPillContextMenu
          open
          x={sessionTiles.pillContextMenu.request.clientX}
          y={sessionTiles.pillContextMenu.request.clientY}
          items={buildPillContextMenuItems(
            sessionTiles.pillContextMenu.request,
            sessionTiles.sessionLeaves,
            sessionTiles.splitSessionFromMenu,
            sessionTiles.closeSessionLeafById,
          )}
          onClose={sessionTiles.closePillContextMenu}
        />
      ) : null}
    </div>
  );
}

/** Loading placeholder that swaps in for OrchestratorEmptyState while
 *  the last-active thread is rehydrating from localStorage. Three thin
 *  bars + a thicker one mimic the shape of an arriving conversation
 *  without claiming any specific content. The shimmer sweep matches
 *  the SessionTimeline pattern so motion vocabulary stays consistent. */
function ThreadRestoreShimmer() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        gap: 12,
        paddingTop: 64,
        paddingLeft: 'max(8vw, 80px)',
        paddingRight: 'max(8vw, 80px)',
      }}
      aria-label="Restoring conversation"
      aria-live="polite"
    >
      <style>{`
        @keyframes o8RestoreShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      {[68, 84, 52, 76].map((widthPct, i) => (
        <div
          key={i}
          style={{
            alignSelf: i % 2 === 0 ? 'flex-start' : 'flex-end',
            width: `${widthPct}%`,
            maxWidth: 520,
            height: i === 1 ? 64 : 16,
            borderRadius: i === 1 ? 14 : 6,
            // Fixed slate rgba — the previous `var(--t-bg-card)` / `var(--t-hover)`
            // resolved to near-transparent in light mode, making the bars
            // invisible. These constants read on both light and midnight.
            background: 'linear-gradient(90deg, rgba(15, 23, 42, 0.06) 0%, rgba(15, 23, 42, 0.14) 50%, rgba(15, 23, 42, 0.06) 100%)',
            backgroundSize: '200% 100%',
            animation: 'o8RestoreShimmer 1.8s linear infinite',
          }}
        />
      ))}
    </div>
  );
}
