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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLaneArchivedView } from '@/app/dashboard/hooks/useLaneArchivedSet';
import { ComparisonPicker } from '@/components/desktop/ComparisonPicker';
import { useComparisonGroups } from '@/components/desktop/comparison/useComparisonGroups';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import { loadOrchestratorMissionState } from '@/lib/orchestrator/store';
import { stableOrchestratorThreadTitleForId } from '@/lib/orchestrator/thread-title';
import { outsideWorkerSessionKeysForSettledPackets } from '@/lib/orchestrator/outside-worker-split';
import type { OrchestrationMode, OrchestratorRuntime } from '@/lib/orchestrator/types';
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
  type WorktreeMode,
  type OrchestratorEmptyKind,
} from '@/components/desktop/OrchestratorEmptyState';
import { WorkspaceBootLoaderClaim } from '@/components/desktop/workspace-terminal/workspace-boot-loader-claim';
import { ContextMeter } from '@/components/desktop/orchestrator/ContextMeter';
import { OrchestratorRunStrip } from '@/components/desktop/orchestrator/OrchestratorRunStrip';
import { OrchestratorPromptControls } from '@/components/desktop/orchestrator/OrchestratorPromptControls';
import { OrchestratorContextResidencyProvider } from '@/components/desktop/orchestrator/context-residency';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { BranchDetailsLauncher } from '@/components/desktop/BranchDetailsLauncher';
import { COLLAPSED_BRANCH_RAIL_WIDTH } from '@/components/desktop/branch-rail-geometry';
import { ThoughtsChatPanel, type ThoughtsChatPanelChromeState, type ThoughtsChatPanelHandle } from '@/components/desktop/thoughts/ThoughtsChatPanel';
import { ORCHESTRATOR_TOKEN_EVENT, type OrchestratorTokenUsageDetail } from '@/components/desktop/thoughts/useOrchestratorStream';
import { ORCHESTRATOR_HOME_REPO_SENTINEL, resolveOrchestratorClientRepoPath } from '@/components/desktop/thoughts/orchestrator-home-mode';
import { buildAgentTargets } from '@/components/desktop/thoughts/utils';
import { SessionPillContextMenu } from '@/components/desktop/SessionPillContextMenu';
import { SessionTileSurface, projectLiveSessionMeshParticipants } from './SessionTileSurface';
import { ThreadDropLayer, type ThreadDropAction } from './ThreadDropLayer';
import { useSessionTiles, buildPillContextMenuItems } from './use-session-tiles';
import { HISTORY_NAVIGATION_SUPERSEDED_EVENT, publishWorkspaceThreadBinding, WORKSPACE_THREAD_ID_EVENT } from './utils';
import type { OrchestratorTurnInjection } from './types';
import { useOrchestratorTurnInjection } from './use-orchestrator-turn-injection';
// Issue #663: SessionTileSurface replaces the legacy flat AgentTileLayout
// row. The old layout component is no longer imported here.

interface OrchestratorTabProps {
  tabId: string;
  workspaceId?: string;
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
  /** True when `initialThreadId` is a PERSISTED binding being restored across a
   *  reload (the tab record carried an orchestratorThreadId) — gates the boot
   *  loader over the history load so the empty greeting never flashes before
   *  the conversation lands (Q video, 0.1.604). Fresh spawns leave it false. */
  restoringPersistedThread?: boolean;
  /** Disable broadcasting workspace-thread id changes from isolated mounts. */
  publishWorkspaceThread?: boolean;
  /** Disable updating the global last-active orchestrator thread. */
  persistLastThread?: boolean; suppressRuntimePrewarm?: boolean;
  turnInjection?: OrchestratorTurnInjection;
}
function swarmStorageKey(tabId: string): string {
  return `cortex-ide:orchestrator-swarm:tab:${tabId}`;
}

