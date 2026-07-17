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
// TerminalHandle was the only thing live in LiveOutput.tsx — that file
// was deleted, the shape lives here now.
interface TerminalHandle {
  writeToTerminal: (data: string) => void;
  setTermError: (error: string) => void;
  setTermExited: (exited: boolean) => void;
}
import type { ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import type { TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import type { Lane, LaneStatus } from '@/lib/lane/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { fetchOnce } from '@/lib/panel/fetch-cache';
import {
  loadOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import type {
  OrchestratorLaneSnapshot,
  OrchestratorPacket,
  WorkspaceLaneState,
} from '@/lib/orchestrator/types';
import type { RealtimeEventEnvelope, RealtimeMutationRecord } from '@/lib/realtime/types';
import { registerIntrospectionContributor } from '@/lib/feedback/workspace-introspect';
import {
  collectLeafNodes,
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
import { focusOrchestrationPacketLaneInWorkspace } from './focusOrchestrationPacketLane';
import { useLaneArchivedView, isRetiredLaneStatus } from './useLaneArchivedSet';

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

function isAutomationLane(lane: Pick<Lane, 'label'>): boolean {
  return lane.label.trim().toLowerCase().startsWith('[automation]');
}

function cleanAutomationLaneTitle(label: string): string {
  return label.replace(/^\[automation\]\s*/i, '').trim() || 'Automation run';
}

function automationLaneStatus(status: LaneStatus): MobileInboxSnapshot['sessions'][number]['status'] {
  switch (status) {
    case 'running':
      return 'running';
    case 'launching':
    case 'recovering':
      return 'waiting';
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'failed':
      return 'blocked';
    case 'reviewing':
    case 'merging':
      return 'reviewing';
    case 'completed':
      return 'completed';
    default:
      return 'idle';
  }
}

function buildAutomationLaneSession(lane: Lane): MobileInboxSnapshot['sessions'][number] {
  const sessionKey = lane.sessionKey ?? `automation-lane:${lane.id}`;
  const title = cleanAutomationLaneTitle(lane.label);
  const lastEventAt = lane.lastEventAt ?? lane.updatedAt ?? lane.createdAt;
  const parsedUpdatedAt = Date.parse(lane.updatedAt);
  const hasLiveSession = Boolean(lane.sessionKey);
  return {
    id: sessionKey,
    name: title,
    squadId: 'automation',
    runtime: lane.runtime,
    model: lane.runtime,
    status: automationLaneStatus(lane.status),
    currentTask: `Automation · ${lane.status.replace(/_/g, ' ')}`,
    workspace: lane.repoPath,
    branch: lane.branch || lane.baseBranch || 'main',
    sessionKey,
    approvalStatus: 'none',
    lastEventAt,
    lastActivityAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null,
    context: { usedPercent: 0, trend: 'stable' },
    alerts: lane.status === 'awaiting_input' || lane.status === 'failed' || lane.status === 'recovering' ? 1 : 0,
    sessionId: lane.sessionKey ?? undefined,
    sessionKind: 'automation',
    surfaceLabel: title,
    isCurrentSession: false,
    runtimeSurface: {
      id: sessionKey,
      runtime: lane.runtime,
      kind: 'chat-session',
      ownership: 'owned',
      title,
      cwd: lane.worktreePath ?? lane.repoPath,
      branch: lane.branch || lane.baseBranch || 'main',
      sourceLabel: 'Automation run',
      capabilities: {
        attach: false,
        readTail: hasLiveSession,
        sendInput: hasLiveSession,
        interrupt: hasLiveSession,
        resize: false,
        diffContext: true,
        reviewContext: true,
      },
    },
  };
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
  // Fresh active-tile identity for stable callbacks (openWorkspaceTabForLane
  // routes dispatched packet tabs to the ACTIVE workspace without taking
  // activeTileId as a dep and re-creating the callback per tab switch).
  const activeTileIdRef = useRef(activeTileId);
  activeTileIdRef.current = activeTileId;
  const termCreatedRef = useRef(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const workspaceTerminalHandlesRef = useRef<Map<string, TerminalTabHandle>>(new Map());
  const pendingWorkspaceTerminalResolversRef = useRef<Map<string, (handle: TerminalTabHandle) => void>>(new Map());
  const [workspaceChatSessionByTileId, setWorkspaceChatSessionByTileId] = useState<Record<string, string | undefined>>({});
  const [workspaceChatSessionsByTileId, setWorkspaceChatSessionsByTileId] = useState<Record<string, MobileInboxSnapshot['sessions']>>({});
  const [automationLaneSessions, setAutomationLaneSessions] = useState<MobileInboxSnapshot['sessions']>([]);
  const [workspaceLaneByTileId, setWorkspaceLaneByTileId] = useState<Record<string, WorkspaceLaneState | null>>({});
  const [workspaceActiveTabKindByTileId, setWorkspaceActiveTabKindByTileId] = useState<Record<string, TerminalTab['kind'] | null>>({});
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

  // Report-time forensics (GQXEZD): the silent "New session does nothing"
  // class needs the tile/handle truth at the moment a report is filed —
  // which leaves exist, which have live handles, where the active tile
  // points. Registered as an introspection contributor; read via
  // collectClientDiagnostics and window.__o8Introspect().
  const introspectionStateRef = useRef({ tileLayout, activeTileId });
  introspectionStateRef.current = { tileLayout, activeTileId };
  useEffect(() => registerIntrospectionContributor('layout', () => {
    const { tileLayout: layout, activeTileId: active } = introspectionStateRef.current;
    return {
      activeTileId: active,
      leaves: collectLeafNodes(layout.root).map((leaf) => ({
        id: leaf.id,
        kind: leaf.content.kind,
        repoPath: leaf.content.kind === 'terminal' ? (leaf.content.repoPath ?? null) : undefined,
      })),
      handleTileIds: [...workspaceTerminalHandlesRef.current.keys()],
      pendingResolverTileIds: [...pendingWorkspaceTerminalResolversRef.current.keys()],
    };
  }), []);

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

  const archivedLaneView = useLaneArchivedView();
  const archivedLaneSessionKeys = archivedLaneView.sessionKeys;
  // Live ref so openWorkspaceTabForLane can consult the retired-lane set without
  // taking it as a dep (which would re-create the callback on every view change).
  const archivedLaneViewRef = useRef(archivedLaneView);
  archivedLaneViewRef.current = archivedLaneView;

  const refreshAutomationLaneSessions = useCallback(async () => {
    try {
      const response = await fetch('/api/lanes?active=false', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json() as { lanes?: Lane[] };
      const sessions = (payload.lanes ?? [])
        .filter(isAutomationLane)
        .filter((lane) => lane.status !== 'archived' && lane.status !== 'completed')
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .map(buildAutomationLaneSession);
      setAutomationLaneSessions(sessions);
    } catch {
      // Best-effort sidebar visibility; the underlying automation lane remains durable.
    }
  }, []);

  useEffect(() => {
    const handler = () => { void refreshAutomationLaneSessions(); };
    const initialRefreshId = window.setTimeout(handler, 0);
    window.addEventListener('o8:lifecycle-reconcile', handler);
    window.addEventListener('o8:supervisor-inbox', handler);
    const intervalId = window.setInterval(handler, 30_000);
    return () => {
      window.clearTimeout(initialRefreshId);
      window.clearInterval(intervalId);
      window.removeEventListener('o8:lifecycle-reconcile', handler);
      window.removeEventListener('o8:supervisor-inbox', handler);
    };
  }, [refreshAutomationLaneSessions]);

  const ideWorkspaceSessionsForSidebar = useMemo(() => {
    const deduped = new Map<string, MobileInboxSnapshot['sessions'][number]>();
    for (const sessions of Object.values(workspaceChatSessionsByTileId)) {
      for (const session of sessions) {
        if (!session?.sessionKey) continue;
        // Hide sessions whose lane has been archived. Leaves orphaned
        // (lane-less) sessions in place so we never regress visibility for
        // sessions that pre-date the lane-wrap work.
        if (archivedLaneSessionKeys.has(session.sessionKey)) continue;
        deduped.set(session.sessionKey, session);
      }
    }
    for (const session of automationLaneSessions) {
      if (!session?.sessionKey) continue;
      if (archivedLaneSessionKeys.has(session.sessionKey)) continue;
      const existing = deduped.get(session.sessionKey);
      if (existing) {
        deduped.set(session.sessionKey, {
          ...existing,
          name: session.name || existing.name,
          squadId: 'automation',
          sessionKind: 'automation',
          surfaceLabel: session.surfaceLabel ?? session.name ?? existing.surfaceLabel,
          currentTask: existing.currentTask || session.currentTask,
          status: existing.status === 'running' ? existing.status : session.status,
          runtimeSurface: {
            ...session.runtimeSurface,
            ...existing.runtimeSurface,
            id: session.runtimeSurface?.id ?? existing.runtimeSurface?.id ?? session.sessionKey,
            runtime: existing.runtimeSurface?.runtime ?? session.runtimeSurface?.runtime ?? existing.runtime ?? session.runtime ?? 'codex',
            kind: existing.runtimeSurface?.kind ?? session.runtimeSurface?.kind ?? 'chat-session',
            ownership: existing.runtimeSurface?.ownership ?? session.runtimeSurface?.ownership ?? 'owned',
            title: session.runtimeSurface?.title ?? existing.runtimeSurface?.title ?? session.name ?? existing.name ?? 'Automation run',
            cwd: existing.runtimeSurface?.cwd ?? session.runtimeSurface?.cwd,
            sourceLabel: 'Automation run',
            capabilities: {
              attach: existing.runtimeSurface?.capabilities.attach ?? session.runtimeSurface?.capabilities.attach ?? false,
              readTail: existing.runtimeSurface?.capabilities.readTail ?? session.runtimeSurface?.capabilities.readTail ?? false,
              sendInput: existing.runtimeSurface?.capabilities.sendInput ?? session.runtimeSurface?.capabilities.sendInput ?? false,
              interrupt: existing.runtimeSurface?.capabilities.interrupt ?? session.runtimeSurface?.capabilities.interrupt ?? false,
              resize: existing.runtimeSurface?.capabilities.resize ?? session.runtimeSurface?.capabilities.resize ?? false,
              diffContext: existing.runtimeSurface?.capabilities.diffContext ?? session.runtimeSurface?.capabilities.diffContext ?? false,
              reviewContext: existing.runtimeSurface?.capabilities.reviewContext ?? session.runtimeSurface?.capabilities.reviewContext ?? false,
            },
          },
        });
        continue;
      }
      deduped.set(session.sessionKey, session);
    }
    return [...deduped.values()];
  }, [workspaceChatSessionsByTileId, automationLaneSessions, archivedLaneSessionKeys]);

  const workspaceChatTargets = useMemo(
    () => buildWorkspaceChatTargetOptions(workspaceChatSessions),
    [workspaceChatSessions],
  );

  useEffect(() => {
    const pruneId = window.setTimeout(() => {
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
    }, 0);
    return () => window.clearTimeout(pruneId);
  }, [tileLayout.root]);

  useEffect(() => {
    const preferredRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (!preferredRepoPath) return;
    if (collectOpenTerminalRepoPaths(tileLayout.root).length > 0) return;
    const firstUnscopedLeaf = findUnscopedTerminalLeaf(tileLayout.root);
    if (!firstUnscopedLeaf) return;
    setTerminalTileRepoScope(firstUnscopedLeaf.id, preferredRepoPath);
  }, [setTerminalTileRepoScope, tileLayout.root, workspaceTerminalPreferredRepo?.localPath]);

  const ensureWorkspaceTerminalTile = useCallback((repoPath?: string | null, preferredTileId?: string | null, activate = true) => {
    const normalizedRepoPath = repoPath ?? null;
    const preferredTile = findPreferredWorkspaceTerminalTileId(normalizedRepoPath, preferredTileId);
    if (preferredTile) {
      if (normalizedRepoPath) {
        setTerminalTileRepoScope(preferredTile, normalizedRepoPath);
      }
      if (activate) setActiveTileId(preferredTile);
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
      if (activate) setActiveTileId(workspaceTarget.id);
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
    if (activate) setActiveTileId(result.newTileId);
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
    activate?: boolean;
  }): Promise<WorkspaceTerminalTarget> => {
    const repoPath = options?.repoPath ?? null;
    const preferredTileId = options?.preferredTileId ?? null;
    const activate = options?.activate ?? true;
    const initial = getPreferredWorkspaceTerminalTarget(repoPath, preferredTileId);
    if (initial) {
      if (activate) setActiveTileId(initial.tileId);
      return initial;
    }
    const fallbackExisting = workspaceTerminalHandlesRef.current.entries().next().value as [string, TerminalTabHandle] | undefined;
    if (options?.fallbackToAnyExisting !== false && fallbackExisting) {
      const [tileId, handle] = fallbackExisting;
      if (activate) setActiveTileId(tileId);
      return { tileId, handle };
    }
    const ensuredTileId = ensureWorkspaceTerminalTile(repoPath, preferredTileId, activate);

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      const target = getPreferredWorkspaceTerminalTarget(repoPath, (ensuredTileId ?? preferredTileId) ?? undefined);
      if (target) {
        if (repoPath) {
          setTerminalTileRepoScope(target.tileId, repoPath);
        }
        if (activate) setActiveTileId(target.tileId);
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
        if (activate) setActiveTileId(ensuredTileId);
        return { tileId: ensuredTileId, handle: awaitedHandle };
      }
    }

    throw new Error('Unable to attach the packet to a workspace lane. The workspace surface did not become ready in time.');
  }, [ensureWorkspaceTerminalTile, getPreferredWorkspaceTerminalTarget, setActiveTileId, setTerminalTileRepoScope]);

  // openWorkspaceTabForLane supports owned worker runtimes natively — the
  // monitoring tab opens with the actual lane.runtime, so the chat pane
  // labels the agent correctly and /api/mobile/history serves the right
  // owned-session transcript. Pre-v0.1.27 callers downcast gemini/opencode
  // to codex which caused "Connecting to Codex session" spinners on real
  // Gemini packets.
  const openWorkspaceTabForLane = useCallback(async (lane: {
    laneId?: string | null;
    packetId?: string | null;
    packetReferenceLabel?: string | null;
    packetTitle?: string | null;
    sessionKey: string;
    runtime: 'codex' | 'claude-code' | 'gemini' | 'antigravity' | 'opencode' | 'cursor' | 'grok';
    repoPath: string;
    status?: string | null;
    branch?: string | null;
  }) => {
    // #1293 — never resurrect a chat tab for a lane that already retired. The
    // WS dispatch-replay fires stale `packet-dispatch` mutations on boot; each
    // one would otherwise re-open a zombie tab for an archived packet (the
    // #943 / #1293 duplicates). The view-change sweep below is the safety net
    // for the open-before-view-loads race; this blocks the common case (archived
    // set already resolved) with no flicker.
    const retired = archivedLaneViewRef.current;
    if ((lane.packetId != null && retired.packetIds.has(lane.packetId))
      || retired.sessionKeys.has(lane.sessionKey)) {
      return;
    }
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
      // Dispatched packet MONITORING tabs attach to the operator's active
      // workspace — they must never mint a second WorkspaceTerminal leaf.
      // `fallbackToAnyExisting: false` was the April-2026 auto-split zombie
      // (Q live-hit 2026-07-16): with the orchestrator's host tile at
      // repoPath:null, the repo-scoped lookup missed, the reuse branch was
      // opted out, and ensureWorkspaceTerminalTile split a whole second pane
      // — which every later same-repo dispatch then deterministically
      // reused. The tab carries its own repo/worktree context
      // (targetScope + orchestrationPacket), so the host tile's scope is
      // irrelevant; preferredTileId makes the ACTIVE workspace win before
      // any stale repo-scoped leaf. NOT the session-tiles drag-to-split —
      // that system is separate and untouched.
      const target = await waitForWorkspaceTerminalTarget({
        repoPath: lane.repoPath,
        preferredTileId: activeTileIdRef.current,
      });
      const rawPacketTitle = packet?.title ?? lane.packetTitle ?? targetScope?.name ?? 'Dispatched Agent';
      const packetTitle = rawPacketTitle.trim().toLowerCase().startsWith('[automation]')
        ? cleanAutomationLaneTitle(rawPacketTitle)
        : rawPacketTitle;
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

      const mutationRuntime = (mutation.runtime === 'claude-code'
        || mutation.runtime === 'gemini'
        || mutation.runtime === 'opencode'
        || mutation.runtime === 'cursor'
        || mutation.runtime === 'grok')
        ? mutation.runtime
        : 'codex';
      void openWorkspaceTabForLane({
        laneId: mutation.laneId ?? null,
        packetId: mutation.packetId ?? null,
        packetReferenceLabel: mutation.packetReferenceLabel ?? null,
        packetTitle: mutation.packetTitle ?? null,
        sessionKey: mutation.sessionKey,
        runtime: mutationRuntime,
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
        const res = await fetchOnce('/api/lanes?active=true');
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
          const laneRuntime = (lane.runtime === 'claude-code'
            || lane.runtime === 'gemini'
            || lane.runtime === 'opencode'
            || lane.runtime === 'cursor'
            || lane.runtime === 'grok')
            ? lane.runtime
            : 'codex';
          void openWorkspaceTabForLane({
            laneId: lane.id,
            packetId: lane.packetId,
            packetReferenceLabel: null,
            packetTitle: lane.label,
            sessionKey: lane.sessionKey,
            runtime: laneRuntime,
            repoPath: lane.repoPath,
            status: lane.status,
            branch: lane.branch ?? null,
          });
        }
      } catch { /* best-effort */ }
    }

    const initTimer = setTimeout(pollLanes, 2_000);
    // WS-driven: instant refresh on lane events instead of 15s polling
    const handler = () => { void pollLanes(); };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(pollLanes, 300_000);
    return () => {
      clearTimeout(initTimer);
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [openWorkspaceTabForLane]);

  // #1293 — when a lane retires (archived/completed), close its orphaned chat
  // tab. The strip otherwise keeps a dead "ghost" tab after reset/merge — it
  // survives even a full backend cleanup. The subscriber above only refetches
  // lane data; this one acts on the event payload to close the matching tab.
  useEffect(() => {
    const onLaneLifecycle = (event: Event) => {
      const data = (event as CustomEvent<{ data?: { sessionKey?: string | null; packetId?: string | null; status?: string; laneStatus?: string } }>).detail?.data;
      if (!data || !isRetiredLaneStatus(data.laneStatus ?? data.status)) return;
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        if (handle?.closeChatTabForRetiredLane({ sessionKey: data.sessionKey, packetId: data.packetId })) break;
      }
    };
    window.addEventListener('o8:lane-lifecycle', onLaneLifecycle);
    return () => window.removeEventListener('o8:lane-lifecycle', onLaneLifecycle);
  }, []);

  // #1293 Part C — sweep pre-existing zombie tabs: the event listener above only
  // catches LIVE retires, so a tab whose lane archived before it mounted (a
  // reset on a prior build, a reload) persists. When the archived-lane set
  // resolves/changes, close any chat tab already in it. Idempotent + cheap.
  useEffect(() => {
    if (archivedLaneView.sessionKeys.size === 0 && archivedLaneView.packetIds.size === 0) return;
    for (const handle of workspaceTerminalHandlesRef.current.values()) {
      handle?.closeRetiredChatTabs(archivedLaneView);
    }
  }, [archivedLaneView]);

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
    focusOrchestrationPacketLaneInWorkspace({
      packet,
      setActiveTileId,
      waitForWorkspaceTerminalTarget,
      workspaceTerminalHandlesRef,
    });
  }, [setActiveTileId, waitForWorkspaceTerminalTarget]);

  // Rebind packet badges to workspace tabs whenever mission state changes.
  //
  // Two binding paths must both work:
  //   1. orchestrator-spawned packets come with `lane.tileId` + `lane.tabId`
  //      already populated (the orchestrator created the tab itself).
  //   2. MCP-dispatched packets bind via `lane.sessionKey` only — the
  //      Codex session id IS the tab id for CLI runtime tabs (see
  //      openCliChatSession). lane.tileId / lane.tabId stay null because
  //      the tab is created on the dashboard side post-dispatch and the
  //      backend never gets told which tile/tab caught the session.
  //
  // The earlier code only handled path #1 and silently dropped MCP-spawned
  // packets, leaving their tabs with a stale (or missing)
  // orchestrationPacket badge — which is why the wrong PacketHeaderCard
  // and orange-marker regressions appeared after dispatching via MCP.
  // Three rebind paths — must all work because the persistent identity
  // of a packet→tab binding shrinks as the packet moves through status:
  //   1. orchestrator-spawned: lane.tileId + lane.tabId both present
  //   2. MCP-dispatched in-flight: only lane.sessionKey is bound
  //   3. terminal (released/failed/archived): lane is null entirely;
  //      the only stable handle left is packet.id matching the tab's
  //      already-bound badge.packetId — without this fallback the tab
  //      gets stuck at `awaiting_review` and never goes green on merge.
  useEffect(() => {
    thoughtsMissionPackets.forEach((packet) => {
      const badge = buildOrchestrationPacketBadge(packet);

      const tileId = packet.lane?.tileId ?? null;
      const tabId = packet.lane?.tabId ?? null;
      if (tileId && tabId) {
        const handle = workspaceTerminalHandlesRef.current.get(tileId);
        if (handle?.setOrchestrationPacket(tabId, badge)) return;
      }

      const sessionKey = packet.lane?.sessionKey ?? null;
      if (sessionKey) {
        for (const handle of workspaceTerminalHandlesRef.current.values()) {
          if (handle?.setOrchestrationPacket(sessionKey, badge)) return;
        }
      }

      // setOrchestrationPacket also matches by an existing badge.packetId
      // when the third arg matches (added below). Pass packet.id as the
      // by-packet fallback identifier.
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        if (handle?.setOrchestrationPacket(packet.id, badge)) return;
      }
    });
  }, [thoughtsMissionPackets]);

  // #1293 — a RESET packet orphans its chat tab. Sibling to the badge-rebind
  // above: the rebind re-attaches LIVE packets; this closes a chat tab whose
  // packet was reset. A reset drops the packet back to `draft` and clears its
  // lane (status 'draft' && lane === null), OR removes it from mission state
  // entirely — neither path fires a `lane-lifecycle` archived event, so the
  // event-driven close listener above never catches it and the tab lingers as a
  // ghost. Reading the persisted client mission state closes it regardless of
  // broadcast-payload ordering (covers the main + fallback reset paths).
  useEffect(() => {
    const handles = Array.from(workspaceTerminalHandlesRef.current.values());
    if (handles.length === 0) return;

    // (a) Packets still present but reset to the draft / no-lane signature.
    for (const packet of thoughtsMissionPackets) {
      if (packet.status === 'draft' && !packet.lane) {
        for (const handle of handles) {
          if (handle?.closeChatTabForRetiredLane({ packetId: packet.id })) break;
        }
      }
    }

    // (b) Chat tabs whose bound packet vanished from mission state entirely.
    // Guarded on a non-empty known set so a transient empty load never closes
    // live tabs.
    if (thoughtsMissionPackets.length === 0) return;
    const knownPacketIds = new Set(thoughtsMissionPackets.map((packet) => packet.id));
    const boundPacketIds = handles
      .flatMap((handle) => handle.getChatTabSnapshots())
      .map((snapshot) => snapshot.packetId)
      .filter((packetId): packetId is string => Boolean(packetId));
    for (const packetId of boundPacketIds) {
      if (knownPacketIds.has(packetId)) continue;
      for (const handle of handles) {
        if (handle?.closeChatTabForRetiredLane({ packetId })) break;
      }
    }
  }, [thoughtsMissionPackets]);

  // Option D — self-heal the tab LABEL when a packet's real title resolves. The
  // twin of the badge rebind above: the badge already healed on async data, the
  // label didn't, so it stayed frozen on whatever fallback it had at open-time
  // (e.g. the runtime name "Codex", or — before the canonical helper — a raw id
  // slice). Only fires when the packet carries a REAL title, so it never
  // downgrades a good label to a generic; setTabLabelIfAuto itself skips
  // user-renamed tabs (labelSource === 'user') and no-op writes (value-diff
  // guard), so there's no re-render churn and renames are preserved.
  useEffect(() => {
    thoughtsMissionPackets.forEach((packet) => {
      const title = buildOrchestrationPacketBadge(packet).title?.trim();
      if (!title) return;
      const match = { sessionKey: packet.lane?.sessionKey ?? null, packetId: packet.id };
      for (const handle of workspaceTerminalHandlesRef.current.values()) {
        if (handle?.setTabLabelIfAuto(match, title)) return;
      }
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
    setWorkspaceActiveTabKindByTileId,
    setWorkspaceChatSessionByTileId,
    setWorkspaceChatSessionsByTileId,
    setWorkspaceLaneByTileId,
    setWorkspaceTerminalResetNonceByTileId,
    workspaceActiveTabKindByTileId,
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
