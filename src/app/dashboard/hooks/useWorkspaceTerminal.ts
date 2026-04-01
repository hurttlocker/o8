import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '@/components/desktop/hooks/useDesktopWebSocket';
import type { TerminalHandle } from '@/components/desktop/LiveOutput';
import type { ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import type { TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import {
  loadOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import type {
  OrchestratorLaneSnapshot,
  OrchestratorPacket,
  WorkspaceLaneState,
} from '@/lib/orchestrator/types';
import type { RealtimeEventEnvelope, RealtimeMutationRecord } from '@/lib/realtime/types';
import {
  findLeafByContentKind,
  findTile,
  getFirstLeaf,
  replaceTileContent,
  splitTile,
} from '@/lib/tiles/operations';
import type { TileContentKind, TileLayout, TileLeafNode } from '@/lib/tiles/types';
import type { WorkspaceScopeEntry } from '../types';
import {
  buildOrchestrationPacketBadge,
  buildWorkspaceChatTargetOptions,
  collectOpenTerminalRepoPaths,
  collectTerminalLeafIds,
  findTerminalLeafByRepoPath,
  findUnscopedTerminalLeaf,
  openedLaneSessionsCache,
  packetStatusFromLaneStatus,
  pathBelongsToRepoScope,
} from '../utils';

interface UseWorkspaceTerminalArgs {
  activeTileId: string | null;
  contextualPanelHandlesRef: MutableRefObject<Map<string, ContextualPanelHandle>>;
  refreshWorkspaceLifecycle: () => Promise<void>;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  setActiveWorkspace: Dispatch<SetStateAction<string | undefined>>;
  setTileLayout: Dispatch<SetStateAction<TileLayout>>;
  thoughtsMissionPackets: OrchestratorPacket[];
  tileLayout: TileLayout;
  workspaceScopeEntries: WorkspaceScopeEntry[];
  workspaceTerminalPreferredRepo: WorkspaceScopeEntry | null;
}

interface WorkspaceTerminalTarget {
  tileId: string;
  handle: TerminalTabHandle;
}

export function useWorkspaceTerminal({
  activeTileId,
  contextualPanelHandlesRef,
  refreshWorkspaceLifecycle,
  setActiveTileId,
  setActiveWorkspace,
  setTileLayout,
  thoughtsMissionPackets,
  tileLayout,
  workspaceScopeEntries,
  workspaceTerminalPreferredRepo,
}: UseWorkspaceTerminalArgs) {
  const [dashTermSession, setDashTermSession] = useState<string | null>(null);
  const termCreatedRef = useRef(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const workspaceTerminalHandlesRef = useRef<Map<string, TerminalTabHandle>>(new Map());
  const pendingWorkspaceTerminalResolversRef = useRef<Map<string, (handle: TerminalTabHandle) => void>>(new Map());
  const [workspaceChatSessionByTileId, setWorkspaceChatSessionByTileId] = useState<Record<string, string | undefined>>({});
  const [workspaceChatSessionsByTileId, setWorkspaceChatSessionsByTileId] = useState<Record<string, MobileInboxSnapshot['sessions']>>({});
  const [workspaceLaneByTileId, setWorkspaceLaneByTileId] = useState<Record<string, WorkspaceLaneState | null>>({});
  const [workspaceTerminalResetNonceByTileId, setWorkspaceTerminalResetNonceByTileId] = useState<Record<string, number>>({});
  const [lifecycleEvents, setLifecycleEvents] = useState<Map<string, { state: string; exitCode?: number; ts: number }>>(new Map());

  const findInsertionTarget = useCallback((preferredKinds: TileContentKind[]): TileLeafNode => {
    const activeTile = activeTileId ? findTile(tileLayout.root, activeTileId) : null;
    if (activeTile?.type === 'leaf' && preferredKinds.includes(activeTile.content.kind)) {
      return activeTile;
    }
    for (const kind of preferredKinds) {
      const matchingLeaf = findLeafByContentKind(tileLayout.root, kind);
      if (matchingLeaf) {
        return matchingLeaf;
      }
    }
    if (activeTile?.type === 'leaf') {
      return activeTile;
    }
    return getFirstLeaf(tileLayout.root);
  }, [activeTileId, tileLayout.root]);

  const findWorkspaceTarget = useCallback((): TileLeafNode | null => {
    const activeTile = activeTileId ? findTile(tileLayout.root, activeTileId) : null;
    if (activeTile?.type === 'leaf' && activeTile.content.kind === 'workspace') {
      return activeTile;
    }
    return findLeafByContentKind(tileLayout.root, 'workspace');
  }, [activeTileId, tileLayout.root]);

  const activeWorkspaceLane = useMemo(() => {
    const openTerminalTileIds = new Set(collectTerminalLeafIds(tileLayout.root));
    if (activeTileId && workspaceLaneByTileId[activeTileId]) {
      return workspaceLaneByTileId[activeTileId];
    }
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (preferredRepoPath) {
      const matchingTerminalLeaf = findTerminalLeafByRepoPath(tileLayout.root, preferredRepoPath);
      if (matchingTerminalLeaf && workspaceLaneByTileId[matchingTerminalLeaf.id]) {
        return workspaceLaneByTileId[matchingTerminalLeaf.id];
      }
    }
    const fallback = Object.entries(workspaceLaneByTileId)
      .find(([tileId, lane]) => openTerminalTileIds.has(tileId) && Boolean(lane))?.[1] ?? null;
    return fallback;
  }, [activeTileId, tileLayout.root, workspaceLaneByTileId, workspaceTerminalPreferredRepo?.localPath]);

  const registerWorkspaceTerminalHandle = useCallback((tileId: string, handle: TerminalTabHandle | null) => {
    if (handle) {
      workspaceTerminalHandlesRef.current.set(tileId, handle);
      const resolver = pendingWorkspaceTerminalResolversRef.current.get(tileId);
      if (resolver) {
        pendingWorkspaceTerminalResolversRef.current.delete(tileId);
        resolver(handle);
      }
      return;
    }
    workspaceTerminalHandlesRef.current.delete(tileId);
    pendingWorkspaceTerminalResolversRef.current.delete(tileId);
  }, []);

  const setTerminalTileRepoScope = useCallback((tileId: string, repoPath: string | null) => {
    setTileLayout((current) => {
      const tile = findTile(current.root, tileId);
      if (tile?.type !== 'leaf' || tile.content.kind !== 'terminal') {
        return current;
      }
      const nextRepoPath = repoPath ?? null;
      if ((tile.content.repoPath ?? null) === nextRepoPath) {
        return current;
      }
      return {
        ...current,
        root: replaceTileContent(current.root, tileId, {
          kind: 'terminal',
          repoPath: nextRepoPath,
        }),
      };
    });
  }, [setTileLayout]);

  const findPreferredWorkspaceTerminalTileId = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const normalizedRepoPath = repoPath ?? null;
    if (preferredTileId) {
      const preferredTile = findTile(tileLayout.root, preferredTileId);
      if (preferredTile?.type === 'leaf' && preferredTile.content.kind === 'terminal') {
        const preferredRepoPath = preferredTile.content.repoPath ?? null;
        if (!normalizedRepoPath || preferredRepoPath === normalizedRepoPath || preferredRepoPath === null) {
          return preferredTileId;
        }
      }
    }

    if (normalizedRepoPath) {
      const matchingLeaf = findTerminalLeafByRepoPath(tileLayout.root, normalizedRepoPath);
      if (matchingLeaf) {
        return matchingLeaf.id;
      }
    }

    if (activeTileId) {
      const activeTile = findTile(tileLayout.root, activeTileId);
      if (activeTile?.type === 'leaf' && activeTile.content.kind === 'terminal') {
        const activeRepoPath = activeTile.content.repoPath ?? null;
        if (!normalizedRepoPath || activeRepoPath === normalizedRepoPath || activeRepoPath === null) {
          return activeTileId;
        }
      }
    }

    if (normalizedRepoPath) {
      const unscopedLeaf = findUnscopedTerminalLeaf(tileLayout.root);
      if (unscopedLeaf) {
        return unscopedLeaf.id;
      }
      return null;
    }

    const firstEntry = workspaceTerminalHandlesRef.current.entries().next().value as [string, TerminalTabHandle] | undefined;
    return firstEntry?.[0] ?? null;
  }, [activeTileId, tileLayout.root]);

  const getPreferredWorkspaceTerminalTarget = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const targetTileId = findPreferredWorkspaceTerminalTileId(repoPath, preferredTileId);
    if (!targetTileId) return null;
    const handle = workspaceTerminalHandlesRef.current.get(targetTileId);
    return handle ? { tileId: targetTileId, handle } : null;
  }, [findPreferredWorkspaceTerminalTileId]);

  const activeWorkspaceChatSessionKey = useMemo(() => {
    const openTerminalTileIds = new Set(collectTerminalLeafIds(tileLayout.root));
    if (activeTileId && workspaceChatSessionByTileId[activeTileId]) {
      return workspaceChatSessionByTileId[activeTileId];
    }
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (preferredRepoPath) {
      const matchingTerminalLeaf = findTerminalLeafByRepoPath(tileLayout.root, preferredRepoPath);
      if (matchingTerminalLeaf && workspaceChatSessionByTileId[matchingTerminalLeaf.id]) {
        return workspaceChatSessionByTileId[matchingTerminalLeaf.id];
      }
    }
    return Object.entries(workspaceChatSessionByTileId)
      .find(([tileId, value]) => openTerminalTileIds.has(tileId) && Boolean(value))?.[1];
  }, [activeTileId, tileLayout.root, workspaceChatSessionByTileId, workspaceTerminalPreferredRepo?.localPath]);

  const workspaceChatSessions = useMemo(() => {
    if (activeTileId && workspaceChatSessionsByTileId[activeTileId]?.length) {
      return workspaceChatSessionsByTileId[activeTileId];
    }
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (preferredRepoPath) {
      const matchingTerminalLeaf = findTerminalLeafByRepoPath(tileLayout.root, preferredRepoPath);
      if (matchingTerminalLeaf && workspaceChatSessionsByTileId[matchingTerminalLeaf.id]?.length) {
        return workspaceChatSessionsByTileId[matchingTerminalLeaf.id];
      }
    }
    return Object.values(workspaceChatSessionsByTileId).find((sessions) => sessions.length > 0) ?? [];
  }, [activeTileId, tileLayout.root, workspaceChatSessionsByTileId, workspaceTerminalPreferredRepo?.localPath]);

  const ideWorkspaceSessionsForSidebar = useMemo(() => {
    const deduped = new Map<string, MobileInboxSnapshot['sessions'][number]>();
    for (const sessions of Object.values(workspaceChatSessionsByTileId)) {
      for (const session of sessions) {
        if (!session?.sessionKey) continue;
        deduped.set(session.sessionKey, session);
      }
    }
    return [...deduped.values()];
  }, [workspaceChatSessionsByTileId]);

  const workspaceChatTargets = useMemo(
    () => buildWorkspaceChatTargetOptions(workspaceChatSessions),
    [workspaceChatSessions],
  );

  useEffect(() => {
    const openTerminalTileIds = new Set(collectTerminalLeafIds(tileLayout.root));
    setWorkspaceChatSessionByTileId((current) => {
      const next = Object.entries(current).reduce<Record<string, string | undefined>>((result, [tileId, value]) => {
        if (openTerminalTileIds.has(tileId)) result[tileId] = value;
        return result;
      }, {});
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setWorkspaceChatSessionsByTileId((current) => {
      const next = Object.entries(current).reduce<Record<string, MobileInboxSnapshot['sessions']>>((result, [tileId, value]) => {
        if (openTerminalTileIds.has(tileId)) result[tileId] = value;
        return result;
      }, {});
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setWorkspaceLaneByTileId((current) => {
      const next = Object.entries(current).reduce<Record<string, WorkspaceLaneState | null>>((result, [tileId, value]) => {
        if (openTerminalTileIds.has(tileId)) result[tileId] = value;
        return result;
      }, {});
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [tileLayout.root]);

  useEffect(() => {
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (!preferredRepoPath) return;
    if (collectOpenTerminalRepoPaths(tileLayout.root).length > 0) return;
    const firstUnscopedLeaf = findUnscopedTerminalLeaf(tileLayout.root);
    if (!firstUnscopedLeaf) return;
    setTerminalTileRepoScope(firstUnscopedLeaf.id, preferredRepoPath);
  }, [setTerminalTileRepoScope, tileLayout.root, workspaceTerminalPreferredRepo?.localPath]);

  const ensureWorkspaceTerminalTile = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const normalizedRepoPath = repoPath ?? null;
    const preferredTile = findPreferredWorkspaceTerminalTileId(normalizedRepoPath, preferredTileId);
    if (preferredTile) {
      if (normalizedRepoPath) {
        setTerminalTileRepoScope(preferredTile, normalizedRepoPath);
      }
      setActiveTileId(preferredTile);
      return preferredTile;
    }

    const workspaceTarget = findWorkspaceTarget();
    if (workspaceTarget) {
      setTileLayout((current) => ({
        ...current,
        root: replaceTileContent(current.root, workspaceTarget.id, {
          kind: 'terminal',
          repoPath: normalizedRepoPath,
        }),
      }));
      setActiveTileId(workspaceTarget.id);
      return workspaceTarget.id;
    }

    const targetLeaf = findInsertionTarget(['terminal', 'workspace']);
    const result = splitTile(
      tileLayout.root,
      targetLeaf.id,
      'vertical',
      {
        kind: 'terminal',
        repoPath: normalizedRepoPath,
      },
      0.58,
    );
    if (!result.newTileId) {
      return null;
    }
    setTileLayout((current) => ({
      ...current,
      root: result.root,
    }));
    setActiveTileId(result.newTileId);
    return result.newTileId;
  }, [findInsertionTarget, findPreferredWorkspaceTerminalTileId, findWorkspaceTarget, setActiveTileId, setTerminalTileRepoScope, setTileLayout, tileLayout.root]);

  const terminalWsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onTerminalCreated: (sessionName: string, requestId?: string) => {
      setDashTermSession(sessionName);
      let claimed = false;

      for (const handle of contextualPanelHandlesRef.current.values()) {
        claimed = handle.onSessionCreated(sessionName, requestId) || claimed;
        if (claimed) break;
      }

      if (!claimed) {
        for (const handle of workspaceTerminalHandlesRef.current.values()) {
          claimed = handle.onSessionCreated(sessionName, requestId) || claimed;
          if (claimed) break;
        }
      }
    },
    onTerminalData: (sessionName: string, data: string) => {
      terminalRef.current?.writeToTerminal(data);
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        handle.writeToTerminal(sessionName, data);
      }
      for (const handle of contextualPanelHandlesRef.current.values()) {
        handle.writeToTerminal(sessionName, data);
      }
    },
    onTerminalError: (sessionName: string, error: string) => {
      terminalRef.current?.setTermError(error);
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        handle.setTermError(sessionName, error);
      }
      for (const handle of contextualPanelHandlesRef.current.values()) {
        handle.setTermError(sessionName, error);
      }
    },
    onTerminalExited: (sessionName: string, _exitCode: number) => {
      terminalRef.current?.setTermExited(true);
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        handle.setTermExited(sessionName);
      }
      for (const handle of contextualPanelHandlesRef.current.values()) {
        handle.setTermExited(sessionName);
      }
    },
    onTerminalImage: (sessionName: string, imageB64: string, filename: string) => {
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        handle.showImage(sessionName, imageB64, filename);
      }
      for (const handle of contextualPanelHandlesRef.current.values()) {
        handle.showImage(sessionName, imageB64, filename);
      }
    },
    onAgentLifecycle: (sessionName: string, state: string, exitCode?: number) => {
      setLifecycleEvents((prev) => {
        const next = new Map(prev);
        next.set(sessionName, { state, exitCode, ts: Date.now() });
        return next;
      });
    },
  }), [contextualPanelHandlesRef]);

  const {
    isConnected: termWsConnected,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
    sendAgentKill,
  } = useSharedDesktopWs(undefined, terminalWsCallbacks);

  const waitForWorkspaceTerminalTarget = useCallback(async (options?: {
    repoPath?: string | null;
    preferredTileId?: string | null;
    fallbackToAnyExisting?: boolean;
  }): Promise<WorkspaceTerminalTarget> => {
    const repoPath = options?.repoPath ?? null;
    const preferredTileId = options?.preferredTileId ?? null;
    const initial = getPreferredWorkspaceTerminalTarget(repoPath, preferredTileId);
    if (initial) {
      setActiveTileId(initial.tileId);
      return initial;
    }

    const fallbackExisting = workspaceTerminalHandlesRef.current.entries().next().value as [string, TerminalTabHandle] | undefined;
    if (options?.fallbackToAnyExisting !== false && fallbackExisting) {
      const [tileId, handle] = fallbackExisting;
      setActiveTileId(tileId);
      return { tileId, handle };
    }

    const ensuredTileId = ensureWorkspaceTerminalTile(repoPath, preferredTileId);

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      const target = getPreferredWorkspaceTerminalTarget(repoPath, (ensuredTileId ?? preferredTileId) ?? undefined);
      if (target) {
        if (repoPath) {
          setTerminalTileRepoScope(target.tileId, repoPath);
        }
        setActiveTileId(target.tileId);
        return target;
      }
    }

    if (ensuredTileId) {
      const awaitedHandle = await new Promise<TerminalTabHandle | null>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          pendingWorkspaceTerminalResolversRef.current.delete(ensuredTileId);
          resolve(null);
        }, 12_000);
        pendingWorkspaceTerminalResolversRef.current.set(ensuredTileId, (handle) => {
          window.clearTimeout(timeoutId);
          resolve(handle);
        });
      });

      if (awaitedHandle) {
        if (repoPath) {
          setTerminalTileRepoScope(ensuredTileId, repoPath);
        }
        setActiveTileId(ensuredTileId);
        return { tileId: ensuredTileId, handle: awaitedHandle };
      }
    }

    throw new Error('Unable to attach the packet to a workspace lane. The workspace surface did not become ready in time.');
  }, [ensureWorkspaceTerminalTile, getPreferredWorkspaceTerminalTarget, setActiveTileId, setTerminalTileRepoScope]);

  const openWorkspaceTabForLane = useCallback(async (lane: {
    laneId?: string | null;
    packetId?: string | null;
    packetReferenceLabel?: string | null;
    packetTitle?: string | null;
    sessionKey: string;
    runtime: 'codex' | 'claude-code';
    repoPath: string;
    status?: string | null;
    branch?: string | null;
  }) => {
    const opened = openedLaneSessionsCache();
    if (opened.has(lane.sessionKey)) return;
    opened.add(lane.sessionKey);
    try {
      const packet = lane.packetId
        ? thoughtsMissionPackets.find((candidate) => candidate.id === lane.packetId) ?? null
        : null;
      const targetScope = workspaceScopeEntries.find((entry) => entry.localPath === lane.repoPath)
        ?? workspaceScopeEntries.find((entry) => pathBelongsToRepoScope(lane.repoPath, entry.localPath))
        ?? null;
      const target = await waitForWorkspaceTerminalTarget({
        repoPath: lane.repoPath,
        fallbackToAnyExisting: false,
      });
      const packetTitle = packet?.title ?? lane.packetTitle ?? targetScope?.name ?? 'Dispatched Agent';
      const packetReferenceLabel = packet?.referenceLabel ?? lane.packetReferenceLabel ?? lane.laneId ?? 'Lane';
      const packetStatus = packet && packet.status !== 'queued' && packet.status !== 'draft'
        ? packet.status
        : packetStatusFromLaneStatus(lane.status);
      target.handle.openCliChatSession({
        runtime: lane.runtime,
        repo: targetScope ? {
          name: targetScope.name,
          localPath: targetScope.localPath,
          branch: targetScope.branch ?? 'main',
          readiness: targetScope.readiness ?? null,
          remoteUrl: targetScope.remoteUrl ?? undefined,
          registryRepoId: targetScope.registryRepoId,
          isWorktree: targetScope.isWorktree ?? false,
          worktreeStatus: targetScope.worktreeStatus ?? null,
        } : undefined,
        targetSessionKey: lane.sessionKey,
        label: packetTitle,
        createNew: false,
        orchestrationPacket: lane.packetId
          ? {
              packetId: lane.packetId,
              referenceLabel: packetReferenceLabel,
              title: packetTitle,
              status: packetStatus,
              runtime: lane.runtime,
              branchTarget: lane.branch ?? packet?.branchTarget ?? null,
            }
          : null,
        autoArchiveOnIdle: false,
      });
      setActiveTileId(target.tileId);
      setActiveWorkspace(lane.repoPath);
      console.log(`[packet-dispatch-workspace] Surfaced ${lane.sessionKey} in workspace tile ${target.tileId}`);
    } catch (error) {
      opened.delete(lane.sessionKey);
      console.error('[packet-dispatch-workspace] Failed to surface dispatched lane:', error);
    }
  }, [setActiveTileId, setActiveWorkspace, thoughtsMissionPackets, waitForWorkspaceTerminalTarget, workspaceScopeEntries]);

  const realtimeDispatchCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onRealtimeEvent: (event: RealtimeEventEnvelope) => {
      if (event.channel !== 'mutation') return;
      if (event.event !== 'mutation.record' && event.event !== 'mutation.settled') return;
      const mutation = (event.data as { mutation?: RealtimeMutationRecord }).mutation;
      if (!mutation || mutation.action !== 'packet-dispatch' || mutation.status === 'failed') return;
      if (!mutation.sessionKey || !mutation.repoPath) return;

      void openWorkspaceTabForLane({
        laneId: mutation.laneId ?? null,
        packetId: mutation.packetId ?? null,
        packetReferenceLabel: mutation.packetReferenceLabel ?? null,
        packetTitle: mutation.packetTitle ?? null,
        sessionKey: mutation.sessionKey,
        runtime: mutation.runtime === 'claude-code' ? 'claude-code' : 'codex',
        repoPath: mutation.repoPath,
        status: 'launching',
        branch: mutation.branch ?? null,
      });
      void refreshWorkspaceLifecycle();
      void loadOrchestratorMissionState();
    },
    onLaneLifecycle: () => {
      void refreshWorkspaceLifecycle();
      void loadOrchestratorMissionState();
    },
  }), [openWorkspaceTabForLane, refreshWorkspaceLifecycle]);

  useSharedDesktopWs(undefined, realtimeDispatchCallbacks);

  useEffect(() => {
    async function pollLanes() {
      try {
        const res = await fetch('/api/lanes?active=true');
        if (!res.ok) return;
        const data = await res.json();
        for (const lane of (data.lanes ?? []) as Array<{
          id: string;
          label: string;
          packetId: string | null;
          sessionKey: string | null;
          status: string;
          runtime: string;
          repoPath: string;
          branch?: string;
        }>) {
          if (!lane.sessionKey) continue;
          if (lane.status !== 'running' && lane.status !== 'launching') continue;
          void openWorkspaceTabForLane({
            laneId: lane.id,
            packetId: lane.packetId,
            packetReferenceLabel: null,
            packetTitle: lane.label,
            sessionKey: lane.sessionKey,
            runtime: lane.runtime === 'claude-code' ? 'claude-code' : 'codex',
            repoPath: lane.repoPath,
            status: lane.status,
            branch: lane.branch ?? null,
          });
        }
      } catch { /* best-effort */ }
    }

    const initTimer = setTimeout(pollLanes, 2_000);
    const id = setInterval(pollLanes, 15_000);
    return () => { clearTimeout(initTimer); clearInterval(id); };
  }, [openWorkspaceTabForLane]);

  const collectOrchestratorLaneSnapshots = useCallback((): OrchestratorLaneSnapshot[] => (
    Array.from(workspaceTerminalHandlesRef.current.values()).flatMap((handle) => handle.getChatTabSnapshots())
  ), []);

  const areWorkspaceTerminalRestoresSettled = useCallback(() => {
    const terminalTileIds = collectTerminalLeafIds(tileLayout.root);
    if (terminalTileIds.length === 0) return false;
    return terminalTileIds.every((tileId) => {
      const handle = workspaceTerminalHandlesRef.current.get(tileId);
      return handle?.isRestoreSettled() ?? false;
    });
  }, [tileLayout.root]);

  const focusOrchestrationPacketLane = useCallback((packet: OrchestratorPacket) => {
    if (!packet.lane) return;
    const handle = workspaceTerminalHandlesRef.current.get(packet.lane.tileId);
    if (!handle) return;
    setActiveTileId(packet.lane.tileId);
    handle.focusTab(packet.lane.tabId);
  }, [setActiveTileId]);

  useEffect(() => {
    thoughtsMissionPackets.forEach((packet) => {
      if (!packet.lane) return;
      const handle = workspaceTerminalHandlesRef.current.get(packet.lane.tileId);
      handle?.setOrchestrationPacket(packet.lane.tabId, buildOrchestrationPacketBadge(packet));
    });
  }, [thoughtsMissionPackets]);

  const updateSupervisorWorkspaceTab = useCallback((surfaceId: string, status: string, label?: string) => {
    for (const handle of workspaceTerminalHandlesRef.current.values()) {
      if (handle?.updateChatRuntimeStatus(surfaceId, status, label)) {
        return true;
      }
    }
    return false;
  }, []);

  return {
    activeWorkspaceChatSessionKey,
    activeWorkspaceLane,
    areWorkspaceTerminalRestoresSettled,
    collectOrchestratorLaneSnapshots,
    dashTermSession,
    ensureWorkspaceTerminalTile,
    findInsertionTarget,
    findWorkspaceTarget,
    focusOrchestrationPacketLane,
    ideWorkspaceSessionsForSidebar,
    lifecycleEvents,
    registerWorkspaceTerminalHandle,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    setTerminalTileRepoScope,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceTerminalResetNonceByTileId,
    termCreatedRef,
    termWsConnected,
    updateSupervisorWorkspaceTab,
    waitForWorkspaceTerminalTarget,
    workspaceChatSessions,
    workspaceChatSessionsByTileId,
    workspaceChatTargets,
    workspaceTerminalHandlesRef,
    workspaceTerminalResetNonceByTileId,
  };
}