// One-shot claim on the global "last-active orchestrator thread" pointer.
//
// Plain orchestrator tabs carry an `orchestrator-…` id (no explicit
// initialThreadId), so their ONLY signal for "should I adopt the global
// last-active thread?" is the per-tab `freshSpawn` flag. That flag is
// in-memory only and gets dropped whenever a tab object is reconstructed
// (rename, mode switch, title-sync) — at which point EVERY such tab reads the
// same `o8:last-orchestrator-thread-id` and they all collapse onto one
// conversation (the duplicate-orchestrator-tab bug). The robust guard lives
// here, not on the tab: only the FIRST orchestrator tab to mount + activate
// per app load may adopt the global thread; every later tab stays fresh.
// Resets on a full reload (module re-eval), so the default tab still restores
// your last conversation on boot.
let globalLastThreadRestoreClaimed = false;
// Tab ids that have already mounted once this app load. The persisted-thread
// boot loader (restoringPersistedThread) must only cover the FIRST mount — a
// mid-session remount (drag-to-split restructure, pane moves) would otherwise
// flash the full-screen loader over an already-loaded conversation. Resets on
// reload (module re-eval), which is exactly the boot case it should cover.
const tabIdsMountedThisLoad = new Set<string>();

// Persistence helpers for the cross-reload thread restore live in a
// shared module so the workspace controller can read the same values
// at tab-creation time (pre-set tab.label) without re-implementing.

function readStoredSwarm(tabId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(swarmStorageKey(tabId)) === '1';
  } catch {
    return false;
  }
}

