'use client';

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ForwardedRef, type MouseEvent as ReactMouseEvent } from 'react';
import {
  buildRepoStateScope,
  loadTabState,
  saveTabState,
  scrubLocalStorageTabZombies,
  type PersistedTabState,
} from '@/lib/terminal/tab-state';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { ChatModelId } from '@/components/desktop/orchestrator/chat-models';
import { useExperimentalChatFlag } from '@/lib/operator/use-experimental-chat';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import type { OrchestrationMode, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { ORCHESTRATED_TAB_AUTO_ARCHIVE_MS } from '@/components/desktop/workspace-terminal/constants';
import type {
  LocalhostPreview,
  RegisteredRepo,
  TerminalTab,
  TerminalTabHandle,
  WorkspaceChatRuntime,
  WorkspaceTerminalProps,
} from '@/components/desktop/workspace-terminal/types';
import {
  buildWorkspaceLaneState,
  createWorkspaceTabId,
  deriveFocusedLaneRepo,
  generateLlmChatTabId,
  isReusableBlankOrchestratorTab,
} from '@/components/desktop/workspace-terminal/utils';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { buildTerminalTabHandle } from '@/components/desktop/workspace-terminal/terminal-imperative-handle';
import { readLastOrchestratorThreadTitle } from '@/components/desktop/workspace-terminal/orchestrator-thread-restore';
import { scrubOrphanSessionTileKeys } from '@/components/desktop/workspace-terminal/use-session-tiles';
import { canPreserveScopedTabs, computeRestoredTabs, loadInitialTabState, resetControllerRefs, shouldSkipRestoreKeyChange } from '@/components/desktop/workspace-terminal/terminal-restore';
import {
  buildChatSessionSnapshots,
  buildCommitCanvasTab,
  computeChatSessionSignature,
  computeCliChatSession,
  computeInspectorTab,
  computeLlmChatSession,
  buildLlmInjection,
  resolveActiveChatSessionKey,
} from '@/components/desktop/workspace-terminal/terminal-session-ops';
import {
  buildHistoryChatTab,
  buildNewChatTab,
  buildNewLlmChatTab,
  buildPersistedState,
  computeCheckpointRestore,
  computeNewTerminalTab,
  flushPendingCliCommands,
  isAutoArchiveEligible,
  resolveRunCommandTarget,
  observeXtermHelperNames,
  shellQuote,
  startPreviewDrag,
  computeSaveCheckpoint,
  computeUpdatedChatMessages,
  computeUpdatedChatSessionKey,
} from '@/components/desktop/workspace-terminal/terminal-tab-handlers';
import { useWorkspaceTabCleanup } from '@/components/desktop/workspace-terminal/useWorkspaceTabCleanup';

type ControllerProps = WorkspaceTerminalProps;

export function useWorkspaceTerminalController(
  {
    stateScope,
    defaultTab,
    autoCreateDefaultTab = true,
    preferredRepo = null,
    splitCreated = false,
    availableRepos = [],
    onActiveChatSessionChange,
    onActiveTabKindChange,
    onChatSessionsChange,
    onActiveLaneChange,
    onRepoScopeChange,
    onActiveRepoContextChange,
    onOpenRepoDiff,
    onPreviewDetected,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalDetach,
    sendTerminalInput,
    termWsConnected,
  }: ControllerProps,
  ref: ForwardedRef<TerminalTabHandle>,
) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [previews, setPreviews] = useState<LocalhostPreview[]>([]);
  const [restoreCompletedKey, setRestoreCompletedKey] = useState<string | null>(null);
  const [previewHeight, setPreviewHeight] = useState(0.55);
  const [isDragging, setIsDragging] = useState(false);
  const [launchRequestKey, setLaunchRequestKey] = useState(0);

  const containerDivRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<TerminalTab[]>([]);
  const panelRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
  const pendingCliCommands = useRef<Map<string, string>>(new Map());
  const pendingRequestRef = useRef<Map<string, string>>(new Map());
  const pendingSessionsRef = useRef<Set<string>>(new Set());
  const restoredRef = useRef(false);
  const restoreSettledRef = useRef(false);
  const restoreInFlightRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectedPortsRef = useRef<Set<number>>(new Set());
  const urlDetectionEnabledRef = useRef(false);
  const previousWsConnectedRef = useRef(false);
  const termWsConnectedRef = useRef(termWsConnected);
  const initialTerminalBootstrapRef = useRef(false);
  const restoreKeyRef = useRef<string | null>(null);
  const preferredRepoRef = useRef(preferredRepo);
  const reportedRepoScopeRef = useRef<string | null | undefined>(undefined);
  const chatSessionsChangeRef = useRef(onChatSessionsChange);
  const activeChatSessionChangeRef = useRef(onActiveChatSessionChange);
  const reportedChatSessionsSignatureRef = useRef('');
  const reportedActiveChatSessionKeyRef = useRef<string | null>(null);

  // Phase 4 friction fix #4: tab-navigation race during HMR.
  // The restore pipeline (loadInitialTabState → applyPersistedState) is
  // async. While the await resolves, the user may have clicked a different
  // tab — the late-landing setActiveTabId from restore would then yank
  // them back, looking like a phantom navigation. Track a monotonic
  // counter that bumps on every USER-driven setActiveTabId; restore
  // captures the value at the start of its async work and bails if a
  // newer user nav landed in the interim.
  const userNavVersionRef = useRef(0);
  const setActiveTabIdFromUser = useCallback((next: string) => {
    userNavVersionRef.current += 1;
    setActiveTabId(next);
  }, []);
  const setActiveTabIdFromRestore = useCallback((next: string, capturedVersion: number) => {
    if (capturedVersion !== userNavVersionRef.current) {
      // Newer user nav landed during the restore await — drop this stale
      // restore action so the user's tab stays put.
      return false;
    }
    setActiveTabId(next);
    return true;
  }, []);

  useEffect(() => {
    preferredRepoRef.current = preferredRepo;
  }, [preferredRepo]);

  const stableRepoScope = !splitCreated && preferredRepo?.localPath
    ? buildRepoStateScope(preferredRepo.localPath)
    : null;
  const restoreKey = useMemo(
    () => [
      stateScope,
      defaultTab,
      splitCreated ? 'split' : 'shared',
      preferredRepo?.localPath ?? 'no-repo',
    ].join('::'),
    [defaultTab, preferredRepo?.localPath, splitCreated, stateScope],
  );
  const primaryRestoreSettled = restoreCompletedKey === restoreKey;
  // Alpha: the casual llm-chat ("o8 Default") tab is hidden behind
  // experimentalChat. Filter it out of the rendered set when off — existing
  // tabs disappear from the bar (effectiveActiveTabId falls back to another
  // visible tab) and the composer unmounts, so the orchestrator is the only
  // conversational surface. The tab data stays persisted for when it flips on.
  const experimentalChat = useExperimentalChatFlag();
  // Same alpha pattern for the fleet-canvas tab — hidden (data preserved)
  // unless experimentalCanvas is on. See docs/canvas-mode-plan.md.
  const experimentalCanvas = useExperimentalCanvasFlag();
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => {
      if (tab.kind === 'canvas' && tab.canvasTab?.kind === 'ci') return false;
      if (!experimentalChat && tab.kind === 'llm-chat') return false;
      if (!experimentalCanvas && tab.kind === 'fleet-canvas') return false;
      return true;
    }),
    [tabs, experimentalChat, experimentalCanvas],
  );
  const effectiveActiveTabId = useMemo(
    () => visibleTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : (visibleTabs[visibleTabs.length - 1]?.id ?? ''),
    [activeTabId, visibleTabs],
  );
  const activeTab = useMemo(
    () => visibleTabs.find((tab) => tab.id === effectiveActiveTabId) ?? null,
    [effectiveActiveTabId, visibleTabs],
  );
  // Mirror the focused tab id into a ref so the (event-driven) orchestrator
  // spawn callbacks can read the CURRENT focus at click time without taking
  // effectiveActiveTabId as a dep (which would churn the imperative handle on
  // every tab switch). Backs deriveFocusedLaneRepo — Fix 1.
  const effectiveActiveTabIdRef = useRef(effectiveActiveTabId);
  useEffect(() => {
    effectiveActiveTabIdRef.current = effectiveActiveTabId;
  }, [effectiveActiveTabId]);
  const activeCheckpoint = activeTab?.kind === 'chat' ? activeTab.chatCheckpoints?.[0] : null;
  const activeRepo = activeTab?.repo ?? visibleTabs.find((tab) => tab.repo)?.repo ?? preferredRepo ?? null;
  const activeLaneState = useMemo(
    () => buildWorkspaceLaneState(stateScope, activeTab, preferredRepo ?? null),
    [activeTab, preferredRepo, stateScope],
  );
  const activeRepoContext = useMemo<RegisteredRepo | null>(() => {
    if (!activeRepo) return null;
    return {
      ...activeRepo,
      branch: activeRepo.branch ?? preferredRepo?.branch ?? null,
      readiness: activeRepo.readiness ?? preferredRepo?.readiness ?? null,
      remoteUrl: activeRepo.remoteUrl ?? preferredRepo?.remoteUrl,
    };
  }, [activeRepo, preferredRepo]);

  const resolvePersistenceScope = useCallback((currentTabs: TerminalTab[]) => {
    const preferredRepoPath = preferredRepoRef.current?.localPath ?? null;
    if (
      stableRepoScope
      && preferredRepoPath
      && currentTabs.every((tab) => !tab.repo?.localPath || tab.repo.localPath === preferredRepoPath)
    ) {
      return stableRepoScope;
    }
    return stateScope;
  }, [stableRepoScope, stateScope]);

  useEffect(() => {
    chatSessionsChangeRef.current = onChatSessionsChange;
    activeChatSessionChangeRef.current = onActiveChatSessionChange;
  }, [onActiveChatSessionChange, onChatSessionsChange]);

  const reportedActiveTabKindRef = useRef<string>('');
  useEffect(() => {
    if (!onActiveTabKindChange) return;
    const kind = activeTab?.kind ?? null;
    const signature = `${kind ?? 'null'}::${effectiveActiveTabId}`;
    if (reportedActiveTabKindRef.current === signature) return;
    reportedActiveTabKindRef.current = signature;
    onActiveTabKindChange(kind, effectiveActiveTabId);
  }, [activeTab, effectiveActiveTabId, onActiveTabKindChange]);

  useEffect(() => {
    termWsConnectedRef.current = termWsConnected;
  }, [termWsConnected]);

  useEffect(() => {
    const previousKey = restoreKeyRef.current;
    if (previousKey === restoreKey) return;
    restoreKeyRef.current = restoreKey;

    if (shouldSkipRestoreKeyChange(previousKey, restoreKey, restoreInFlightRef.current, tabsRef.current.length)) {
      return;
    }

    const shouldPreserve = canPreserveScopedTabs(tabsRef.current, preferredRepo?.localPath ?? null);
    resetControllerRefs({
      restoredRef, restoreSettledRef, previousWsConnectedRef, initialTerminalBootstrapRef,
      reportedRepoScopeRef, reportedChatSessionsSignatureRef, reportedActiveChatSessionKeyRef,
      detectedPortsRef, pendingCliCommands, pendingRequestRef, saveTimerRef,
    });
    if (shouldPreserve) {
      restoredRef.current = true;
      restoreSettledRef.current = true;
      const frame = window.requestAnimationFrame(() => {
        setRestoreCompletedKey(restoreKey);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    urlDetectionEnabledRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      setPreviews([]);
      tabsRef.current = [];
      setTabs([]);
      setActiveTabId('');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [preferredRepo?.localPath, restoreKey]);

  useEffect(() => {
    const nextSessions = buildChatSessionSnapshots(
      visibleTabs, effectiveActiveTabId,
      preferredRepo?.localPath ?? '', preferredRepo?.branch ?? 'main',
      stableRepoScope, stateScope,
    );
    const signature = computeChatSessionSignature(nextSessions);
    if (reportedChatSessionsSignatureRef.current !== signature) {
      reportedChatSessionsSignatureRef.current = signature;
      chatSessionsChangeRef.current?.(nextSessions);
    }
    const nextActiveKey = resolveActiveChatSessionKey(nextSessions, reportedActiveChatSessionKeyRef.current);
    if (reportedActiveChatSessionKeyRef.current !== nextActiveKey) {
      reportedActiveChatSessionKeyRef.current = nextActiveKey;
      activeChatSessionChangeRef.current?.(nextActiveKey);
    }
  }, [effectiveActiveTabId, preferredRepo?.branch, preferredRepo?.localPath, stableRepoScope, stateScope, visibleTabs]);

  const persistTabsNow = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
    const persisted = buildPersistedState(currentTabs, currentActiveId);
    const persistenceScope = resolvePersistenceScope(currentTabs);
    void saveTabState(persisted, persistenceScope);
    if (persistenceScope !== stateScope) {
      if (stateScope === 'tile-root') {
        void saveTabState(persisted, stateScope);
      } else {
        void saveTabState({ version: 1, activeTabId: '', tabs: [], savedAt: persisted.savedAt }, stateScope);
      }
    }
  }, [resolvePersistenceScope, stateScope]);

  const persistTabs = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistTabsNow(currentTabs, currentActiveId);
    }, 500);
  }, [persistTabsNow]);

  const requestTerminalForTab = useCallback((tabId: string, command?: string) => {
    const requestId = `workspace-${tabId}-${Date.now()}`;
    pendingRequestRef.current.set(requestId, tabId);
    pendingSessionsRef.current.add(tabId);
    if (command) {
      pendingCliCommands.current.set(tabId, command);
    }
    sendTerminalCreate(120, 30, requestId);
  }, [sendTerminalCreate]);

  useEffect(() => {
    tabsRef.current = tabs;
    if (restoreSettledRef.current) {
      persistTabs(tabs, effectiveActiveTabId);
    }
    // `restoreCompletedKey` is a dep so this re-arms at every settle point
    // (#1234): a tab op that lands while the gate is closed — or whose
    // debounced save gets cleared by resetControllerRefs during a restore-key
    // change — would otherwise never be re-persisted until the NEXT tab op.
    // Every settle path calls setRestoreCompletedKey, so the gate opening
    // flushes the accumulated state exactly once.
  }, [effectiveActiveTabId, persistTabs, restoreCompletedKey, tabs]);

  // Capture each orchestrator tab's chat-history thread id so the exact
  // conversation survives reload. OrchestratorTab broadcasts
  // 'o8:workspace-thread-id' whenever its loaded thread settles; stamping it
  // onto the tab (orchestratorThreadId) lets serializeTabsForPersistence
  // persist it and the restore path reopen THIS thread per-tab — instead of
  // every orchestrator tab collapsing onto the global last-active thread.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; threadId?: string | null }>).detail;
      const tabId = detail?.tabId;
      const threadId = detail?.threadId;
      if (!tabId || !threadId) return;
      // One orchestrator tab per thread. If another orchestrator tab already
      // owns this thread, `tabId` is a duplicate that landed on it — e.g. a
      // fresh/default tab that global-restored a conversation an existing tab
      // already shows. Close the duplicate (keeps the original + its transcript)
      // rather than leaving two copies of the same thread open.
      const owner = tabsRef.current.find(
        (t) => t.id !== tabId && t.kind === 'orchestrator' && t.orchestratorThreadId === threadId,
      );
      if (owner) {
        handleCloseTabRef.current(tabId);
        return;
      }
      setTabs((previous) => {
        const idx = previous.findIndex((t) => t.id === tabId && t.kind === 'orchestrator');
        if (idx < 0) return previous;
        if (previous[idx]!.orchestratorThreadId === threadId) return previous;
        const next = [...previous];
        next[idx] = { ...next[idx]!, orchestratorThreadId: threadId };
        tabsRef.current = next;
        return next;
      });
    };
    window.addEventListener('o8:workspace-thread-id', handler as EventListener);
    return () => window.removeEventListener('o8:workspace-thread-id', handler as EventListener);
  }, []);

  // Dashboard repo picker → re-bind the active orchestrator tab's repo (#1265).
  // OrchestratorTab's empty-state Project chip broadcasts
  // 'o8:select-workspace-scope' when the user picks a repo, but nothing on the
  // dashboard consumed it — so the choice never reached tab.repo and the
  // orchestrator stayed stuck on whatever repo it spawned with (e.g. o8-mobile).
  // Stamp the chosen repo onto the active orchestrator tab (the only tab whose
  // empty-state picker is reachable) so repoPath re-binds immediately. The
  // event carries name + localPath, which is all RegisteredRepo requires.
  // Mirrors the 'o8:workspace-thread-id' listener above.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ repoPath?: string; repoName?: string }>).detail;
      const repoPath = detail?.repoPath;
      if (!repoPath) return;
      setTabs((previous) => {
        const idx = previous.findIndex(
          (t) => t.id === effectiveActiveTabId && t.kind === 'orchestrator',
        );
        if (idx < 0) return previous;
        if (previous[idx]!.repo?.localPath === repoPath) return previous;
        const next = [...previous];
        next[idx] = {
          ...next[idx]!,
          repo: {
            name: detail?.repoName ?? repoPath.split('/').pop() ?? repoPath,
            localPath: repoPath,
          },
        };
        tabsRef.current = next;
        return next;
      });
    };
    window.addEventListener('o8:select-workspace-scope', handler as EventListener);
    return () => window.removeEventListener('o8:select-workspace-scope', handler as EventListener);
  }, [effectiveActiveTabId]);

  // One-time scrub of orphaned `…:session-tiles:tab:*` localStorage keys left
  // behind by closed tabs (they were never cleaned on close pre-fix). Runs once
  // after restore populates `tabs`, keying off the live tab ids so legit
  // layouts are preserved. Going forward, handleCloseTab clears keys on close.
  const orphanScrubDoneRef = useRef(false);
  // Keyed on restoreCompletedKey (not just tabs): that state flips exactly once
  // when restore finishes, in the same render that populates `tabs`. Gating on
  // `tabs` alone was racy — if restoreSettledRef flipped true AFTER the last
  // tabs change, the effect never re-ran and orphans survived that load.
  useEffect(() => {
    if (orphanScrubDoneRef.current) return;
    if (!restoreSettledRef.current) return;
    if (tabs.length === 0) return;
    orphanScrubDoneRef.current = true;
    const removed = scrubOrphanSessionTileKeys(new Set(tabs.map((t) => t.id)));
    if (removed > 0) console.log(`[session-tiles] scrubbed ${removed} orphaned tab layout key(s)`);
  }, [tabs, restoreCompletedKey]);

  const createDefaultShellTab = useCallback((): TerminalTab => ({
    id: createWorkspaceTabId('terminal'), label: 'Shell', kind: 'terminal',
    tmuxSession: null, cliAgent: 'shell', createdAt: Date.now(), lastActivity: Date.now(),
  }), []);

  const createDefaultChatTab = useCallback((): TerminalTab => ({
    id: generateLlmChatTabId(), label: 'Chat', kind: 'llm-chat',
    tmuxSession: null, repo: preferredRepoRef.current ?? undefined,
    linkedIssue: null, createdAt: Date.now(), lastActivity: Date.now(),
    chatModelId: 'o8-default',
  }), []);

  const createDefaultOrchestratorTab = useCallback((options?: { fresh?: boolean; repoOverride?: RegisteredRepo | null }): TerminalTab => {
    // For the boot-restore path: pre-set tab.label from the saved last-
    // active orchestrator title when one exists in localStorage. Without
    // this the header reads "Orchestrator" for 1-2s on cold reload before
    // the title-sync effect fetches chat-history and dispatches the
    // rename event.
    // For "+ New session" spawns (fresh=true): skip the restore so the
    // operator gets a true blank tab labeled "Orchestrator" — clicking
    // New session twice shouldn't duplicate the previous thread's name.
    const fresh = options?.fresh ?? false;
    // Fix 1: a caller can override the repo (focused-lane binding for new
    // spawns); otherwise fall back to the global preferredRepo as before.
    const repo = options?.repoOverride ?? preferredRepoRef.current ?? undefined;
    const savedTitle = fresh ? null : readLastOrchestratorThreadTitle(repo?.localPath ?? null);
    return {
      id: createWorkspaceTabId('orchestrator'),
      label: savedTitle ?? 'Orchestrator',
      kind: 'orchestrator',
      tmuxSession: null,
      repo,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      mode: 'fleet',
      ...(fresh ? { freshSpawn: true } : {}),
    };
  }, []);

  // Fresh workspace = Orchestrator first, Chat ready but not focused. The
  // orchestrator stays the command center while the left rail's Chat row has
  // a real tab to focus on first load.
  const createDefaultChatTabSet = useCallback((): TerminalTab[] => {
    // Alpha: don't spawn the casual llm-chat tab by default — orchestrator only,
    // unless experimentalChat is on. (visibleTabs also hides any pre-existing
    // llm-chat tab, so this is belt-and-suspenders + avoids a wasted spawn.)
    if (!experimentalChat) return [createDefaultOrchestratorTab()];
    return [createDefaultOrchestratorTab(), createDefaultChatTab()];
  }, [createDefaultChatTab, createDefaultOrchestratorTab, experimentalChat]);

  const spawnSingleRuntimeTab = useCallback((runtime: OrchestratorRuntime): string => {
    const newTab: TerminalTab = {
      id: createWorkspaceTabId('orchestrator'),
      label: orchestratorRuntimeTone(runtime).label,
      kind: 'orchestrator',
      tmuxSession: null,
      // Fix 1: prefer the focused worker-lane's repo over the stale global pick.
      repo: deriveFocusedLaneRepo(tabsRef.current, effectiveActiveTabIdRef.current)
        ?? preferredRepoRef.current
        ?? undefined,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      mode: 'single',
      singleRuntime: runtime,
    };
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    return newTab.id;
  }, [setActiveTabIdFromUser]);

  const spawnChatTab = useCallback((): string => {
    const newTab = createDefaultChatTab();
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    return newTab.id;
  }, [createDefaultChatTab, setActiveTabIdFromUser]);

  const spawnOrchestratorTab = useCallback((repoOverride?: RegisteredRepo | null): string => {
    // "+ New session → Orchestrator" — before minting yet another empty
    // Orchestrator tab, look for one the operator already has open with
    // no attached thread, no packet, and no draft. Focus it instead.
    // Mirrors the chat-side `isEmptyLlmChatTab` reuse in computeLlmChatSession.
    const emptyExisting = tabsRef.current.find(isReusableBlankOrchestratorTab);
    if (emptyExisting) {
      // Reusing a blank tab must be INDISTINGUISHABLE from spawning a new
      // one — resolve the same target a fresh spawn would (explicit
      // override → focused lane → global preferred) and retarget the blank
      // tab to it. Previously only an explicit repoOverride retargeted, so
      // the generic "+ New session" reused a stale blank minted against the
      // PREVIOUS repo and ignored the operator's current selection
      // (Q repro 2026-07-14: select o8, spawn, hero still says o8-mobile).
      const targetRepo = repoOverride
        ?? deriveFocusedLaneRepo(tabsRef.current, effectiveActiveTabIdRef.current)
        ?? preferredRepoRef.current
        ?? null;
      if (targetRepo && emptyExisting.repo?.localPath !== targetRepo.localPath) {
        const nextTabs = tabsRef.current.map((tab) => (
          tab.id === emptyExisting.id ? { ...tab, repo: targetRepo } : tab
        ));
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
      }
      setActiveTabIdFromUser(emptyExisting.id);
      return emptyExisting.id;
    }
    // User-initiated spawn via + New session — pass fresh=true so the
    // tab gets a clean 'Orchestrator' label and skips the boot-time
    // last-thread restore (see createDefaultOrchestratorTab comments).
    // Fix 1: bind to the focused worker-lane's repo when one is open, so
    // opening a fresh orchestrator while watching a lane from repo X doesn't
    // snap to whatever the stale global selection points at. An explicit
    // repoOverride (sidebar repo-header spawn) wins over both.
    const newTab = createDefaultOrchestratorTab({
      fresh: true,
      repoOverride: repoOverride ?? deriveFocusedLaneRepo(tabsRef.current, effectiveActiveTabIdRef.current),
    });
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    return newTab.id;
  }, [createDefaultOrchestratorTab, setActiveTabIdFromUser]);

  const spawnFleetCanvasTab = useCallback((): string => {
    // One fleet canvas per workspace is enough — focus the existing tab
    // instead of minting duplicates (the fleet data is identical anyway).
    const existing = tabsRef.current.find((tab) => tab.kind === 'fleet-canvas');
    if (existing) {
      setActiveTabIdFromUser(existing.id);
      return existing.id;
    }
    const newTab: TerminalTab = {
      id: createWorkspaceTabId('fleet-canvas'),
      label: 'Canvas',
      kind: 'fleet-canvas',
      tmuxSession: null,
      repo: preferredRepoRef.current ?? undefined,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    return newTab.id;
  }, [setActiveTabIdFromUser]);

  const handleUpdateTabMode = useCallback((
    tabId: string,
    patch: {
      mode?: OrchestrationMode;
      singleRuntime?: OrchestratorRuntime;
      chatModelId?: ChatModelId;
      chatOpenrouterModel?: string | null;
      worktreeMode?: 'local' | 'new-worktree';
      worktreePath?: string;
    },
  ) => {
    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== tabId) return tab;
      const next: typeof tab = { ...tab, lastActivity: Date.now() };
      if (patch.mode !== undefined) next.mode = patch.mode;
      if (patch.singleRuntime !== undefined) next.singleRuntime = patch.singleRuntime;
      if (patch.chatModelId !== undefined) next.chatModelId = patch.chatModelId;
      if (patch.chatOpenrouterModel !== undefined) {
        // null clears the override; string sets it.
        next.chatOpenrouterModel = patch.chatOpenrouterModel ?? undefined;
      }
      if (patch.worktreeMode !== undefined) next.worktreeMode = patch.worktreeMode;
      if (patch.worktreePath !== undefined) next.worktreePath = patch.worktreePath;
      return next;
    }));
  }, []);

  const applyPersistedState = useCallback(async (saved: PersistedTabState, cancelled?: () => boolean) => {
    // Capture the user-nav version at the start of restore. If the user
    // clicks a different tab while computeRestoredTabs is awaiting, the
    // captured version goes stale and we drop the activeTabId update.
    const capturedNavVersion = userNavVersionRef.current;
    const result = await computeRestoredTabs(saved, {
      preferredRepo: preferredRepoRef.current,
      defaultTab,
      createDefaultChatTab,
    }, cancelled);
    if (!result) return false;

    tabsRef.current = result.tabs;
    setTabs(result.tabs);
    setActiveTabIdFromRestore(result.activeTabId, capturedNavVersion);
    if (cancelled?.()) return false;

    if (termWsConnectedRef.current) {
      initialTerminalBootstrapRef.current = true;
      for (const sessionName of result.sessionsToAttach) {
        sendTerminalAttach(sessionName, 120, 30);
      }
      for (const deadTab of result.deadTerminalTabs) {
        if (cancelled?.()) return false;
        const restoreCommand = deadTab.repo?.localPath ? `cd ${shellQuote(deadTab.repo.localPath)}` : undefined;
        requestTerminalForTab(deadTab.id, restoreCommand);
      }
    } else {
      initialTerminalBootstrapRef.current = false;
    }
    return result.restoredAny;
  }, [createDefaultChatTab, defaultTab, requestTerminalForTab, sendTerminalAttach]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    restoreInFlightRef.current = true;
    let cancelled = false;

    // #717 — one-time, no-op-if-already-clean scrub of any localStorage values
    // shaped like `{ tabs: [...] }` BEFORE we call the API. There's no current
    // localStorage tab cache, but the user's #717 audit showed pre-fix zombies
    // surviving WebKit wipes; this is the future-proof guarantee that any
    // localStorage-backed persist middleware added later inherits the strip
    // without rediscovering #717.
    scrubLocalStorageTabZombies();

    urlDetectionEnabledRef.current = false;
    const timer = window.setTimeout(() => {
      urlDetectionEnabledRef.current = true;
    }, 5000);

    const currentPreferredRepoPath = preferredRepoRef.current?.localPath ?? null;
    const currentRestoreKey = restoreKeyRef.current ?? `${stateScope}::${defaultTab}::${splitCreated ? 'split' : 'shared'}::${currentPreferredRepoPath ?? 'no-repo'}`;

    void (async () => {
      try {
        const saved = await loadInitialTabState(
          { stateScope, defaultTab, splitCreated, preferredRepoPath: currentPreferredRepoPath },
          () => cancelled,
        );
        if (cancelled) return;

        if (saved) {
          await applyPersistedState(saved, () => cancelled);
          if (cancelled) return;
        } else if (autoCreateDefaultTab) {
          if (defaultTab === 'llm-chat') {
            const defaultTabs = createDefaultChatTabSet();
            tabsRef.current = defaultTabs;
            setTabs(defaultTabs);
            // Activate the Orchestrator tab first — it's index 0 in the set.
            setActiveTabId(defaultTabs[0].id);
          } else {
            const defaultShell = createDefaultShellTab();
            tabsRef.current = [defaultShell];
            setTabs([defaultShell]);
            setActiveTabId(defaultShell.id);
            if (termWsConnectedRef.current) {
              initialTerminalBootstrapRef.current = true;
              requestTerminalForTab(defaultShell.id);
            }
          }
        } else {
          tabsRef.current = [];
          setTabs([]);
          setActiveTabId('');
        }
        restoreInFlightRef.current = false;
        restoreSettledRef.current = true;
        setRestoreCompletedKey(currentRestoreKey);
      } catch {
        restoreInFlightRef.current = false;
        if (cancelled) return;
        restoreSettledRef.current = true;
        setRestoreCompletedKey(restoreKeyRef.current ?? stateScope);
      }
    })();

    return () => {
      cancelled = true;
      // #1234 — if we're tearing down a restore that never settled, re-arm
      // the one-shot guard so the successor effect run performs the restore
      // instead of bailing at `restoredRef`. Without this, any dep-identity
      // change mid-restore (WS send callbacks, StrictMode's dev double-mount)
      // cancels the only run that would ever flip restoreSettledRef — and the
      // persist effect stays disarmed for the whole session while the UI
      // looks healthy: every tab op after boot silently fails to save.
      if (restoreInFlightRef.current) {
        restoredRef.current = false;
      }
      restoreInFlightRef.current = false;
      window.clearTimeout(timer);
    };
    // `restoreKey` is a dep so a preferredRepo change re-runs this effect:
    // the restore-key effect above resets/preserves the controller refs but
    // cannot itself restore — without this dep, a non-preserve key change
    // cleared the tabs and left restoredRef=false with nothing to re-trigger
    // the restore (the second half of #1234).
  }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createDefaultChatTabSet, createDefaultShellTab, defaultTab, requestTerminalForTab, restoreKey, splitCreated, stateScope]);

  useEffect(() => {
    if (!termWsConnected || !restoreSettledRef.current || initialTerminalBootstrapRef.current) return;
    initialTerminalBootstrapRef.current = true;
    for (const tab of tabsRef.current) {
      if (tab.kind !== 'terminal') continue;
      if (tab.tmuxSession) {
        sendTerminalAttach(tab.tmuxSession, 120, 30);
        continue;
      }
      const restoreCommand = tab.repo?.localPath ? `cd ${shellQuote(tab.repo.localPath)}` : undefined;
      requestTerminalForTab(tab.id, restoreCommand);
    }
  }, [requestTerminalForTab, sendTerminalAttach, termWsConnected]);

  useEffect(() => {
    if (tabs.length > 0 || !termWsConnected || splitCreated || !primaryRestoreSettled) return;
    const timer = window.setTimeout(() => {
      // Capture the user-nav version at the point where this fallback
      // restore is scheduled. If the user clicks a tab between the timer
      // firing and the async load resolving, we drop the late activeTabId
      // assignment so the user's click stays sticky. Phase 4 friction #4.
      const capturedNavVersion = userNavVersionRef.current;
      void (async () => {
        if (stableRepoScope && preferredRepo?.localPath) {
          const saved = await loadTabState(stableRepoScope, preferredRepo.localPath);
          if (saved && saved.tabs.length > 0) {
            const restored = await applyPersistedState(saved);
            if (restored) return;
          }
        }
        if (!autoCreateDefaultTab) {
          tabsRef.current = [];
          setTabs([]);
          setActiveTabIdFromRestore('', capturedNavVersion);
          return;
        }
        if (defaultTab === 'llm-chat') {
          const defaultTabs = createDefaultChatTabSet();
          tabsRef.current = defaultTabs;
          setTabs(defaultTabs);
          setActiveTabIdFromRestore(defaultTabs[0].id, capturedNavVersion);
          return;
        }
        const fallbackShell = createDefaultShellTab();
        tabsRef.current = [fallbackShell];
        setTabs([fallbackShell]);
        setActiveTabIdFromRestore(fallbackShell.id, capturedNavVersion);
        if (termWsConnected) {
          requestTerminalForTab(fallbackShell.id);
        }
      })();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createDefaultChatTabSet, createDefaultShellTab, defaultTab, preferredRepo?.localPath, primaryRestoreSettled, requestTerminalForTab, setActiveTabIdFromRestore, splitCreated, stableRepoScope, tabs.length, termWsConnected]);

  useEffect(() => {
    if (tabs.length > 0 || defaultTab !== 'llm-chat') return;
    const timer = window.setTimeout(() => {
      if (tabsRef.current.length > 0) return;
      const fallbacks = createDefaultChatTabSet();
      tabsRef.current = fallbacks;
      setTabs(fallbacks);
      setActiveTabId(fallbacks[0].id);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [createDefaultChatTabSet, defaultTab, tabs.length]);

  useEffect(() => {
    const wasConnected = previousWsConnectedRef.current;
    previousWsConnectedRef.current = termWsConnected;
    if (!termWsConnected || !wasConnected || !restoredRef.current) return;
    for (const tab of tabsRef.current) {
      if (tab.kind === 'terminal' && tab.tmuxSession) {
        sendTerminalAttach(tab.tmuxSession, 120, 30);
      }
    }
  }, [sendTerminalAttach, termWsConnected]);

  // Migration: if restored state is missing an Orchestrator tab, inject one
  // at the front. Ensures existing users get the new tab automatically and
  // don't have to manually add it.
  //
  // Issue #714 — this effect MUST be idempotent against any remount (theme
  // switch, HMR, parent re-render that unmounts TileContainer, etc.). The
  // contract: never produce a duplicate orchestrator. Two layers of dedup:
  //   1. State-side: bail if `tabs` already has an orchestrator-kind tab.
  //   2. Ref-side: also bail if `tabsRef.current` has one. Covers the window
  //      where another setTabs has scheduled an update we haven't rendered.
  // Setting via the functional updater form gives us a third guard against
  // batched / out-of-order state writes that could otherwise stack two
  // injectors onto the same base.
  useEffect(() => {
    if (defaultTab !== 'llm-chat') return;
    if (tabs.length === 0) return;
    if (tabs.some((tab) => tab.kind === 'orchestrator')) return;
    if (tabsRef.current.some((tab) => tab.kind === 'orchestrator')) return;
    setTabs((previous) => {
      if (previous.some((tab) => tab.kind === 'orchestrator')) return previous;
      const orchestratorTab = createDefaultOrchestratorTab();
      const nextTabs = [orchestratorTab, ...previous];
      tabsRef.current = nextTabs;
      return nextTabs;
    });
    // Don't steal focus from whatever the user was on — just inject the tab.
  }, [createDefaultOrchestratorTab, defaultTab, tabs]);

  const handleSessionCreated = useCallback((sessionName: string, requestId?: string) => {
    const directTabId = requestId ? pendingRequestRef.current.get(requestId) : undefined;
    if (requestId && !directTabId) {
      // The tab was closed before this session arrived — detach the orphan.
      if (requestId) sendTerminalDetach(sessionName);
      return false;
    }
    if (requestId) pendingRequestRef.current.delete(requestId);
    if (directTabId) pendingSessionsRef.current.delete(directTabId);

    let claimed = false;
    setTabs((previous) => {
      const pendingIndex = directTabId
        ? previous.findIndex((tab) => tab.id === directTabId && tab.kind === 'terminal' && tab.tmuxSession === null)
        : previous.findIndex((tab) => tab.kind === 'terminal' && tab.tmuxSession === null);
      if (pendingIndex < 0) return previous;
      const updated = [...previous];
      const tab = updated[pendingIndex];
      updated[pendingIndex] = { ...tab, tmuxSession: sessionName };
      claimed = true;
      return updated;
    });
    if (!claimed && requestId && directTabId) {
      sendTerminalDetach(sessionName);
    }
    return claimed;
  }, [sendTerminalDetach]);

  const openWorkspaceCliChatSession = useCallback((options: Parameters<TerminalTabHandle['openCliChatSession']>[0]) => {
    const result = computeCliChatSession(options, tabsRef.current, activeTabId);
    tabsRef.current = result.tabs;
    setTabs(result.tabs);
    setActiveTabIdFromUser(result.activeTabId);
    if (result.needsPersist) persistTabsNow(result.tabs, result.activeTabId);
    return result.activeTabId;
  }, [activeTabId, persistTabsNow, setActiveTabIdFromUser]);

  const openWorkspaceLlmChatSession = useCallback((options: {
    repo?: RegisteredRepo;
    initialText?: string;
    draftReason?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
  }) => {
    const result = computeLlmChatSession(options, tabsRef.current, activeTabId);
    if (result.updatedTabId) {
      const injection = buildLlmInjection(options);
      const nextTabs = tabsRef.current.map((tab) => (
        tab.id === result.updatedTabId ? { ...tab, label: options.label ?? tab.label, llmDraftInjection: injection ?? tab.llmDraftInjection } : tab
      ));
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    } else if (result.newTab) {
      const nextTabs = [result.newTab, ...tabsRef.current];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    }
    setActiveTabIdFromUser(result.activeTabId);
    return result.activeTabId;
  }, [activeTabId, setActiveTabIdFromUser]);

  const openWorkspaceInspectorTab = useCallback((canvasTab: NonNullable<TerminalTab['canvasTab']>, options?: { repo?: RegisteredRepo; createNew?: boolean }) => {
    const result = computeInspectorTab(canvasTab, tabsRef.current, options);
    if (result.updatedTabId) {
      setTabs((previous) => previous.map((tab) => (
        tab.id === result.updatedTabId
          ? { ...tab, label: canvasTab.label, canvasTab, repo: options?.repo ?? tab.repo, lastActivity: Date.now() }
          : tab
      )));
    } else if (result.newTab) {
      setTabs((previous) => [result.newTab!, ...previous]);
    }
    if (result.activeTabId !== null) {
      setActiveTabIdFromUser(result.activeTabId);
    }
    return result.updatedTabId ?? result.newTab?.id ?? '';
  }, [setActiveTabIdFromUser]);

  const handleOpenWorkspaceCommitTab = useCallback((hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => {
    const { canvasTab, repo: resolvedRepo } = buildCommitCanvasTab(hash, meta, repo);
    openWorkspaceInspectorTab(canvasTab, { repo: resolvedRepo });
  }, [openWorkspaceInspectorTab]);

  const handleCloseTabRef = useRef<(tabId: string) => void>(() => undefined);

  const openWorkspaceTerminalTab = useCallback((agentId: string, repo?: RegisteredRepo): string => {
    // Pass the current tabs so `Terminal N` numbering picks the next free slot.
    const result = computeNewTerminalTab(agentId, repo, tabsRef.current);
    if (!result.newTab) return '';
    if (result.cliCommand) {
      pendingCliCommands.current.set(result.newTab.id, result.cliCommand);
    }
    const nextTabs = [result.newTab, ...tabsRef.current];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(result.activeTabId);
    requestTerminalForTab(result.newTab.id, result.cliCommand ?? undefined);
    return result.activeTabId;
  }, [requestTerminalForTab, setActiveTabIdFromUser]);

  useImperativeHandle(ref, () => buildTerminalTabHandle({
    tabsRef,
    panelRefs,
    detectedPortsRef,
    urlDetectionEnabledRef,
    restoreSettledRef,
    pendingRequestRef,
    activeTabId,
    stateScope,
    preferredRepo,
    setTabs,
    setPreviews,
    // External callers via the imperative handle are user-driven (e.g.
    // the dashboard wiring an "open this tab" gesture) — bump the
    // user-nav version so a concurrently-running restore doesn't yank
    // the tab back. Phase 4 friction fix #4.
    setActiveTabId: setActiveTabIdFromUser,
    onPreviewDetected,
    onOpenRepoDiff,
    handleSessionCreated,
    openWorkspaceCliChatSession,
    openWorkspaceLlmChatSession,
    openWorkspaceOrchestratorTab: spawnOrchestratorTab,
    openWorkspaceTerminalTab,
    openWorkspaceInspectorTab,
    persistTabsNow,
    sendTerminalDetach,
    closeTabById: (tabId: string) => handleCloseTabRef.current(tabId),
  }), [activeTabId, handleSessionCreated, onOpenRepoDiff, onPreviewDetected, openWorkspaceCliChatSession, openWorkspaceInspectorTab, openWorkspaceLlmChatSession, openWorkspaceTerminalTab, persistTabsNow, preferredRepo, sendTerminalDetach, setActiveTabIdFromUser, spawnOrchestratorTab, stateScope]);

  const handleRegisterRepo = useCallback((localPath: string) => {
    fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', localPath }),
    }).catch(() => undefined);
  }, []);

  const handleNewTab = useCallback((agentId: string, repo?: RegisteredRepo) => {
    openWorkspaceTerminalTab(agentId, repo);
  }, [openWorkspaceTerminalTab]);

  const handleNewChatTab = useCallback((runtime: Exclude<WorkspaceChatRuntime, 'chat'>, repo?: RegisteredRepo) => {
    const newTab = buildNewChatTab(runtime, repo);
    setTabs((previous) => [newTab, ...previous]);
    setActiveTabIdFromUser(newTab.id);
  }, [setActiveTabIdFromUser]);

  const handleNewLLMChatTab = useCallback((repo?: RegisteredRepo) => {
    const newTab = buildNewLlmChatTab(repo ?? preferredRepo ?? undefined);
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    persistTabsNow(nextTabs, newTab.id);
    setActiveTabIdFromUser(newTab.id);
  }, [persistTabsNow, preferredRepo, setActiveTabIdFromUser]);

  const handleUpdateChatMessages = useCallback((tabId: string, messages: MobileTranscriptEntry[]) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeUpdatedChatMessages(tab, messages) : tab
    )));
  }, []);

  const handleUpdateLlmSummary = useCallback((tabId: string, summary: string | null) => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.id !== tabId || tab.llmSummary === summary) return tab;
        changed = true;
        return { ...tab, llmSummary: summary };
      });
      return changed ? next : prev;
    });
  }, []);

  const handleUpdateChatSessionKey = useCallback((tabId: string, sessionKey: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeUpdatedChatSessionKey(tab, sessionKey) : tab
    )));
  }, []);

  const handleUpdateChatModel = useCallback((tabId: string, modelId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? { ...tab, chatModel: modelId } : tab
    )));
  }, []);

  const handleUpdateLinkedIssue = useCallback((tabId: string, linkedIssue: TerminalTab['linkedIssue']) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? { ...tab, linkedIssue } : tab
    )));
  }, []);

  // Operator-initiated rename — keeps the workspace tab's label in
  // sync with a chat-history PATCH so the header strip reflects the
  // new title without waiting for a remount.
  const handleUpdateTabLabel = useCallback((
    tabId: string,
    label: string,
    options?: { threadId?: string | null; source?: 'auto' | 'user' },
  ) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    setTabs((previous) => {
      let changed = false;
      const next = previous.map((tab) => {
        if (tab.id !== tabId) return tab;
        if (
          options?.threadId
          && tab.kind === 'orchestrator'
          && tab.orchestratorThreadId
          && tab.orchestratorThreadId !== options.threadId
        ) {
          return tab;
        }
        if (options?.source !== 'user' && tab.labelSource === 'user') return tab;
        const labelSource = options?.source === 'user' ? 'user' as const : tab.labelSource;
        if (tab.label === nextLabel && tab.labelSource === labelSource) return tab;
        changed = true;
        return { ...tab, label: nextLabel, labelSource };
      });
      if (changed) tabsRef.current = next;
      return changed ? next : previous;
    });
  }, []);

  const handleSaveCheckpoint = useCallback((tabId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeSaveCheckpoint(tab) : tab
    )));
  }, []);

  const handleRestoreLatestCheckpoint = useCallback((tabId: string) => {
    const result = computeCheckpointRestore(tabsRef.current, tabId);
    if (!result.newTab) return;
    setTabs((previous) => [...previous, result.newTab!]);
    setActiveTabIdFromUser(result.activeTabId);
  }, [setActiveTabIdFromUser]);

  const handleConsumeChatDraftInjection = useCallback((tabId: string, injectionId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId && tab.chatDraftInjection?.id === injectionId
        ? { ...tab, chatDraftInjection: undefined }
        : tab
    )));
  }, []);

  const handleConsumeLlmDraftInjection = useCallback((tabId: string, injectionId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId && tab.llmDraftInjection?.id === injectionId
        ? { ...tab, llmDraftInjection: undefined }
        : tab
    )));
  }, []);

  const handleRunCommandInTerminal = useCallback((command: string) => {
    const target = resolveRunCommandTarget(tabs);
    if (target.kind === 'existing-shell') {
      sendTerminalInput(target.tmuxSession!, command + '\n');
    } else if (target.kind === 'pending-shell') {
      pendingCliCommands.current.set(target.pendingTabId!, command);
      setActiveTabIdFromUser(target.pendingTabId!);
    } else {
      setTabs((previous) => [...previous, target.newTab!]);
      setActiveTabIdFromUser(target.newTab!.id);
      requestTerminalForTab(target.newTab!.id, command);
    }
  }, [requestTerminalForTab, sendTerminalInput, setActiveTabIdFromUser, tabs]);

  const {
    archiveWorkspaceTab,
    cleanupFinishedTabs,
    finishedTabCount,
    handleCloseTab,
    undoCleanup,
  } = useWorkspaceTabCleanup({
    activeTabId,
    detectedPortsRef,
    effectiveActiveTabId,
    panelRefs,
    pendingCliCommands,
    pendingRequestRef,
    pendingSessionsRef,
    sendTerminalDetach,
    setActiveTabIdFromUser,
    setPreviews,
    setTabs,
    tabs,
    tabsRef,
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- mutable handler ref backs imperative/event close bridges.
    handleCloseTabRef.current = handleCloseTab;
  }, [handleCloseTab]);

  useEffect(() => {
    const timers = new Map<string, number>();
    const now = Date.now();
    for (const tab of tabs) {
      if (tab.id === effectiveActiveTabId || !isAutoArchiveEligible(tab)) continue;
      const delayMs = Math.max(0, ORCHESTRATED_TAB_AUTO_ARCHIVE_MS - Math.max(0, now - tab.lastActivity));
      timers.set(tab.id, window.setTimeout(() => {
        archiveWorkspaceTab(tab.id, tab.orchestrationPacket?.packetId ?? null);
      }, delayMs));
    }
    return () => { timers.forEach((id) => window.clearTimeout(id)); };
  }, [archiveWorkspaceTab, effectiveActiveTabId, tabs]);

  useEffect(() => {
    flushPendingCliCommands(tabs, pendingCliCommands.current, sendTerminalInput);
  }, [sendTerminalInput, tabs]);

  const handleDragStart = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    startPreviewDrag(containerDivRef.current, setPreviewHeight, setIsDragging);
  }, []);

  useEffect(() => {
    onActiveLaneChange?.(activeLaneState);
  }, [activeLaneState, onActiveLaneChange]);

  useEffect(() => {
    if (!containerDivRef.current) return undefined;
    return observeXtermHelperNames(containerDivRef.current, stateScope);
  }, [stateScope]);

  useEffect(() => {
    const nextRepoScope = activeRepo?.localPath ?? preferredRepo?.localPath ?? null;
    if (reportedRepoScopeRef.current === nextRepoScope) return;
    reportedRepoScopeRef.current = nextRepoScope;
    onRepoScopeChange?.(nextRepoScope);
  }, [activeRepo?.localPath, onRepoScopeChange, preferredRepo?.localPath]);

  useEffect(() => {
    onActiveRepoContextChange?.(activeRepoContext);
  }, [activeRepoContext, onActiveRepoContextChange]);

  const handleReorderTabs = useCallback((draggedId: string, dropTargetId: string) => {
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === draggedId);
      const toIdx = prev.findIndex((t) => t.id === dropTargetId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      tabsRef.current = next;
      return next;
    });
  }, []);

  const handleSelectTab = useCallback((id: string) => {
    setActiveTabIdFromUser(id);
    setTabs((previous) => previous.map((tab) => (
      tab.id === id && tab.unseen ? { ...tab, unseen: false } : tab
    )));
  }, [setActiveTabIdFromUser]);

  const handleClosePreview = useCallback((id: string) => {
    setPreviews((previous) => {
      const removed = previous.find((preview) => preview.id === id);
      if (removed) {
        detectedPortsRef.current.delete(removed.port);
      }
      return previous.filter((preview) => preview.id !== id);
    });
  }, []);

  const handleOpenHistoryChat = useCallback((
    currentTab: TerminalTab,
    historyTabId: string,
    title: string,
    historyRepo?: { name?: string; localPath?: string; branch?: string | null; remoteUrl?: string | null } | null,
  ) => {
    const newTab = buildHistoryChatTab(currentTab, historyTabId, title, historyRepo);
    const previous = tabsRef.current;
    const nextTabs = previous.some((tab) => tab.id === historyTabId)
      ? previous.map((tab) => (
          tab.id === historyTabId
            ? { ...tab, label: title, repo: newTab.repo ?? tab.repo }
            : tab
        ))
      : [...previous, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(historyTabId);
    persistTabsNow(nextTabs, historyTabId);
  }, [persistTabsNow, setActiveTabIdFromUser]);

  return {
    activeCheckpoint,
    activeRepo,
    activeTab,
    containerDivRef,
    effectiveActiveTabId,
    cleanupFinishedTabs,
    finishedTabCount,
    handleClosePreview,
    handleCloseTab,
    handleConsumeChatDraftInjection,
    handleConsumeLlmDraftInjection,
    handleDragStart,
    handleNewChatTab,
    handleNewLLMChatTab,
    handleNewTab,
    handleOpenHistoryChat,
    handleReorderTabs,
    handleOpenWorkspaceCommitTab,
    handleRegisterRepo,
    handleRestoreLatestCheckpoint,
    handleRunCommandInTerminal,
    handleSaveCheckpoint,
    handleSelectTab,
    handleUpdateChatMessages,
    handleUpdateChatModel,
    handleUpdateChatSessionKey,
    handleUpdateLinkedIssue,
    handleUpdateLlmSummary,
    handleUpdateTabLabel,
    isDragging,
    launchRequestKey,
    panelRefs,
    previews,
    previewHeight,
    primaryRestoreSettled,
    restoreSettledRef,
    setLaunchRequestKey,
    spawnSingleRuntimeTab,
    spawnChatTab,
    spawnOrchestratorTab,
    spawnFleetCanvasTab,
    handleUpdateTabMode,
    undoCleanup,
    tabs,
    termWsConnected,
    visibleTabs,
  };
}
