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
  OrchestratorComposerBelow,
  timeOfDayGreeting,
  type WorktreeMode,
  type OrchestratorEmptyKind,
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
  projectContextRailVisible?: boolean;
  // Forwarded to ThoughtsChatPanel — fires with the latest user message
  // text in chat mode so the tab strip can show a 3-word summary instead
  // of the generic "Chat" label.
  onChatSummary?: (text: string) => void;
  /** Bottom/auxiliary mounts should not claim workspace history routing. */
  acceptHistoryThreadLoads?: boolean;
  /** Disable restoring the last top-level orchestrator thread for isolated mounts. */
  restoreLastThread?: boolean;
  /** Disable broadcasting workspace-thread id changes from isolated mounts. */
  publishWorkspaceThread?: boolean;
  /** Disable updating the global last-active orchestrator thread. */
  persistLastThread?: boolean;
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
  projectContextRailVisible = true,
  onChatSummary,
  acceptHistoryThreadLoads = true,
  restoreLastThread = true,
  publishWorkspaceThread = true,
  persistLastThread = true,
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
    if (!publishWorkspaceThread) return;
    window.dispatchEvent(new CustomEvent('o8:workspace-thread-id', {
      detail: { tabId, threadId: chatChromeState.threadId },
    }));
  }, [active, publishWorkspaceThread, tabId, chatChromeState.threadId]);

  // When the loaded thread changes, fetch the chat-history record and
  // sync its title into the workspace tab's label so the header strip
  // reads the operator's chosen name (e.g. "o8.v1") instead of the
  // default "Orchestrator". Mirrors what handleTitleRenameSubmit does
  // after a rename, but reactive to thread switches + reload restores.
  //
  // When the new thread has no title yet (fresh "New session" click —
  // no chat-history record OR record without a title), reset the
  // workspace tab label to the "Orchestrator" sentinel so the previous
  // thread's label doesn't bleed through into the new conversation.
  // workspaceConversationHeaderLabel + the tab strip both treat
  // "Orchestrator" as a fallthrough → recompute from messages /
  // workspaceTabPrimaryLabel.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const threadId = chatChromeState.threadId;
    if (!threadId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`);
        if (cancelled) return;
        const data = res.ok ? await res.json() : null;
        // Match the /list endpoint's title resolution: data.title wins,
        // but fall back to the first user-message snippet so a saved
        // conversation without an explicit `title` field still surfaces
        // a meaningful tab label (without this, an orchestrator thread
        // with real content but no title field flashes back to
        // 'Orchestrator' on every reload — that's what the operator
        // saw in dogfood after clicking a named thread).
        const explicitTitle = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : null;
        const firstUserMsg = Array.isArray(data?.messages)
          ? data.messages.find((m: { role?: string; content?: string }) => m?.role === 'user' && typeof m?.content === 'string' && m.content.trim())
          : null;
        const fallbackTitle = firstUserMsg?.content
          ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ') + (firstUserMsg.content.length > 60 ? '...' : '')
          : null;
        const title = explicitTitle ?? fallbackTitle;
        if (cancelled) return;
        if (title) {
          // Persist the title alongside the threadId so the next reload
          // can pre-set tab.label at tab-creation time (no "Orchestrator"
          // flash before the chat-history fetch completes).
          if (active && persistLastThread) writeLastOrchestratorThread(threadId, title);
          window.dispatchEvent(new CustomEvent('o8:chat-history-updated', {
            detail: { tabId, threadId, title },
          }));
          return;
        }
        // Truly empty thread (no title + no messages) — emit the
        // kind-aware spawn default so the previous thread's label
        // doesn't stick on the workspace tab pill. llm-chat tabs
        // (lockedMode='chat') get 'Chat'; orchestrator tabs get
        // 'Orchestrator'. Matches buildNewLlmChatTab + the orchestrator
        // tab's spawn defaults so the workspace pill reads consistently.
        const freshLabel = lockedMode === 'chat' ? 'Chat' : 'Orchestrator';
        window.dispatchEvent(new CustomEvent('o8:chat-history-updated', {
          detail: { tabId, threadId, title: freshLabel },
        }));
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [active, persistLastThread, tabId, chatChromeState.threadId, lockedMode]);

  // Persist the last-active orchestrator thread id globally so dev
  // reloads drop the operator back into their last conversation. Only
  // persists when the active thread HAS messages — without this guard
  // the placeholder-mint pattern (#597) would overwrite the saved id
  // with a fresh empty thread the moment a new tab mounted, defeating
  // the whole point of the restore.
  useEffect(() => {
    if (!active) return;
    if (!persistLastThread) return;
    if (!chatChromeState.hasMessages) return;
    if (chatChromeState.threadId) {
      // Don't clear the title here — only the threadId update fires this
      // effect. The title-sync effect above handles the (threadId, title)
      // tuple write. Pass `undefined` to leave the stored title alone.
      writeLastOrchestratorThread(chatChromeState.threadId);
    }
  }, [active, persistLastThread, chatChromeState.threadId, chatChromeState.hasMessages]);

  // (First-message side-effects useEffect is declared further down,
  // AFTER worktreeMode / pickedBranch / activeWorkspaceTarget so the
  // hook reads concrete values, not undefined refs.)

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
    if (!restoreLastThread) return false;
    // Only orchestrator tabs in default mode (no explicit initialThreadId)
    // participate in the restore path.
    if (initialThreadId) return false;
    return Boolean(readLastOrchestratorThreadId());
  });
  useEffect(() => {
    if (!active) return;
    if (!restoreLastThread) return;
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
  }, [active, initialThreadId, restoreLastThread]);

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
      if (!acceptHistoryThreadLoads) return;
      if (detail.tabId) {
        if (detail.tabId !== tabId) return;
      } else if (!active) {
        return;
      }
      chatPanelRef.current?.loadThread(detail.historyTabId);
      window.setTimeout(() => chatPanelRef.current?.focusInput(), 40);
    };
    window.addEventListener('o8:load-history-thread', handleLoadHistoryThread);
    return () => window.removeEventListener('o8:load-history-thread', handleLoadHistoryThread);
  }, [acceptHistoryThreadLoads, active, tabId]);

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

  // Worktree mode for the compose-first empty state. Defaults to
  // 'new-worktree' so the operator's governance ethos (don't dirty main
  // unless asked) lands by default; flips to 'local' for quick chats.
  // Local-state for v1 — persistence onto the tab is a follow-up once
  // dispatch reads this on first agent spawn.
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>('new-worktree');
  // Optimistic branch override for the empty-state Branch chip. Real
  // branch checkout fires on first message (when the operator has
  // committed to this conversation); here we just track the operator's
  // intent so the chip label reflects the chosen branch immediately.
  const [pickedBranch, setPickedBranch] = useState<string | null>(null);
  // "Don't work in a project" override — the Project chip's clear
  // action doesn't have a way to wipe tab.repo from this layer, so we
  // track the operator's intent locally and let the empty-state
  // surface render with no project context. Resets to false the
  // moment the operator picks another project.
  const [scopeCleared, setScopeCleared] = useState(false);

  // Kind toggle on the empty state. lockedMode='chat' = llm-chat tab,
  // can't pivot. Otherwise: 'chat' if the tab's current mode is chat,
  // else 'orchestrator'. Flipping kind calls the existing mode
  // persistence path so the tab state actually moves.
  const emptyKind: OrchestratorEmptyKind = lockedMode === 'chat' || initialMode === 'chat'
    ? 'chat'
    : 'orchestrator';
  const emptyKindLocked = lockedMode === 'chat';
  const handleEmptyKindChange = useCallback((next: OrchestratorEmptyKind) => {
    if (!spawnHandlers || emptyKindLocked) return;
    const mode: 'fleet' | 'chat' = next === 'chat' ? 'chat' : 'fleet';
    // Persist on the tab (so restore picks it up) AND dispatch the
    // event the active ThoughtsChatPanel listens for so its internal
    // orchestrationMode state flips immediately — otherwise the
    // composer's model label sticks on the Orchestrator's model
    // (e.g. "Opus 4.7") after toggling to Chat.
    spawnHandlers.updateTabMode(tabId, { mode });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('o8:set-orchestration-mode', {
        detail: { mode },
      }));
    }
  }, [emptyKindLocked, spawnHandlers, tabId]);

  // Resolve the active workspace target for the Project chip label.
  const activeWorkspaceTarget = useMemo(() => (
    scopeCleared
      ? null
      : (data?.workspaceTargets?.find((target) => target.localPath === (repoPath ?? '')) ?? null)
  ), [data?.workspaceTargets, repoPath, scopeCleared]);
  const projectLabel = scopeCleared ? null : (repoLabel ?? activeWorkspaceTarget?.repoName ?? null);
  const effectiveRepoPath = scopeCleared ? null : (repoPath ?? null);
  const branchLabel = pickedBranch ?? activeWorkspaceTarget?.branch?.trim() ?? 'main';
  // Reset the local override whenever the target repo changes — the
  // chip otherwise sticks to the prior repo's branch name.
  useEffect(() => {
    setPickedBranch(null);
  }, [activeWorkspaceTarget?.localPath]);

  // First-message side-effects — fires once when the chat goes from
  // empty → has messages. The compose-first empty state lets the
  // operator pick a Worktree mode + Branch up front; when they finally
  // send the first message we "lock in" those choices:
  //   - Branch picked ≠ repo's current branch → checkout it.
  //   - Worktree mode → persist on the tab so any downstream dispatch
  //     (mcp__o8__dispatch_mission) reads tab.worktreeMode and
  //     provisions a worktree at THAT point, not now. Provisioning
  //     upfront for a pure brainstorm chat was wasteful and the create
  //     call hung the chat pipeline on cortex-sized repos (#1142).
  // All network calls are fire-and-forget; failures log to console.
  const lockedInRef = useRef(false);
  useEffect(() => {
    if (lockedInRef.current) return;
    if (!chatChromeState.hasMessages) return;
    lockedInRef.current = true;
    if (pickedBranch && repoPath
        && pickedBranch.trim()
        && pickedBranch !== (activeWorkspaceTarget?.branch ?? 'main')) {
      void fetch('/api/panel/branches/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoPath, branch: pickedBranch }),
      }).catch((error) => {
        console.error('[empty-state] branch checkout failed', error);
      });
    }
    if (spawnHandlers) {
      spawnHandlers.updateTabMode(tabId, { worktreeMode });
    }
  }, [
    chatChromeState.hasMessages,
    pickedBranch,
    repoPath,
    activeWorkspaceTarget?.branch,
    worktreeMode,
    spawnHandlers,
    tabId,
  ]);

  const handleEmptySelectProject = useCallback((target: { localPath: string; repoName: string }) => {
    // Switching project on a fresh empty tab — clear the no-project
    // override (if it was set) so the chosen project actually surfaces
    // in the title + chip, then dispatch the existing scope-select
    // event the dashboard listens for. After first message the empty
    // state is gone so this path is unreachable.
    setScopeCleared(false);
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:select-workspace-scope', {
      detail: { repoPath: target.localPath, repoName: target.repoName },
    }));
  }, []);
  const handleEmptyAddProject = useCallback((mode?: 'scratch' | 'existing') => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:open-add-repo-flow', { detail: { mode } }));
  }, []);
  const handleEmptyWorkWithoutProject = useCallback(() => {
    // Local override — tab.repo isn't directly mutable from this
    // layer, but the empty-state surface respects `scopeCleared` so
    // the title flips to "your workspace" and the chip reads "No
    // project". Picking another project resets this.
    setScopeCleared(true);
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:select-workspace-scope', {
      detail: { repoPath: null, repoName: null },
    }));
  }, []);

  const emptyStateNode = useMemo(
    () => (
      <OrchestratorEmptyState
        greeting={greeting}
        runtimeLabel={runtimeLabel}
        onActionClick={handleQuickAction}
        repoPath={effectiveRepoPath}
        repoLabel={projectLabel}
        workspaceTargets={data?.workspaceTargets ?? []}
        onSelectProject={handleEmptySelectProject}
        onAddProject={handleEmptyAddProject}
        onWorkWithoutProject={handleEmptyWorkWithoutProject}
        worktreeMode={worktreeMode}
        onWorktreeModeChange={setWorktreeMode}
        branch={branchLabel}
        kind={emptyKind}
        kindLocked={emptyKindLocked}
        onKindChange={handleEmptyKindChange}
      />
    ),
    [
      greeting,
      runtimeLabel,
      handleQuickAction,
      repoPath,
      projectLabel,
      data?.workspaceTargets,
      handleEmptySelectProject,
      handleEmptyAddProject,
      handleEmptyWorkWithoutProject,
      worktreeMode,
      branchLabel,
      emptyKind,
      emptyKindLocked,
      handleEmptyKindChange,
    ],
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
      imageInjection={data?.imageInjection ?? null}
      onImageInjectionConsumed={data?.onImageInjectionConsumed}
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
      composerBelowSlot={(
        <OrchestratorComposerBelow
          worktreeMode={worktreeMode}
          onWorktreeModeChange={setWorktreeMode}
          branch={branchLabel}
          repoPath={effectiveRepoPath}
          onBranchChange={setPickedBranch}
          kind={emptyKind}
          kindLocked={emptyKindLocked}
          onKindChange={handleEmptyKindChange}
          onActionClick={handleQuickAction}
        />
      )}
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
            paddingTop: 6,
            paddingRight: 14,
            paddingBottom: 6,
            paddingLeft: 14,
            borderBottomWidth: '0.5px',
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
            background: 'var(--t-panel-hover)',
            color: 'var(--t-text-faint)',
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.35,
            flexShrink: 0,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span style={{ color: 'var(--t-text-muted)' }}>Read-only mode</span>
          <span> — Claude will inspect but cannot modify files or run side-effecting commands.</span>
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
        <BranchDetailsLauncher visible={projectContextRailVisible} />
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