function persistSwarm(tabId: string, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(swarmStorageKey(tabId), enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

function collideStorageKey(tabId: string): string {
  return `cortex-ide:orchestrator-collide:tab:${tabId}`;
}

function readStoredCollide(tabId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(collideStorageKey(tabId)) === '1';
  } catch {
    return false;
  }
}

function persistCollide(tabId: string, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(collideStorageKey(tabId), enabled ? '1' : '0');
  } catch {
    // ignore
  }
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
  workspaceId,
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
  restoringPersistedThread = false,
  publishWorkspaceThread = true,
  persistLastThread = true, suppressRuntimePrewarm = false,
  turnInjection,
}: OrchestratorTabProps) {
  const data = useOrchestratorData();
  const homeAwareRepoPath = resolveOrchestratorClientRepoPath(repoPath);
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
  // Branch-details rail reveal (Q 2026-07-14): the rail is always the collapsed
  // icon capsule in layout; the full card stack floats as a hover overlay. In
  // the new model `collapsed` is the PIN state — `true` = hover-only reveal
  // (the default: the operator wants "just hover"), `false` = pinned open
  // persistently. Persists across reloads; unset defaults to hover-only.
  const [branchRailCollapsed, setBranchRailCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('o8:branch-rail:collapsed') !== '0';
  });
  const toggleBranchRailCollapsed = useCallback(() => {
    setBranchRailCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('o8:branch-rail:collapsed', next ? '1' : '0');
      }
      return next;
    });
  }, []);
  // Fusion / swarm tier (per-tab). Picking "Fusion" in the composer's
  // thinking dropdown flips this on; the orchestrator then fans work out to a
  // parallel crew — native Claude sub-agents + Codex workers via o8.
  const [swarmEnabled, setSwarmEnabled] = useState<boolean>(
    () => readStoredSwarm(tabId),
  );
  // Collide (MoA) tier (per-tab). Claude + Codex propose independently, Claude
  // synthesizes + does the work. Mutually exclusive with swarm.
  const [collideEnabled, setCollideEnabled] = useState<boolean>(
    () => readStoredCollide(tabId),
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
  const [paletteDraft, setPaletteDraft] = useState<{ id: string; text: string } | null>(null);
  const chatPanelRef = useRef<ThoughtsChatPanelHandle>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const loadedThreadIdRef = useRef<string | null>(null);
  const handleChromeChange = useCallback((state: ThoughtsChatPanelChromeState) => {
    loadedThreadIdRef.current = state.threadId;
    setChatChromeState(state);
  }, []);
  useOrchestratorTurnInjection(chatPanelRef, turnInjection, initialThreadId, chatChromeState.threadId, chatChromeState.waitingForReply);
  const loadedInitialThreadRef = useRef<string | null>(null);
  const autoTiledComparisonGroupIdRef = useRef<string | null>(null);

  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('o8:orchestrator', {
      detail: { tabId, busy: active && chatChromeState.waitingForReply },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent('o8:orchestrator', {
        detail: { tabId, busy: false },
      }));
    };
  }, [active, chatChromeState.waitingForReply, tabId]);

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
    window.dispatchEvent(new CustomEvent(WORKSPACE_THREAD_ID_EVENT, {
      detail: { tabId, threadId: chatChromeState.threadId },
    }));
  }, [active, publishWorkspaceThread, tabId, chatChromeState.threadId]);

  // #1554 root — stamp the tab⇄thread binding the moment the panel's thread
  // id lands, regardless of tab activity. The menu bridge above is rightly
  // active-gated (only the focused tab may drive the rename/share target),
  // but the controller's blank-spawn reuse gate needs the binding even when
  // the operator sent a turn and switched tabs before the chrome state
  // flushed — that un-stamped used tab is exactly what "+ New session"
  // refocused, resurrecting the old conversation (and its stale
  // mission-complete card, #1566). The controller's duplicate-owner dedupe
  // handles the two-tabs-one-thread case as before.
  useEffect(() => {
    if (!publishWorkspaceThread) return;
    const threadId = chatChromeState.threadId;
    if (!threadId) return;
    publishWorkspaceThreadBinding(tabId, threadId);
  }, [publishWorkspaceThread, tabId, chatChromeState.threadId]);

  // If the conversation this tab is showing gets deleted from the left rail
  // (ChatsTab → DELETE /api/v2/chat-history), the row vanishes on the left but
  // the center tab kept rendering the now-dead transcript ("gone on the agent
  // panel on left but still in the workspace not ready for a new chat", operator
  // reports v0.1.557/560/580). Reset THIS tab to the fresh new-chat empty state
  // instead. Matches the loaded thread by its live chat-history id, so it covers
  // orchestrator AND llm-chat tabs (both render through this component). The
  // restore-key cleanup lives at the delete site so a reload can't resurrect it.
  const loadedThreadId = chatChromeState.threadId;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: Event) => {
      const deletedTabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
      if (!deletedTabId || !loadedThreadId) return;
      if (deletedTabId !== loadedThreadId) return;
      chatPanelRef.current?.reset();
    };
    window.addEventListener('o8:chat-history-deleted', handler as EventListener);
    return () => window.removeEventListener('o8:chat-history-deleted', handler as EventListener);
  }, [loadedThreadId]);

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
    const sync = async () => {
      try {
        const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`);
        if (cancelled) return;
        const data = res.ok ? await res.json() : null;
        // Match the /list endpoint's title resolution: data.title wins.
        // Untitled orchestrator threads use a stable generated label, never
        // the latest/raw operator message text; session identity must not flap
        // while the operator is inside it.
        const explicitTitle = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : null;
        const fallbackTitle = lockedMode === 'chat' ? null : stableOrchestratorThreadTitleForId(threadId, data?.savedAt);
        const title = explicitTitle ?? fallbackTitle;
        if (cancelled) return;
        if (title) {
          // Persist the title alongside the threadId so the next reload
          // can pre-set tab.label at tab-creation time (no "Orchestrator"
          // flash before the chat-history fetch completes).
          if (activeRef.current && persistLastThread) writeLastOrchestratorThread(homeAwareRepoPath, threadId, title);
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
    };
    void sync();
    // Auto-titler follow-up (2026-07-13): the server names the thread a few
    // seconds AFTER the post-turn persist. usePersistChatThread fires this
    // event on a delay so the header pill + rail pick up the new name
    // without waiting for a thread switch.
    const onMaybeUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId === threadId) void sync();
    };
    window.addEventListener('o8:thread-title-maybe-updated', onMaybeUpdated as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener('o8:thread-title-maybe-updated', onMaybeUpdated as EventListener);
    };
  }, [persistLastThread, tabId, chatChromeState.threadId, lockedMode, homeAwareRepoPath]);

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
      writeLastOrchestratorThread(homeAwareRepoPath, chatChromeState.threadId);
    }
  }, [active, persistLastThread, chatChromeState.threadId, chatChromeState.hasMessages, homeAwareRepoPath]);

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
  const [showRestoreLoader, setShowRestoreLoader] = useState(false);
  // True while a loadThread retry loop below is actively nudging the history
  // fetch. The restore hold reads this: while a loop is working, the 3s
  // empty-bail is wrong — it dropped the tab onto the "What should we build"
  // hero for ~12s while the loop kept retrying against a booting server
  // (prod boot recording 2026-07-17), then the transcript popped in over it.
  const [threadLoadPending, setThreadLoadPending] = useState(false);
  const [isRestoringThread, setIsRestoringThread] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    // A persisted thread binding reloading across an app restart is ALSO a
    // restore — without this the tab rendered the empty greeting while the
    // history loaded, so boot read as loader → greeting flash → conversation
    // (Q video, 0.1.604). First mount per app load only (the set guard) so a
    // pane-move remount never re-covers a loaded conversation. The finish
    // effect below resolves it the same way (hasMessages, 3s empty bail).
    if (restoringPersistedThread && initialThreadId && !tabIdsMountedThisLoad.has(tabId)) return true;
    if (!restoreLastThread) return false;
    // Only orchestrator tabs in default mode (no explicit initialThreadId)
    // participate in the restore path.
    if (initialThreadId) return false;
    // Another orchestrator tab already adopted the global last-thread this
    // session — this one stays fresh, so don't flash the restore shimmer.
    if (globalLastThreadRestoreClaimed) return false;
    return Boolean(readLastOrchestratorThreadId(homeAwareRepoPath));
  });
  // Mark AFTER the initializer ran (effects run post-render, and StrictMode's
  // double-invoked initializer both see the unmarked set) — remounts of this
  // tab id skip the persisted-thread boot loader from here on.
  useEffect(() => {
    tabIdsMountedThisLoad.add(tabId);
  }, [tabId]);
  useEffect(() => {
    if (!active) return;
    if (!restoreLastThread) return;
    if (initialThreadId) return; // explicit thread wins
    const restored = readLastOrchestratorThreadId(homeAwareRepoPath);
    if (!restored) return;
    if (restoredThreadRef.current === restored) return; // already loaded
    // At most ONE orchestrator tab per app load adopts the global last-active
    // thread; later tabs stay fresh instead of duplicating it. (A tab that
    // already claimed it is short-circuited by the restoredThreadRef guard
    // above, so this only blocks *other* tabs.)
    if (globalLastThreadRestoreClaimed) return;
    let cancelled = false;
    let mountPolls = 0;
    let loadRetries = 0;
    let timer: number | null = null;
    const tryLoad = () => {
      if (cancelled) return;
      if (restoredThreadRef.current !== restored && globalLastThreadRestoreClaimed) {
        setThreadLoadPending(false); // claimed by another tab mid-wait
        return;
      }
      // Confirmed landed — the panel's chrome reports the restored thread.
      if (loadedThreadIdRef.current === restored) {
        setThreadLoadPending(false);
        return;
      }
      const handle = chatPanelRef.current;
      if (!handle) {
        mountPolls += 1;
        if (mountPolls < 50) timer = window.setTimeout(tryLoad, 100);
        else setThreadLoadPending(false);
        return;
      }
      // Claim on FIRST call (one tab adopts the global last-thread), then keep
      // nudging until the load verifiably lands: loadThread's history fetch
      // fails SILENTLY when a reload races a dev recompile or booting server
      // (2026-07-15 — the tab restored its TITLE over an empty transcript).
      // The panel dedups repeat loads, so re-asking is safe.
      if (restoredThreadRef.current !== restored) {
        restoredThreadRef.current = restored;
        globalLastThreadRestoreClaimed = true;
        // Stamp the restore INTENT onto the tab record NOW — not only after
        // the history load lands (the chrome-driven publish effect above).
        // If the load fails silently (server boot race — worst on slow
        // Rosetta/Apple Silicon boots), an unstamped tab still matches the
        // blank-spawn reuse gate and every "New session" click reuses the
        // broken tab instead of spawning fresh (report D3YPBP round 2,
        // 2026-07-15). The controller's duplicate-owner dedupe also runs
        // sooner, which is the intended behavior, just earlier.
        if (publishWorkspaceThread) {
          publishWorkspaceThreadBinding(tabId, restored);
        }
      }
      handle.loadThread(restored);
      loadRetries += 1;
      if (loadRetries < 20) timer = window.setTimeout(tryLoad, 1000);
      else setThreadLoadPending(false); // exhausted — fail open to the hero
    };
    setThreadLoadPending(true);
    timer = window.setTimeout(tryLoad, 0);
    return () => {
      cancelled = true;
      setThreadLoadPending(false);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, initialThreadId, restoreLastThread, homeAwareRepoPath, publishWorkspaceThread, tabId]);

  // The restored tab itself paints immediately. Only show a loader if its
  // transcript remains absent long enough to be perceptible, then remove it
  // as soon as history lands (or after the empty-history bail-out).
  useEffect(() => {
    if (!isRestoringThread) return;
    if (chatChromeState.hasMessages) {
      setShowRestoreLoader(false);
      setIsRestoringThread(false);
      return;
    }
    const appearTimer = window.setTimeout(() => setShowRestoreLoader(true), 200);
    // While a loadThread retry loop is actively working, the short empty-bail
    // is wrong — it revealed the "What should we build" hero over a transcript
    // that was still fetching against a booting server, then the conversation
    // popped in over it ~12s later (prod boot recording 2026-07-17). Hold with
    // a long fail-open while the loop works; the loop clearing
    // threadLoadPending (landed, exhausted, or superseded) re-runs this effect
    // and arms the short bail for the genuinely-empty-thread case.
    const emptyTimer = window.setTimeout(() => {
      setShowRestoreLoader(false);
      setIsRestoringThread(false);
    }, threadLoadPending ? 30000 : 3000);
    return () => {
      window.clearTimeout(appearTimer);
      window.clearTimeout(emptyTimer);
    };
  }, [isRestoringThread, chatChromeState.hasMessages, threadLoadPending]);

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
  const { groups: comparisonGroups, readyGroups: readyComparisonGroups } = useComparisonGroups(data?.missionState);
  const sessionTargets = useMemo(
    () => buildAgentTargets(agents, preferredRuntime),
    [agents, preferredRuntime],
  );
  const laneRetiredSessionKeys = useLaneArchivedView().sessionKeys;
  const retiredSessionKeys = useMemo(() => new Set([
    ...laneRetiredSessionKeys, ...outsideWorkerSessionKeysForSettledPackets(data?.missionState?.packets ?? []),
  ]), [data?.missionState?.packets, laneRetiredSessionKeys]);
  const liveSessionKeys = useMemo(() => agents
    .map((agent) => agent.sessionKey)
    .filter((key): key is string => typeof key === 'string' && !retiredSessionKeys.has(key)), [agents, retiredSessionKeys]);
  const meshParticipants = useMemo(() => projectLiveSessionMeshParticipants(agents, data?.missionState?.packets ?? []), [agents, data?.missionState?.packets]);
  const sessionTiles = useSessionTiles({ tabId, repoPath: homeAwareRepoPath, workspaceId, threadId: chatChromeState.threadId, liveSessionKeys, retiredSessionKeys, participants: meshParticipants, active });
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

  // One thread, one view: whenever the MAIN chat binds a thread (restore,
  // history click, auto-restore), close any thread pane holding the same
  // thread. The drop-time same-thread check reads a chrome snapshot that can
  // lag a mount-time restore (live-hit 2026-07-15: drop landed mid-restore
  // and the same thread ended up with two composers).
  useEffect(() => {
    const tid = chatChromeState.threadId;
    if (!tid) return;
    sessionTiles.pruneThreadPane(tid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatChromeState.threadId, sessionTiles.pruneThreadPane]);
  // Drag-to-split drop actions (Claude Code split-screen parity). Split and
  // replace land in the session tile tree as 'thread' panes; a drop on the
  // main chat's header loads the thread in place instead — the chat leaf
  // never leaves the tree.
  const handleThreadDrop = useCallback((action: ThreadDropAction) => {
    if (action.kind === 'replace-chat') {
      if (chatChromeState.threadId === action.thread.threadId) return;
      window.dispatchEvent(new Event(HISTORY_NAVIGATION_SUPERSEDED_EVENT));
      if (publishWorkspaceThread) {
        publishWorkspaceThreadBinding(tabId, action.thread.threadId);
      }
      chatPanelRef.current?.loadThread(action.thread.threadId);
      return;
    }
    // Dropping the thread the main chat already shows would open the same
    // conversation twice — two live composers on one thread is a trap.
    if (chatChromeState.threadId === action.thread.threadId) return;
    if (action.kind === 'replace') {
      sessionTiles.replaceLeafWithThreadPane(action.leafId, action.thread);
      return;
    }
    sessionTiles.splitLeafWithThreadPane(action.leafId, action.thread, action.direction);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatChromeState.threadId,
    sessionTiles.replaceLeafWithThreadPane,
    sessionTiles.splitLeafWithThreadPane,
    publishWorkspaceThread,
    tabId,
  ]);

  const handleSetSwarm = useCallback((enabled: boolean) => {
    setSwarmEnabled(enabled);
    persistSwarm(tabId, enabled);
    // Swarm and Collide are alternative fusion modes — arming one disarms the other.
    if (enabled) {
      setCollideEnabled(false);
      persistCollide(tabId, false);
    }
  }, [tabId]);

  const handleSetCollide = useCallback((enabled: boolean) => {
    setCollideEnabled(enabled);
    persistCollide(tabId, enabled);
    if (enabled) {
      setSwarmEnabled(false);
      persistSwarm(tabId, false);
    }
  }, [tabId]);

  useEffect(() => {
    if (!active || !initialThreadId) return;
    if (loadedInitialThreadRef.current === initialThreadId) return;
    // Retry until the load verifiably LANDS (the panel's chrome reports the
    // thread), not merely until the imperative handle exists — loadThread's
    // history fetch fails SILENTLY when a reload races a dev recompile or a
    // booting server, and a fire-once loop left the tab wearing the thread's
    // TITLE over an empty transcript (2026-07-15). The panel dedups repeat
    // loads, so nudging once a second until confirmation is safe.
    let cancelled = false;
    let mountPolls = 0;
    let loadRetries = 0;
    let timer: number | null = null;
    const tryLoad = () => {
      if (cancelled) return;
      if (loadedThreadIdRef.current === initialThreadId) {
        loadedInitialThreadRef.current = initialThreadId;
        setThreadLoadPending(false);
        return;
      }
      const handle = chatPanelRef.current;
      if (!handle) {
        mountPolls += 1;
        if (mountPolls < 50) timer = window.setTimeout(tryLoad, 100);
        else setThreadLoadPending(false);
        return;
      }
      console.log(`[orchestrator] loading tab-bound thread ${initialThreadId} (retry ${loadRetries})`);
      handle.loadThread(initialThreadId);
      loadRetries += 1;
      if (loadRetries < 20) timer = window.setTimeout(tryLoad, 1000);
      else setThreadLoadPending(false); // exhausted — fail open to the hero
    };
    setThreadLoadPending(true);
    timer = window.setTimeout(tryLoad, 0);
    return () => {
      cancelled = true;
      setThreadLoadPending(false);
      if (timer !== null) window.clearTimeout(timer);
    };
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
      // Publish the switch INTENT before the load resolves. Otherwise this tab
      // keeps advertising its PREVIOUS thread through the whole load window, and
      // a concurrently-restoring tab that claims the same previous thread sees
      // this tab as the stale owner and closes itself — the thread then has no
      // tab at all (adversarial review 2026-07-15). Advertising the target now
      // makes the controller's owner-dedupe reason about where we're GOING.
      if (publishWorkspaceThread) {
        publishWorkspaceThreadBinding(tabId, detail.historyTabId);
      }
      chatPanelRef.current?.loadThread(detail.historyTabId);
      window.setTimeout(() => chatPanelRef.current?.focusInput(), 40);
    };
    window.addEventListener('o8:load-history-thread', handleLoadHistoryThread);
    return () => window.removeEventListener('o8:load-history-thread', handleLoadHistoryThread);
  }, [acceptHistoryThreadLoads, active, tabId, publishWorkspaceThread]);

  const handleQuickAction = useCallback((prompt: string) => {
    chatPanelRef.current?.sendNow(prompt);
  }, []);

  const handlePaletteDraft = useCallback((text: string, sourceId: string) => {
    setPaletteDraft({ id: `${sourceId}-${Date.now()}`, text });
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

  // Worktree mode for the compose-first empty state. Defaults to 'local'
  // (operator pass 2026-06-14 — "we only work local really"): the
  // orchestrator drives on the current checkout and the Branch chip stays
  // hidden until you explicitly pick "New worktree", which drops the
  // redundant second branch pill vs. the footer status bar. Dispatched
  // agents still get isolated worktrees at spawn time regardless of this.
  // Local-state for v1 — persistence onto the tab is a follow-up once
  // dispatch reads this on first agent spawn.
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>('local');
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
  const effectiveRepoPath = scopeCleared ? ORCHESTRATOR_HOME_REPO_SENTINEL : homeAwareRepoPath;
  const branchLabel = pickedBranch ?? activeWorkspaceTarget?.branch?.trim() ?? 'main';
  // Reset the local override whenever the target repo changes — the
  // chip otherwise sticks to the prior repo's branch name.
  useEffect(() => {
    setPickedBranch(null);
  }, [activeWorkspaceTarget?.localPath]);

  // Broadcast the active orchestrator tab's worktree selection so the
  // bottom DesktopStatusBar pill can reflect the operator's pick (branch +
  // worktree mode) instead of the project's HEAD branch. Fires when this
  // tab is the active workspace tab; clears when it isn't. Dashboard-level
  // listener stores the latest signal and prefers it over project state
  // when assembling the pill's branchName.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!active) return;
    window.dispatchEvent(new CustomEvent('o8:orchestrator-worktree-selection', {
      detail: {
        tabId,
        repoPath: effectiveRepoPath,
        branch: branchLabel,
        worktreeMode,
      },
    }));
  }, [active, tabId, effectiveRepoPath, branchLabel, worktreeMode]);

  // When this orchestrator tab loses focus, emit a clear signal so the
  // dashboard listener drops this tab's override (the next active tab
  // will publish its own). Without this the pill could stick to a
  // worktree chosen in a now-background tab.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (active) return;
    window.dispatchEvent(new CustomEvent('o8:orchestrator-worktree-selection-clear', {
      detail: { tabId },
    }));
  }, [active, tabId]);

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
    // layer, so `scopeCleared` switches the tab to its home anchor.
    setScopeCleared(true);
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:select-workspace-scope', {
      detail: { repoPath: ORCHESTRATOR_HOME_REPO_SENTINEL, repoName: null },
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
        onBranchChange={setPickedBranch}
        kind={emptyKind}
        kindLocked={emptyKindLocked}
        onKindChange={handleEmptyKindChange}
      />
    ),
    [
      greeting,
      runtimeLabel,
      handleQuickAction,
      effectiveRepoPath,
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

  // Restoring claim — swaps in for the "Good morning" empty state while
  // we're loading the restored thread. A CLAIM on the shared boot loader
  // (not a loader of its own) so the panels-level boot loader and this one
  // are the same continuously-mounted overlay — no unmount/remount flash
  // between boot phases (Q video, 0.1.604).
  const restoringShimmerNode = useMemo(
    () => (
      <WorkspaceBootLoaderClaim />
    ),
    [],
  );

  // While a restore is in flight but the loader hasn't earned its 200ms
  // appearance yet, render BLANK — falling through to the empty-state hero
  // flashes the premature "Start a new session" CTA the old 480ms hold
  // existed to prevent (reviewer correction, 2026-07-16). The fragment is
  // deliberate: a null override would fall back to the panel's own default
  // empty state.
  const emptyOrShimmerNode = isRestoringThread
    ? (showRestoreLoader ? restoringShimmerNode : <></>)
    : emptyStateNode;

  // The glass top-glow lives on the TAB ROOT (below), not the chat body:
  // when it sat on the body, the run strip / comparison row above rendered
  // flat chat-surface next to the glow and read as a darker bar on dark
  // glass (Q report 2026-07-14). One gradient over the whole pane keeps
  // every top-of-pane row flush with the transcript.
  const thoughtsBodyBackground = 'transparent';
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

  // Branch-details rail rendered to the RIGHT of the transcript (inside the
  // panel) so the composer spans full width even when the rail is up (Q ruling
  // 2026-07-11). The rail is now a fixed COLLAPSED_BRANCH_RAIL_WIDTH capsule
  // whose expanded card floats as a hover/click overlay (portal), so it never
  // crowds the chat. The old railFits width-fold gate is gone (Q ruling
  // 2026-07-14) — the capsule shows whenever projectContextRailVisible, at any
  // window size.
  const branchRail = (
    <div
      style={{
        // The rail is ALWAYS the collapsed capsule width in layout now — the
        // expanded card stack floats as a hover overlay (portal) instead of
        // widening this flex item, so revealing it never pushes the chat over
        // (git/environment popover, Q ruling 2026-07-14).
        width: projectContextRailVisible ? COLLAPSED_BRANCH_RAIL_WIDTH : 0,
        flexShrink: 0,
        // minHeight:0 keeps this flex item bounded by the row height so the
        // rail's own overflowY:auto can engage — without it the rail sized to
        // its content and the ancestor CLIPPED it with no way to scroll
        // (Q live-hit, short windows, 2026-07-13).
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 240ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <BranchDetailsLauncher
        visible={projectContextRailVisible}
        repoPath={repoPath ?? null}
        threadId={chatChromeState.threadId}
        collapsed={branchRailCollapsed}
        onToggleCollapsed={toggleBranchRailCollapsed}
      />
    </div>
  );

  const thoughtsChatPanel = (
    <ThoughtsChatPanel
      ref={chatPanelRef}
      transcriptSideRail={branchRail}
      open={active}
      // The panel's #1459 crash-recovery auto-restore (adopt the latest thread
      // when it was modified <60s ago) belongs ONLY to the boot-restore tab.
      // On a fresh "+ New session" tab (restoreLastThread=false) or a tab bound
      // to an explicit thread, that recovery adopted the ALREADY-OPEN thread —
      // the controller's one-tab-per-thread dedupe then closed the new tab as a
      // duplicate, which read as "New session does nothing" (GQXEZD saga;
      // live-caught 2026-07-16: fresh tab emitted the old thread id ~450ms
      // after mount, then vanished).
      suppressAutoRestore={!restoreLastThread || Boolean(initialThreadId)} suppressRuntimePrewarm={suppressRuntimePrewarm || meshParticipants.some((participant) => participant.launchContext?.presentation === 'split' && participant.launchContext.source !== 'desktop')}
      // Until a thread-bound tab's history lands, show '…', never the default backend.
      expectsThreadLoad={Boolean(initialThreadId)}
      draftInjection={effectiveDraftInjection}
      imageInjection={data?.imageInjection ?? null}
      onImageInjectionConsumed={data?.onImageInjectionConsumed}
      agents={agents}
      missionState={data.missionState}
      preferredRuntime={preferredRuntime}
      sessionTargets={sessionTargets}
      workspaceTargets={data.workspaceTargets ?? []}
      repoPath={effectiveRepoPath}
      projectId={data.activeProjectId ?? null}
      thoughtsBodyBackground={thoughtsBodyBackground}
      thoughtsElevatedSurface={thoughtsElevatedSurface}
      thoughtsElevatedBorder={thoughtsElevatedBorder}
      thoughtsElevatedShadow={thoughtsElevatedShadow}
      thoughtsMutedGlass={thoughtsMutedGlass}
      swarmEnabled={swarmEnabled}
      onSetSwarm={handleSetSwarm}
      collideEnabled={collideEnabled}
      onSetCollide={handleSetCollide}
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
      onChromeChange={handleChromeChange}
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
        background: 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%), var(--t-chat-surface-bg, #ffffff)',
      }}
    >


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
            background: 'transparent',
          }}
        >
          {readyComparisonGroups.map((group) => (
            <ComparisonPicker
              key={group.groupId}
              groupId={group.groupId}
              packets={group.packets}
              onPickWinner={handlePickComparisonWinner}
              onDismiss={() => handleDismissComparisonGroup(group.groupId)}
              onCompareDiffs={() => data?.onOpenO8Panel?.({ tab: 'compare' })}
            />
          ))}
        </div>
      ) : null}

      {/* Live `o8 run` sessions — click a chip to watch the raw stdout in the
          bottom panel without leaving the chat. Self-hides when none run. */}
      <OrchestratorRunStrip active={active} />

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
          {/* ALWAYS render through the tile surface — even a lone chat leaf.
              The old `isTiled ? surface : panel` ternary moved the chat
              panel between tree positions on every tile/untile flip, which
              REMOUNTED ThoughtsChatPanel: transcript flash + a fresh
              auto-restore pass that could adopt whatever thread was touched
              seconds ago (hit live 2026-07-15 when closing a dragged-in
              thread pane). A single-leaf surface renders the same visual. */}
          <SessionTileSurface
            layout={sessionTiles.layout}
            focusedSessionKey={sessionTiles.focusedSessionKey}
            chatSlot={thoughtsChatPanel}
            repoPath={repoPath ?? null}
            onResizeSplit={sessionTiles.resizeSplit}
            onCloseLeaf={sessionTiles.closeSessionLeafById}
            onFocusSession={sessionTiles.setFocusedSessionKey}
          />
          {/* Drag-to-split drop targets — only paints while a thread drag
              from the left rail is in flight (split-screen parity). */}
          <ThreadDropLayer
            active={active}
            layout={sessionTiles.layout}
            onDrop={handleThreadDrop}
          />
        </div>
        {/* Branch-details rail moved INSIDE the panel (transcriptSideRail) so
            it sits beside the transcript, not the composer — see branchRail. */}
      </div>
      <span style={{ display: 'none' }} aria-hidden data-chrome={chatChromeState.activeTargetLabel} />
      <OrchestratorPromptControls active={active} repoPath={repoPath ?? null} repoName={repoLabel?.trim() || repoPath?.split('/').filter(Boolean).pop() || 'This repo'} onDraft={handlePaletteDraft} />
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
