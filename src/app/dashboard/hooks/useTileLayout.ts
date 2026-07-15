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
import type { CanvasTab } from '@/components/desktop/Canvas';
import type { ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import type { TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import {
  closeTile,
  collectLeafContentKinds,
  countLeaves,
  createDefaultTileLayout,
  createTileContent,
  deserializeTileLayout,
  findLeafByContentKind,
  findSiblingLeaf,
  findTile,
  getFirstLeaf,
  replaceTileContent,
  resizeTile,
  serializeTileLayout,
  splitTile,
  wrapRootWithSplit,
} from '@/lib/tiles/operations';
import type { TileContentKind, TileLayout, TileLeafNode } from '@/lib/tiles/types';
import type {
  CanvasTileState,
  WorkspaceChatTargetOption,
  WorkspaceScopeEntry,
} from '../types';
import {
  collectOpenTerminalRepoPaths,
  findCanvasLeafByRepoPath,
  findUnscopedCanvasLeaf,
  repoSlugFromRemote,
} from '../utils';

export const TILE_LAYOUT_STORAGE_KEY = 'o8:dashboard-tiles:v1';
const ACTIVE_TILE_STORAGE_KEY = 'o8:dashboard-active-tile:v1';

interface WorkspaceTerminalTarget {
  tileId: string;
  handle: TerminalTabHandle;
}

interface UseTileLayoutArgs {
  activeTileId: string | null;
  activeWorkspaceChatSessionKey: string | undefined;
  contextualPanelHandlesRef: MutableRefObject<Map<string, ContextualPanelHandle>>;
  findInsertionTarget: (preferredKinds: TileContentKind[]) => TileLeafNode;
  findWorkspaceTarget: () => TileLeafNode | null;
  globalRepoEntries: RepoRegistryEntry[];
  globalRepoEntry: RepoRegistryEntry | null;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  setTileLayout: Dispatch<SetStateAction<TileLayout>>;
  tileLayout: TileLayout;
  workspaceChatTargetKeyByRepoPath: Record<string, string>;
  workspaceChatTargets: WorkspaceChatTargetOption[];
  workspaceSidePanelRepoPath: string | null;
  workspaceTerminalHandlesRef: MutableRefObject<Map<string, TerminalTabHandle>>;
  workspaceTerminalPreferredRepo: WorkspaceScopeEntry | null;
  waitForWorkspaceTerminalTarget: (options?: {
    repoPath?: string | null;
    preferredTileId?: string | null;
    fallbackToAnyExisting?: boolean;
    activate?: boolean;
  }) => Promise<WorkspaceTerminalTarget>;
}

export function useTileLayout({
  activeTileId,
  activeWorkspaceChatSessionKey,
  contextualPanelHandlesRef,
  findInsertionTarget,
  findWorkspaceTarget,
  globalRepoEntries,
  globalRepoEntry,
  setActiveTileId,
  setTileLayout,
  tileLayout,
  workspaceChatTargetKeyByRepoPath,
  workspaceChatTargets,
  workspaceSidePanelRepoPath,
  workspaceTerminalHandlesRef,
  workspaceTerminalPreferredRepo,
  waitForWorkspaceTerminalTarget,
}: UseTileLayoutArgs) {
  const [workspacePreviews, setWorkspacePreviews] = useState<DetectedLocalhostPreview[]>([]);
  const [tileLayoutHydrated, setTileLayoutHydrated] = useState(false);
  const canvasStateByTileIdRef = useRef<Record<string, CanvasTileState>>({});
  const [canvasStateByTileId, setCanvasStateByTileId] = useState<Record<string, CanvasTileState>>({});

  const registerContextualPanelHandle = useCallback((tileId: string, handle: ContextualPanelHandle | null) => {
    if (handle) {
      contextualPanelHandlesRef.current.set(tileId, handle);
      return;
    }
    contextualPanelHandlesRef.current.delete(tileId);
  }, [contextualPanelHandlesRef]);

  const getPreferredContextualPanelHandle = useCallback((preferredTileId?: string | null) => {
    if (preferredTileId) {
      const preferredHandle = contextualPanelHandlesRef.current.get(preferredTileId);
      if (preferredHandle) {
        return preferredHandle;
      }
    }
    if (activeTileId) {
      const activeHandle = contextualPanelHandlesRef.current.get(activeTileId);
      if (activeHandle) {
        return activeHandle;
      }
    }
    return contextualPanelHandlesRef.current.values().next().value ?? null;
  }, [activeTileId, contextualPanelHandlesRef]);

  const activeSurfaceRepoPath = useMemo(() => {
    if (!activeTileId) return null;
    const activeTile = findTile(tileLayout.root, activeTileId);
    if (activeTile?.type === 'leaf' && activeTile.content.kind === 'terminal') {
      return activeTile.content.repoPath ?? null;
    }
    return null;
  }, [activeTileId, tileLayout.root]);

  const workspaceChatTargetRepoPath = workspaceSidePanelRepoPath
    ?? workspaceTerminalPreferredRepo?.localPath
    ?? globalRepoEntry?.localPath
    ?? '__global__';

  const activeWorkspaceChatTargetKey = useMemo(() => {
    const preferredTargetKey = workspaceChatTargetKeyByRepoPath[workspaceChatTargetRepoPath];
    if (preferredTargetKey && workspaceChatTargets.some((target) => target.sessionKey === preferredTargetKey)) {
      return preferredTargetKey;
    }
    if (activeWorkspaceChatSessionKey && workspaceChatTargets.some((target) => target.sessionKey === activeWorkspaceChatSessionKey)) {
      return activeWorkspaceChatSessionKey;
    }
    return workspaceChatTargets[0]?.sessionKey ?? null;
  }, [activeWorkspaceChatSessionKey, workspaceChatTargetKeyByRepoPath, workspaceChatTargetRepoPath, workspaceChatTargets]);

  const workspaceChatTargetOption = useMemo(
    () => workspaceChatTargets.find((target) => target.sessionKey === activeWorkspaceChatTargetKey) ?? null,
    [activeWorkspaceChatTargetKey, workspaceChatTargets],
  );

  const workspaceChatTargetLabel = workspaceChatTargetOption?.label ?? null;

  const setCanvasTileRepoScope = useCallback((tileId: string, repoPath: string | null) => {
    setTileLayout((current) => {
      const tile = findTile(current.root, tileId);
      if (tile?.type !== 'leaf' || tile.content.kind !== 'canvas') {
        return current;
      }
      const nextRepoPath = repoPath ?? null;
      if ((tile.content.repoPath ?? null) === nextRepoPath) {
        return current;
      }
      return {
        ...current,
        root: replaceTileContent(current.root, tileId, {
          kind: 'canvas',
          repoPath: nextRepoPath,
        }),
      };
    });
  }, [setTileLayout]);

  const findPreferredCanvasTileId = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const normalizedRepoPath = repoPath ?? null;
    if (preferredTileId) {
      const preferredTile = findTile(tileLayout.root, preferredTileId);
      if (preferredTile?.type === 'leaf' && preferredTile.content.kind === 'canvas') {
        const preferredRepoPath = preferredTile.content.repoPath ?? null;
        if (!normalizedRepoPath || preferredRepoPath === normalizedRepoPath || preferredRepoPath === null) {
          return preferredTileId;
        }
      }
    }

    if (normalizedRepoPath) {
      const matchingLeaf = findCanvasLeafByRepoPath(tileLayout.root, normalizedRepoPath);
      if (matchingLeaf) {
        return matchingLeaf.id;
      }
    }

    if (activeTileId) {
      const activeTile = findTile(tileLayout.root, activeTileId);
      if (activeTile?.type === 'leaf' && activeTile.content.kind === 'canvas') {
        const activeRepoPath = activeTile.content.repoPath ?? null;
        if (!normalizedRepoPath || activeRepoPath === normalizedRepoPath || activeRepoPath === null) {
          return activeTileId;
        }
      }
    }

    if (normalizedRepoPath) {
      const unscopedLeaf = findUnscopedCanvasLeaf(tileLayout.root);
      const unscopedState = unscopedLeaf ? canvasStateByTileIdRef.current[unscopedLeaf.id] : null;
      if (unscopedLeaf && (!unscopedState || unscopedState.tabs.length === 0)) {
        return unscopedLeaf.id;
      }
      return null;
    }

    const existingLeaf = findUnscopedCanvasLeaf(tileLayout.root);
    return existingLeaf?.id ?? null;
  }, [activeTileId, tileLayout.root]);

  const ensureCanvasTile = useCallback((repoPath?: string | null, preferredTileId?: string | null) => {
    const normalizedRepoPath = repoPath ?? null;
    const preferredTile = findPreferredCanvasTileId(normalizedRepoPath, preferredTileId);
    if (preferredTile) {
      if (normalizedRepoPath) {
        setCanvasTileRepoScope(preferredTile, normalizedRepoPath);
      }
      setActiveTileId(preferredTile);
      return preferredTile;
    }

    const workspaceTarget = findWorkspaceTarget();
    if (workspaceTarget) {
      setTileLayout((current) => ({
        ...current,
        root: replaceTileContent(current.root, workspaceTarget.id, {
          kind: 'canvas',
          repoPath: normalizedRepoPath,
        }),
      }));
      setActiveTileId(workspaceTarget.id);
      return workspaceTarget.id;
    }

    const targetLeaf = findInsertionTarget(['terminal', 'canvas', 'preview', 'workspace']);
    const result = splitTile(
      tileLayout.root,
      targetLeaf.id,
      'horizontal',
      {
        kind: 'canvas',
        repoPath: normalizedRepoPath,
      },
      0.62,
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
  }, [findInsertionTarget, findPreferredCanvasTileId, findWorkspaceTarget, setActiveTileId, setCanvasTileRepoScope, setTileLayout, tileLayout.root]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const restoreTimer = window.setTimeout(() => {
      const restored = deserializeTileLayout(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY));
      const nextLayout = restored ?? createDefaultTileLayout();
      const storedActiveTileId = window.localStorage.getItem(ACTIVE_TILE_STORAGE_KEY);
      const restoredActiveTileId = storedActiveTileId && findTile(nextLayout.root, storedActiveTileId)
        ? storedActiveTileId
        : getFirstLeaf(nextLayout.root).id;
      setTileLayout(nextLayout);
      setActiveTileId(restoredActiveTileId);
      setTileLayoutHydrated(true);
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, [setActiveTileId, setTileLayout]);

  useEffect(() => {
    if (!tileLayoutHydrated || typeof window === 'undefined') return;
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(tileLayout));
  }, [tileLayout, tileLayoutHydrated]);

  useEffect(() => {
    if (!tileLayoutHydrated || typeof window === 'undefined' || !activeTileId) return;
    if (!findTile(tileLayout.root, activeTileId)) return;
    window.localStorage.setItem(ACTIVE_TILE_STORAGE_KEY, activeTileId);
  }, [activeTileId, tileLayout.root, tileLayoutHydrated]);

  const lastPersistedIdeSurfaceSignatureRef = useRef('');
  useEffect(() => {
    if (!tileLayoutHydrated || typeof window === 'undefined') return;
    const terminalRepoPaths = Array.from(new Set(collectOpenTerminalRepoPaths(tileLayout.root)));
    const activeRepoPath = workspaceTerminalPreferredRepo?.localPath ?? null;
    if (activeRepoPath && !terminalRepoPaths.includes(activeRepoPath)) {
      terminalRepoPaths.push(activeRepoPath);
    }
    const signature = JSON.stringify({
      terminalRepoPaths: [...terminalRepoPaths].sort(),
      activeRepoPath,
    });
    if (lastPersistedIdeSurfaceSignatureRef.current === signature) return;
    lastPersistedIdeSurfaceSignatureRef.current = signature;
    void fetch('/api/panel/ide-surface', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: signature,
    }).catch(() => undefined);
  }, [tileLayout.root, tileLayoutHydrated, workspaceTerminalPreferredRepo?.localPath]);

  const bottomPanelVisible = useMemo(
    () => Boolean(findLeafByContentKind(tileLayout.root, 'contextual-panel')),
    [tileLayout.root],
  );

  const handleCloseTile = useCallback((tileId: string) => {
    // Never close the WorkspaceTerminal tile
    const tile = findTile(tileLayout.root, tileId);
    // Protect the LAST terminal tile — but allow closing extras
    if (tile?.type === 'leaf' && tile.content.kind === 'terminal') {
      const allTerminals = collectLeafContentKinds(tileLayout.root).filter(k => k === 'terminal');
      if (allTerminals.length <= 1) return; // Can't close the last one
    }
    const result = closeTile(tileLayout.root, tileId);
    if (!result.closed) {
      return;
    }
    setTileLayout({
      ...tileLayout,
      root: result.root,
    });
    if (tile?.type === 'leaf' && tile.content.kind === 'canvas') {
      setCanvasStateByTileId((prev) => {
        if (!prev[tileId]) return prev;
        const next = { ...prev };
        delete next[tileId];
        return next;
      });
    }
    if (activeTileId === tileId || (activeTileId && !findTile(result.root, activeTileId))) {
      const sibling = findSiblingLeaf(tileLayout.root, tileId);
      const nextActive = (sibling && findTile(result.root, sibling.id)) ? sibling.id : getFirstLeaf(result.root).id;
      setActiveTileId(nextActive);
    }
  }, [activeTileId, setActiveTileId, setTileLayout, tileLayout]);

  const handleResizeSplit = useCallback((splitId: string, ratio: number) => {
    setTileLayout({
      ...tileLayout,
      root: resizeTile(tileLayout.root, splitId, ratio),
    });
  }, [setTileLayout, tileLayout]);

  const handleSplitTile = useCallback((tileId: string, direction: 'horizontal' | 'vertical') => {
    const ratio = direction === 'vertical' ? 0.55 : 0.62;
    // Split creates the same type: workspace splits → new terminal (chat), contextual splits → new contextual (shell)
    const sourceTile = findTile(tileLayout.root, tileId);
    const sourceKind = sourceTile?.type === 'leaf' ? sourceTile.content.kind : 'workspace';
    const newKind = sourceKind === 'contextual-panel' ? 'contextual-panel' : 'terminal';
    const nextContent = sourceTile?.type === 'leaf'
      && sourceTile.content.kind === 'terminal'
      && newKind === 'terminal'
      ? {
          kind: 'terminal' as const,
          repoPath: null,
          createdFromSplit: true,
        }
      : createTileContent(newKind);
    const result = splitTile(tileLayout.root, tileId, direction, nextContent, ratio);
    if (!result.newTileId) {
      return;
    }
    setTileLayout({
      ...tileLayout,
      root: result.root,
    });
    setActiveTileId(result.newTileId);
  }, [setActiveTileId, setTileLayout, tileLayout]);

  const ensureTileKind = useCallback((
    kind: TileContentKind,
    options?: {
      direction?: 'horizontal' | 'vertical';
      preferredKinds?: TileContentKind[];
      ratio?: number;
      selectedPreviewId?: string | null;
    },
  ) => {
    const existingLeaf = findLeafByContentKind(tileLayout.root, kind);
    if (existingLeaf) {
      if (kind === 'preview' && options?.selectedPreviewId && existingLeaf.content.kind === 'preview') {
        setTileLayout({
          ...tileLayout,
          root: replaceTileContent(tileLayout.root, existingLeaf.id, {
            kind: 'preview',
            selectedPreviewId: options.selectedPreviewId,
          }),
        });
      }
      setActiveTileId(existingLeaf.id);
      return existingLeaf.id;
    }

    if (kind === 'contextual-panel') {
      const result = wrapRootWithSplit(
        tileLayout.root,
        options?.direction ?? 'horizontal',
        createTileContent('contextual-panel'),
        options?.ratio ?? 0.68,
      );
      setTileLayout({
        ...tileLayout,
        root: result.root,
      });
      setActiveTileId(result.newTileId);
      return result.newTileId;
    }

    const workspaceTarget = findWorkspaceTarget();
    if (workspaceTarget) {
      const nextContent = kind === 'preview'
        ? {
          kind: 'preview' as const,
          selectedPreviewId: options?.selectedPreviewId ?? workspacePreviews[0]?.id ?? null,
        }
        : createTileContent(kind);
      setTileLayout({
        ...tileLayout,
        root: replaceTileContent(tileLayout.root, workspaceTarget.id, nextContent),
      });
      setActiveTileId(workspaceTarget.id);
      return workspaceTarget.id;
    }

    const targetLeaf = findInsertionTarget(options?.preferredKinds ?? ['terminal']);
    const nextContent = kind === 'preview'
      ? {
        kind: 'preview' as const,
        selectedPreviewId: options?.selectedPreviewId ?? workspacePreviews[0]?.id ?? null,
      }
      : createTileContent(kind);
    const result = splitTile(
      tileLayout.root,
      targetLeaf.id,
      options?.direction ?? 'horizontal',
      nextContent,
      options?.ratio ?? 0.6,
    );

    if (!result.newTileId) {
      return null;
    }

    setTileLayout({
      ...tileLayout,
      root: result.root,
    });
    setActiveTileId(result.newTileId);
    return result.newTileId;
  }, [findInsertionTarget, findWorkspaceTarget, setActiveTileId, setTileLayout, tileLayout, workspacePreviews]);

  const toggleContextualPanelTile = useCallback(() => {
    const existingLeaf = findLeafByContentKind(tileLayout.root, 'contextual-panel');
    if (existingLeaf) {
      if (countLeaves(tileLayout.root) > 1) {
        handleCloseTile(existingLeaf.id);
      }
      return;
    }
    ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      ratio: 0.68,
    });
  }, [ensureTileKind, handleCloseTile, tileLayout]);

  const handlePreviewDetected = useCallback((preview: DetectedLocalhostPreview) => {
    setWorkspacePreviews((current) => {
      if (current.some((existing) => existing.port === preview.port)) {
        return current;
      }
      return [...current, preview];
    });
    ensureTileKind('preview', {
      direction: 'vertical',
      preferredKinds: ['terminal', 'contextual-panel'],
      ratio: 0.56,
      selectedPreviewId: preview.id,
    });
  }, [ensureTileKind]);

  const handleSelectPreviewTile = useCallback((tileId: string, previewId: string) => {
    const currentTile = findTile(tileLayout.root, tileId);
    if (currentTile?.type !== 'leaf' || currentTile.content.kind !== 'preview') {
      return;
    }
    setTileLayout({
      ...tileLayout,
      root: replaceTileContent(tileLayout.root, tileId, {
        kind: 'preview',
        selectedPreviewId: previewId,
      }),
    });
  }, [setTileLayout, tileLayout]);

  const handleClosePreviewTileItem = useCallback((tileId: string, previewId: string) => {
    const preview = workspacePreviews.find((entry) => entry.id === previewId);
    if (!preview) {
      return;
    }

    const remainingPreviews = workspacePreviews.filter((entry) => entry.id !== previewId);
    setWorkspacePreviews(remainingPreviews);
    for (const handle of workspaceTerminalHandlesRef.current.values()) {
      handle.clearDetectedPreview(preview.port);
    }

    const currentTile = findTile(tileLayout.root, tileId);
    if (currentTile?.type !== 'leaf' || currentTile.content.kind !== 'preview') {
      return;
    }

    const nextSelectedPreviewId = currentTile.content.selectedPreviewId === previewId
      ? remainingPreviews[0]?.id ?? null
      : currentTile.content.selectedPreviewId ?? null;

    setTileLayout({
      ...tileLayout,
      root: replaceTileContent(tileLayout.root, tileId, {
        kind: 'preview',
        selectedPreviewId: nextSelectedPreviewId,
      }),
    });
  }, [setTileLayout, tileLayout, workspacePreviews, workspaceTerminalHandlesRef]);

  useEffect(() => {
    canvasStateByTileIdRef.current = canvasStateByTileId;
  }, [canvasStateByTileId]);

  const resolveCanvasTabRepoPath = useCallback((tab: CanvasTab) => {
    if (tab.kind === 'timeline' || tab.kind === 'welcome' || tab.kind === 'audit-log' || tab.kind === 'mermaid') {
      return null;
    }

    const repoSlug = tab.meta?.repo ?? null;
    if (repoSlug) {
      const matchedRepo = globalRepoEntries.find((repo) => repoSlugFromRemote(repo.remoteUrl) === repoSlug);
      if (matchedRepo) {
        return matchedRepo.localPath;
      }
    }

    const workspacePath = tab.meta?.workspace ?? (tab.kind === 'readme' || tab.kind === 'git-log' ? tab.resourceId : null);
    if (workspacePath) {
      const matchedRepo = globalRepoEntries.find((repo) => (
        workspacePath === repo.localPath
        || workspacePath.startsWith(`${repo.localPath}/`)
      ));
      if (matchedRepo) {
        return matchedRepo.localPath;
      }
    }

    switch (tab.kind) {
      case 'issue':
      case 'pr':
      case 'file':
      case 'diff':
      case 'commit':
      case 'readme':
      case 'ci':
      case 'new-issue':
      case 'git-log':
      case 'image':
        return globalRepoEntry?.localPath ?? null;
      default:
        return null;
    }
  }, [globalRepoEntries, globalRepoEntry]);

  const openCanvasInInspectorTile = useCallback((tab: CanvasTab, repoPath: string | null) => {
    const existingTileEntry = Object.entries(canvasStateByTileId).find(([, state]) => (
      state.tabs.some((entry) => entry.id === tab.id)
    ));
    if (existingTileEntry) {
      const [existingTileId, existingState] = existingTileEntry;
      if (repoPath) {
        setCanvasTileRepoScope(existingTileId, repoPath);
      }
      setActiveTileId(existingTileId);
      setCanvasStateByTileId((prev) => ({
        ...prev,
        [existingTileId]: {
          ...existingState,
          activeTabId: tab.id,
          revealKey: existingState.revealKey + 1,
        },
      }));
      return;
    }

    const targetTileId = ensureCanvasTile(repoPath);
    if (!targetTileId) {
      return;
    }

    setCanvasStateByTileId((prev) => {
      const current = prev[targetTileId] ?? { tabs: [], activeTabId: null, revealKey: 0 };
      const existingIndex = current.tabs.findIndex((entry) => entry.id === tab.id);
      const nextTabs = existingIndex >= 0
        ? current.tabs
        : [...current.tabs, tab];

      return {
        ...prev,
        [targetTileId]: {
          tabs: nextTabs,
          activeTabId: tab.id,
          revealKey: current.revealKey + 1,
        },
      };
    });
  }, [canvasStateByTileId, ensureCanvasTile, setActiveTileId, setCanvasTileRepoScope]);

  const openCanvasTab = useCallback((tab: CanvasTab) => {
    // Route all canvas tabs to workspace tabs — no more Inspector panel
    const repoPath = resolveCanvasTabRepoPath(tab);
    const repoEntry = repoPath
      ? globalRepoEntries.find((repo) => repo.localPath === repoPath) ?? null
      : null;
    void (async () => {
      const workspaceTarget = await waitForWorkspaceTerminalTarget(repoPath ? { repoPath } : {});
      if (workspaceTarget) {
        workspaceTarget.handle.openInspectorTab(tab, {
          repo: repoEntry ? {
            name: repoEntry.name,
            localPath: repoEntry.localPath,
            branch: repoEntry.readiness?.currentBranch ?? repoEntry.defaultBranch,
            readiness: repoEntry.readiness ?? null,
            remoteUrl: repoEntry.remoteUrl ?? undefined,
          } : undefined,
        });
        return;
      }
      // Last resort fallback — should rarely hit since workspace auto-creates
      openCanvasInInspectorTile(tab, repoPath);
    })();
  }, [globalRepoEntries, openCanvasInInspectorTile, resolveCanvasTabRepoPath, waitForWorkspaceTerminalTarget]);

  const closeCanvasTab = useCallback((tileId: string, tabId: string) => {
    setCanvasStateByTileId((prev) => {
      const current = prev[tileId];
      if (!current) return prev;
      const nextTabs = current.tabs.filter((entry) => entry.id !== tabId);
      if (nextTabs.length === 0) {
        const next = { ...prev };
        delete next[tileId];
        return next;
      }
      return {
        ...prev,
        [tileId]: {
          ...current,
          tabs: nextTabs,
          activeTabId: current.activeTabId === tabId ? nextTabs[nextTabs.length - 1]?.id ?? null : current.activeTabId,
        },
      };
    });
  }, []);

  const selectCanvasTab = useCallback((tileId: string, tabId: string) => {
    setCanvasStateByTileId((prev) => {
      const current = prev[tileId];
      if (!current || current.activeTabId === tabId) {
        return prev;
      }
      return {
        ...prev,
        [tileId]: {
          ...current,
          activeTabId: tabId,
        },
      };
    });
  }, []);

  return {
    activeSurfaceRepoPath,
    activeWorkspaceChatTargetKey,
    bottomPanelVisible,
    canvasStateByTileId,
    closeCanvasTab,
    ensureTileKind,
    getPreferredContextualPanelHandle,
    handleClosePreviewTileItem,
    handleCloseTile,
    handlePreviewDetected,
    handleResizeSplit,
    handleSelectPreviewTile,
    handleSplitTile,
    openCanvasTab,
    registerContextualPanelHandle,
    selectCanvasTab,
    setCanvasStateByTileId,
    setTileLayoutHydrated,
    setWorkspacePreviews,
    tileLayoutHydrated,
    toggleContextualPanelTile,
    workspaceChatTargetLabel,
    workspaceChatTargetRepoPath,
    workspacePreviews,
  };
}
