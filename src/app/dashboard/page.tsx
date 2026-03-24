'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps -- dashboard shell is mid-refactor and keeps dormant wiring for upcoming panels */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { DesktopWebSocketProvider, useSharedDesktopWs, type WsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '@/components/desktop/hooks/useDesktopWebSocket';
import type { TerminalHandle } from '@/components/desktop/LiveOutput';
import { WorkspaceTerminal, type TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import { AgentPanel } from '@/components/desktop/AgentPanel';
// WorkspacesPanel merged into AgentPanel — unified agent+workspace view
import { AgentPanelChat } from '@/components/desktop/AgentPanelChat';
import { Canvas, type CanvasTab } from '@/components/desktop/Canvas';
import { UniversalSearch } from '@/components/shared/UniversalSearch';
import { GraphExplorer3D } from '@/components/desktop/GraphExplorer3D';
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import { UpdateBanner } from '@/components/desktop/UpdateBanner';
import { ThemeProvider } from '@/lib/theme/context';
import { AlertTray } from '@/components/shared/AlertTray';
import { AlertToast } from '@/components/shared/AlertToast';
import { NavRail, type NavSection } from '@/components/desktop/NavRail';
import { ContextualPanel, type ContextualPanelHandle } from '@/components/desktop/ContextualPanel';
import { TitleBar } from '@/components/desktop/TitleBar';
import { SessionTimeline } from '@/components/desktop/SessionTimeline';
import { SettingsPage } from '@/components/desktop/SettingsPage';
import { AnalyticsPage } from '@/components/desktop/AnalyticsPage';
import { ThoughtsCard } from '@/components/desktop/ThoughtsCard';
import { SetupWizard, type DetectionResult } from '@/components/desktop/SetupWizard';

/** Normalize the flat API response into the shape SetupWizard expects. */
function normalizeDetection(raw: Record<string, unknown>): DetectionResult {
  const toolsArray = (raw.tools ?? []) as Array<{ id: string; detected: boolean; version?: string; path?: string; details?: Record<string, unknown> }>;
  const findTool = (id: string) => toolsArray.find(t => t.id === id);

  const mkTool = (id: string) => {
    const t = findTool(id);
    return {
      detected: t?.detected ?? false,
      version: t?.version,
      path: t?.path,
      ...(t?.details ?? {}),
    };
  };

  // Build apiKeys array from the api-keys tool details
  const apiKeysTool = findTool('api-keys');
  const rawProviders = (apiKeysTool?.details?.providers ?? []) as Array<string | { provider: string; configured: boolean }>;
  const apiKeys = rawProviders.map(p => {
    if (typeof p === 'string') return { provider: p, configured: true };
    return { provider: p.provider, configured: p.configured };
  });

  return {
    tools: {
      openclaw: {
        ...mkTool('openclaw'),
        // Config exists with version/agents = detected, even if HTTP probe was slow
        detected: (findTool('openclaw')?.detected) || Boolean(findTool('openclaw')?.version) || Boolean(findTool('openclaw')?.details?.configFound),
        agentCount: (findTool('openclaw')?.details?.agentCount as number) ?? 0,
      },
      codex: { ...mkTool('codex'), threads: (findTool('codex')?.details?.threads as number) ?? 0 },
      claudeCode: { ...mkTool('claude-code'), recentSessions: (findTool('claude-code')?.details?.recentSessions as number) ?? 0 },
      gemini: mkTool('gemini'),
      cortex: { ...mkTool('cortex'), facts: (findTool('cortex')?.details?.facts as number) ?? 0, memories: (findTool('cortex')?.details?.memories as number) ?? 0 },
      ollama: { ...mkTool('ollama'), hasEmbeddingModel: (findTool('ollama')?.details?.hasEmbeddingModel as boolean) ?? false },
    } as DetectionResult['tools'],
    apiKeys,
    hasAnything: Boolean(raw.hasAnything),
    hasAgentSurface: Boolean(raw.hasAgentSurface),
    hasCliAgent: Boolean(raw.hasCliAgent),
    hasApiKey: Boolean(raw.hasApiKey),
    hasMemory: Boolean(raw.hasMemory),
    hasEmbeddings: Boolean(raw.hasEmbeddings),
    recommendedPath: String(raw.recommendedPath ?? 'full-wizard'),
    summary: String(raw.summary ?? ''),
  };
}
import { LocalhostPreviewTabs } from '@/components/desktop/LocalhostPreviewTabs';
import { TileContainer, type TileContentRegistry } from '@/components/desktop/TileContainer';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import {
  type DetectedLocalhostPreview,
  formatPreviewSelectionContext,
  type PreviewSelectionPayload,
} from '@/lib/panel/preview';
import {
  closeTile,
  createDefaultTileLayout,
  createTileContent,
  deserializeTileLayout,
  findLeafByContentKind,
  findTile,
  getFirstLeaf,
  replaceTileContent,
  resizeTile,
  serializeTileLayout,
  countLeaves,
  splitTile,
} from '@/lib/tiles/operations';
import type { TileContentKind, TileLayout, TileLeafNode } from '@/lib/tiles/types';

const TILE_LAYOUT_STORAGE_KEY = 'cortex-ide:dashboard-tiles:v1';

export default function DashboardPage() {
  return (
    <ThemeProvider>
      <AlertProvider>
        <DesktopWebSocketProvider>
          <DashboardInner />
        </DesktopWebSocketProvider>
      </AlertProvider>
    </ThemeProvider>
  );
}

function DashboardInner() {
  const initialTileLayout = useMemo(() => createDefaultTileLayout(), []);

  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(420);
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>();
  const [liveOutputCollapsed, setLiveOutputCollapsed] = useState(false);
  const [dashTermSession, setDashTermSession] = useState<string | null>(null);
  const termCreatedRef = useRef(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const termWorkspaceRef = useRef<TerminalTabHandle>(null);
  const bottomTermRef = useRef<ContextualPanelHandle>(null);
  const [agentsJson, setAgentsJson] = useState('[]');
  const [activeWorkspace, setActiveWorkspace] = useState<string | undefined>();
  const [showMemoryView, setShowMemoryView] = useState(false);
  const [alertTrayOpen, setAlertTrayOpen] = useState(false);
  const [activeNavSection, setActiveNavSection] = useState<NavSection>('agents');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [chatVisible, setChatVisible] = useState(true);
  const [thoughtsOpen, setThoughtsOpen] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsConnectionState>('connecting');
  const [workspacePreviews, setWorkspacePreviews] = useState<DetectedLocalhostPreview[]>([]);
  const [tileLayout, setTileLayout] = useState<TileLayout>(initialTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>(getFirstLeaf(initialTileLayout.root).id);
  const [tileLayoutHydrated, setTileLayoutHydrated] = useState(false);

  // ── Setup wizard state ──
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [setupDetection, setSetupDetection] = useState<DetectionResult | null>(null);
  const setupCheckedRef = useRef(false);

  useEffect(() => {
    if (setupCheckedRef.current) return;
    setupCheckedRef.current = true;
    (async () => {
      try {
        const configRes = await fetch('/api/setup/config');
        if (!configRes.ok) return;
        const config = await configRes.json();
        if (config.completedAt) return; // Already completed setup
        const detectRes = await fetch('/api/setup/detect');
        if (!detectRes.ok) return;
        const rawDetection = await detectRes.json() as Record<string, unknown>;
        // Normalize: API returns tools as array, wizard expects named object + apiKeys array
        const detection = normalizeDetection(rawDetection);
        setSetupDetection(detection);
        setSetupWizardOpen(true);
      } catch { /* silent — don't block dashboard */ }
    })();
  }, []);

  const handleSetupComplete = useCallback(async () => {
    setSetupWizardOpen(false);
    try {
      await fetch('/api/setup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completedAt: new Date().toISOString() }),
      });
    } catch { /* silent */ }
  }, []);

  // Global repo state (shared between TitleBar and AgentPanel)
  const [globalRepo, setGlobalRepo] = useState<string | null>(null);
  const [globalRepoBranch, setGlobalRepoBranch] = useState<string>('main');
  const [globalRepoList, setGlobalRepoList] = useState<string[]>([]);
  // No hardcoded repos — start empty, user adds repos
  const REPO_DISPLAY: Record<string, string> = {};

  // Fetch registered repos on mount — but don't auto-select
  useEffect(() => {
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => {
        const repos = (data.repos ?? []).map((r: { remoteUrl?: string }) => {
          const url = (r.remoteUrl ?? '').replace(/\.git$/, '');
          const parts = url.split('/');
          return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
        }).filter(Boolean) as string[];
        setGlobalRepoList(repos);
        // Only restore if user previously selected one
        const saved = typeof window !== 'undefined' ? sessionStorage.getItem('cortex-global-repo') : null;
        if (saved && repos.includes(saved)) setGlobalRepo(saved);
        // Otherwise leave null — show "Open Folder" prompt
      })
      .catch(() => {
        setGlobalRepoList([]);
      });
  }, []);

  // Fetch branch when globalRepo changes
  useEffect(() => {
    if (!globalRepo) return;
    if (typeof window !== 'undefined') sessionStorage.setItem('cortex-global-repo', globalRepo);
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => {
        const repo = (data.repos ?? []).find((r: { remoteUrl?: string }) => {
          const url = (r.remoteUrl ?? '').replace(/\.git$/, '');
          return url.includes(globalRepo);
        });
        if (repo?.localPath) {
          fetch(`/api/panel/branches?path=${encodeURIComponent(repo.localPath)}`)
            .then(r => r.json())
            .then(bData => {
              const current = (bData.branches ?? []).find((b: { current: boolean }) => b.current);
              if (current) setGlobalRepoBranch(current.name);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [globalRepo]);
  const [lifecycleEvents, setLifecycleEvents] = useState<Map<string, { state: string; exitCode?: number; ts: number }>>(new Map());
  const [desktopDraftInjection, setDesktopDraftInjection] = useState<{ id: string; text: string } | null>(null);
  const [thoughtsDraftInjection, setThoughtsDraftInjection] = useState<{ id: string; text: string } | null>(null);

  // Terminal WS hook — routes events to WorkspaceTerminal + ContextualPanel
  const terminalWsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onTerminalCreated: (sessionName: string, requestId?: string) => {
      setDashTermSession(sessionName);
      // Route to ContextualPanel first — if it claims, skip WorkspaceTerminal
      const claimed = bottomTermRef.current?.onSessionCreated(sessionName, requestId);
      if (!claimed) {
        termWorkspaceRef.current?.onSessionCreated(sessionName, requestId);
      }
    },
    onTerminalData: (sessionName: string, data: string) => {
      terminalRef.current?.writeToTerminal(data);
      termWorkspaceRef.current?.writeToTerminal(sessionName, data);
      bottomTermRef.current?.writeToTerminal(sessionName, data);
    },
    onTerminalError: (sessionName: string, error: string) => {
      terminalRef.current?.setTermError(error);
      termWorkspaceRef.current?.setTermError(sessionName, error);
      bottomTermRef.current?.setTermError(sessionName, error);
    },
    onTerminalExited: (sessionName: string, _exitCode: number) => {
      terminalRef.current?.setTermExited(true);
      termWorkspaceRef.current?.setTermExited(sessionName);
      bottomTermRef.current?.setTermExited(sessionName);
    },
    onTerminalImage: (sessionName: string, imageB64: string, filename: string) => {
      termWorkspaceRef.current?.showImage(sessionName, imageB64, filename);
      bottomTermRef.current?.showImage(sessionName, imageB64, filename);
    },
    onAgentLifecycle: (sessionName: string, state: string, exitCode?: number) => {
      setLifecycleEvents(prev => {
        const next = new Map(prev);
        next.set(sessionName, { state, exitCode, ts: Date.now() });
        return next;
      });
    },
  }), []);

  const {
    isConnected: termWsConnected,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
    sendAgentKill,
  } = useSharedDesktopWs(undefined, terminalWsCallbacks);

  // Terminal auto-creation now handled by WorkspaceTerminal component

  // ── Alert system ──
  const {
    alerts: activeAlerts,
    unreadCount,
    markRead,
    markAllRead,
    dismiss,
    dismissAll,
    updateAgents,
  } = useAlerts();

  // ── Cmd+J to toggle Thoughts Card ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable = Boolean(
        target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]'),
      );
      if (isEditable) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setThoughtsOpen(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Tile layout persistence + helpers ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const restoreTimer = window.setTimeout(() => {
      const restored = deserializeTileLayout(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY));
      const nextLayout = restored ?? createDefaultTileLayout();
      setTileLayout(nextLayout);
      setActiveTileId(getFirstLeaf(nextLayout.root).id);
      setTileLayoutHydrated(true);
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    if (!tileLayoutHydrated || typeof window === 'undefined') return;
    window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, serializeTileLayout(tileLayout));
  }, [tileLayout, tileLayoutHydrated]);

  const bottomPanelVisible = useMemo(
    () => Boolean(findLeafByContentKind(tileLayout.root, 'contextual-panel')),
    [tileLayout.root],
  );
  const hasThoughtsTile = useMemo(
    () => Boolean(findLeafByContentKind(tileLayout.root, 'thoughts')),
    [tileLayout.root],
  );

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

  const handleCloseTile = useCallback((tileId: string) => {
    // Never close the WorkspaceTerminal tile
    const tile = findTile(tileLayout.root, tileId);
    if (tile?.type === 'leaf' && tile.content.kind === 'terminal') {
      return; // Protected — cannot close
    }
    const result = closeTile(tileLayout.root, tileId);
    if (!result.closed) {
      return;
    }
    setTileLayout({
      ...tileLayout,
      root: result.root,
    });
    const nextActive = getFirstLeaf(result.root).id;
    if (activeTileId === tileId || (activeTileId && !findTile(result.root, activeTileId))) {
      setActiveTileId(nextActive);
    }
  }, [activeTileId, tileLayout]);

  const handleResizeSplit = useCallback((splitId: string, ratio: number) => {
    setTileLayout({
      ...tileLayout,
      root: resizeTile(tileLayout.root, splitId, ratio),
    });
  }, [tileLayout]);

  const handleSplitTile = useCallback((tileId: string, direction: 'horizontal' | 'vertical') => {
    const ratio = direction === 'vertical' ? 0.55 : 0.62;
    // Split creates the same type: workspace splits → new terminal (chat), contextual splits → new contextual (shell)
    const sourceTile = findTile(tileLayout.root, tileId);
    const sourceKind = sourceTile?.type === 'leaf' ? sourceTile.content.kind : 'workspace';
    const newKind = sourceKind === 'contextual-panel' ? 'contextual-panel' : 'terminal';
    const result = splitTile(tileLayout.root, tileId, direction, createTileContent(newKind), ratio);
    if (!result.newTileId) {
      return;
    }
    setTileLayout({
      ...tileLayout,
      root: result.root,
    });
    setActiveTileId(result.newTileId);
  }, [tileLayout]);

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
  }, [findInsertionTarget, findWorkspaceTarget, tileLayout, workspacePreviews]);

  const toggleContextualPanelTile = useCallback(() => {
    const existingLeaf = findLeafByContentKind(tileLayout.root, 'contextual-panel');
    if (existingLeaf) {
      // Only close if there's a workspace terminal tile that will remain visible
      const terminalTile = findLeafByContentKind(tileLayout.root, 'terminal');
      if (terminalTile && countLeaves(tileLayout.root) > 1) {
        handleCloseTile(existingLeaf.id);
      }
      return;
    }
    // Always split from the terminal tile (top/bottom split)
    const terminalTile = findLeafByContentKind(tileLayout.root, 'terminal');
    if (terminalTile) {
      const result = splitTile(tileLayout.root, terminalTile.id, 'horizontal', createTileContent('contextual-panel'), 0.68);
      if (result.newTileId) {
        setTileLayout({ ...tileLayout, root: result.root });
        setActiveTileId(result.newTileId);
      }
    }
  }, [handleCloseTile, tileLayout, setTileLayout]);

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
  }, [tileLayout]);

  const handleClosePreviewTileItem = useCallback((tileId: string, previewId: string) => {
    const preview = workspacePreviews.find((entry) => entry.id === previewId);
    if (!preview) {
      return;
    }

    const remainingPreviews = workspacePreviews.filter((entry) => entry.id !== previewId);
    setWorkspacePreviews(remainingPreviews);
    termWorkspaceRef.current?.clearDetectedPreview(preview.port);

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
  }, [tileLayout, workspacePreviews]);

  // ── Canvas tab state ──
  const [canvasTabs, setCanvasTabs] = useState<CanvasTab[]>([]);
  const [activeCanvasTabId, setActiveCanvasTabId] = useState<string | null>(null);

  const openCanvasTab = useCallback((tab: CanvasTab) => {
    // Canvas tabs open inside the ContextualPanel (bottom panel)
    ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'preview'],
      ratio: 0.68,
    });
    console.log('[Canvas] openCanvasTab called:', tab.kind, tab.id);
    setCanvasTabs((prev) => {
      const existing = prev.find((t) => t.id === tab.id);
      if (existing) {
        console.log('[Canvas] tab already exists, just activating');
        return prev;
      }
      console.log('[Canvas] adding new tab, total:', prev.length + 1);
      return [...prev, tab];
    });
    setActiveCanvasTabId(tab.id);
  }, [ensureTileKind]);

  const closeCanvasTab = useCallback((tabId: string) => {
    setCanvasTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      // If we closed the active tab, activate the last remaining tab
      setActiveCanvasTabId((currentActive) => {
        if (currentActive === tabId) {
          return next.length > 0 ? next[next.length - 1].id : null;
        }
        return currentActive;
      });
      return next;
    });
  }, []);

  // ── Routing callbacks for AgentPanel ──
  const handleSelectSession = useCallback((sessionKey: string) => {
    // Agent clicks only change the chat session — terminal is independent
    setActiveSessionKey(sessionKey);
  }, []);

  const handleSelectIssue = useCallback((issueNumber: number, repo?: string) => {
    openCanvasTab({
      id: `issue:${issueNumber}${repo ? `:${repo}` : ''}`,
      kind: 'issue',
      label: `#${issueNumber}`,
      resourceId: String(issueNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleSelectPR = useCallback((prNumber: number, repo?: string) => {
    openCanvasTab({
      id: `pr:${prNumber}${repo ? `:${repo}` : ''}`,
      kind: 'pr',
      label: `PR #${prNumber}`,
      resourceId: String(prNumber),
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleExpandWorkspace = useCallback((workspace: string, repo: string | null) => {
    setActiveWorkspace(workspace);
    // Only open README tab if workspace actually has a README
    fetch(`/api/panel/readme?workspace=${encodeURIComponent(workspace)}`)
      .then(res => res.json())
      .then(data => {
        if (data.content) {
          openCanvasTab({
            id: `readme:${workspace}`,
            kind: 'readme',
            label: 'README',
            resourceId: workspace,
            meta: repo ? { repo } : undefined,
          });
        }
      })
      .catch(() => { /* no README, skip */ });
  }, [openCanvasTab]);

  const handleOpenGitLog = useCallback((workspace?: string) => {
    openCanvasTab({
      id: `git-log:${workspace ?? 'default'}`,
      kind: 'git-log',
      label: 'Git Log',
      resourceId: workspace ?? '',
    });
  }, [openCanvasTab]);

  const handleOpenMemory = useCallback(() => {
    setShowMemoryView(true);
  }, []);

  const handlePreviewSelection = useCallback((selection: PreviewSelectionPayload) => {
    const payload: AgentPanelChatInjectionPayload = {
      reason: 'preview',
      text: formatPreviewSelectionContext(selection),
    };
    setChatVisible(true);
    setDesktopDraftInjection({
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
    });
  }, []);

  const handleAgentPanelChatInjection = useCallback((payload: AgentPanelChatInjectionPayload) => {
    const nextInjection = {
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
    };
    if (thoughtsOpen) {
      setThoughtsDraftInjection(nextInjection);
      return;
    }
    if (hasThoughtsTile) {
      setThoughtsDraftInjection(nextInjection);
      return;
    }
    setChatVisible(true);
    setDesktopDraftInjection(nextInjection);
  }, [hasThoughtsTile, thoughtsOpen]);

  // ── Feed agent data to alert engine + search ──
  const handleAgentsUpdate = useCallback((agents: unknown[]) => {
    // AgentDetail from AgentPanel is compatible with AgentSummary for alert detection
    // (has id, name, status, context, approvalStatus, lastEventAt, sessionKey)
    updateAgents(agents as import('@/lib/fleet/types').AgentSummary[]);
    setAgentsJson(JSON.stringify(agents));
  }, [updateAgents]);

  // ── Run command in bottom terminal ──
  const handleRunInTerminal = useCallback((command: string) => {
    ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'contextual-panel', 'preview'],
      ratio: 0.68,
    });
    bottomTermRef.current?.runCommand(command);
  }, [ensureTileKind]);

  // ── Alert action: navigate to agent session ──
  const handleAlertAction = useCallback((alert: import('@/lib/alerts/types').Alert) => {
    if (alert.sessionKey) {
      setActiveSessionKey(alert.sessionKey);
    }
    setAlertTrayOpen(false);
  }, []);

  const handleOpenDeploy = useCallback((project?: string) => {
    openCanvasTab({
      id: `deploy:${project ?? 'all'}`,
      kind: 'deploy',
      label: 'Deploys',
      resourceId: project ?? '',
      meta: project ? { project } : undefined,
    });
  }, [openCanvasTab]);

  const handleOpenCI = useCallback((repo: string) => {
    openCanvasTab({
      id: `ci:${repo}`,
      kind: 'ci',
      label: `CI`,
      resourceId: repo,
      meta: { repo },
    });
  }, [openCanvasTab]);

  const handleCreateIssue = useCallback((repo?: string) => {
    openCanvasTab({
      id: `new-issue:${repo ?? 'default'}:${Date.now()}`,
      kind: 'new-issue',
      label: 'New Issue',
      resourceId: 'new',
      meta: repo ? { repo } : undefined,
    });
  }, [openCanvasTab]);

  const handleSelectFile = useCallback((filePath: string, workspace?: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext);

    openCanvasTab({
      id: `${isImage ? 'image' : 'file'}:${filePath}${workspace ? `:${workspace}` : ''}`,
      kind: isImage ? 'image' : 'file',
      label: filePath.split('/').pop() ?? filePath,
      resourceId: filePath,
      meta: workspace ? { workspace } : undefined,
    });
  }, [openCanvasTab]);

  const handleSelectCommit = useCallback((hash: string) => {
    openCanvasTab({
      id: `commit:${hash}`,
      kind: 'commit',
      label: hash.slice(0, 7),
      resourceId: hash,
    });
  }, [openCanvasTab]);

  // ── Left drag handle ──
  const startLeftDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) => {
      setLeftWidth(Math.min(Math.max(startW + (ev.clientX - startX), 220), 500));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [leftWidth]);

  // ── Right drag handle ──
  const startRightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    const onMove = (ev: MouseEvent) => {
      setRightWidth(Math.min(Math.max(startW + (startX - ev.clientX), 320), 600));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [rightWidth]);

  const parsedAgents = useMemo(
    () => JSON.parse(agentsJson) as Parameters<typeof ThoughtsCard>[0]['agents'],
    [agentsJson],
  );

  const tileRegistry = useMemo<TileContentRegistry>(() => ({
    workspace: {
      label: 'Workspace',
      description: 'Empty workspace pane that will pick up the next canvas, preview, or terminal panel you open.',
      render: ({ active }) => (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          background: 'linear-gradient(180deg, rgba(6,10,18,0.98) 0%, rgba(12,18,30,0.98) 100%)',
          color: '#e2e8f0',
        }}>
          <div style={{
            width: 48,
            height: 48,
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(148,163,184,0.08)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: active ? 'rgba(96,165,250,0.26)' : 'rgba(148,163,184,0.12)',
            marginBottom: 14,
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </div>
          <div style={{
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            marginBottom: 6,
          }}>
            Empty workspace
          </div>
          <div style={{
            maxWidth: 320,
            textAlign: 'center',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'rgba(226,232,240,0.72)',
            marginBottom: 16,
          }}>
            Split first, then open a preview, issue, or bottom terminal. Cortex will route it into the active workspace pane automatically.
          </div>
          <button
            type="button"
            onClick={() => {
              window.localStorage.removeItem(TILE_LAYOUT_STORAGE_KEY);
              setTileLayout(createDefaultTileLayout());
              setTileLayoutHydrated(true);
            }}
            style={{
              padding: '8px 20px',
              borderRadius: 8,
              border: '1px solid rgba(96,165,250,0.3)',
              background: 'rgba(96,165,250,0.08)',
              color: '#93c5fd',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reset Layout
          </button>
        </div>
      ),
    },
    terminal: {
      label: 'Workspace Terminal',
      description: 'Multi-tab terminal and chat workspace for active sessions.',
      singleton: true,
      closable: false, // WorkspaceTerminal must NEVER be closable
      render: () => (
        <WorkspaceTerminal
          ref={termWorkspaceRef}
          sendTerminalCreate={sendTerminalCreate}
          sendTerminalAttach={sendTerminalAttach}
          sendTerminalInput={sendTerminalInput}
          sendTerminalResize={sendTerminalResize}
          sendTerminalDetach={sendTerminalDetach}
          termWsConnected={termWsConnected}
          onPreviewDetected={handlePreviewDetected}
          onPreviewSelection={handlePreviewSelection}
          showPreviewPane={false}
        />
      ),
    },
    preview: {
      label: 'Preview',
      description: 'Tabbed localhost previews detected from the workspace terminal.',
      singleton: true,
      render: ({ content, tileId }) => (
        <LocalhostPreviewTabs
          previews={workspacePreviews}
          selectedPreviewId={content.kind === 'preview' ? content.selectedPreviewId ?? null : null}
          onSelectPreview={(previewId) => handleSelectPreviewTile(tileId, previewId)}
          onClosePreview={(previewId) => handleClosePreviewTileItem(tileId, previewId)}
          onElementSelect={handlePreviewSelection}
        />
      ),
    },
    // Legacy — canvas tabs now render inside ContextualPanel
    canvas: {
      label: 'Canvas (Legacy)',
      description: 'Redirects to ContextualPanel',
      singleton: true,
      render: () => <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-faint)' }}>Canvas merged into Contextual Panel</div>,
    },
    thoughts: {
      label: 'Thoughts',
      description: 'Docked command surface for tasks, approvals, and fast agent chat.',
      singleton: true,
      render: ({ tileId }) => (
        <ThoughtsCard
          open
          docked
          onClose={() => handleCloseTile(tileId)}
          agents={parsedAgents}
          draftInjection={!thoughtsOpen ? thoughtsDraftInjection : null}
        />
      ),
    },
    'contextual-panel': {
      label: 'Contextual Panel',
      description: 'Single focused terminal with a CLI picker for quick command execution.',
      singleton: true,
      render: ({ tileId }) => (
        <ContextualPanel
          ref={bottomTermRef}
          sendTerminalCreate={sendTerminalCreate}
          sendTerminalAttach={sendTerminalAttach}
          sendTerminalInput={sendTerminalInput}
          sendTerminalResize={sendTerminalResize}
          sendTerminalDetach={sendTerminalDetach}
          sendAgentKill={sendAgentKill}
          termWsConnected={termWsConnected}
          canvasTabs={canvasTabs}
          activeCanvasTabId={activeCanvasTabId}
          onSelectCanvasTab={setActiveCanvasTabId}
          onCloseCanvasTab={closeCanvasTab}
          onInjectChatContext={handleAgentPanelChatInjection}
          onSelectCommit={handleSelectCommit}
          onClose={() => handleCloseTile(tileId)}
        />
      ),
    },
  }), [
    activeCanvasTabId,
    canvasTabs,
    closeCanvasTab,
    handleClosePreviewTileItem,
    handleCloseTile,
    handleAgentPanelChatInjection,
    handlePreviewDetected,
    handlePreviewSelection,
    handleSelectCommit,
    handleSelectPreviewTile,
    parsedAgents,
    sendAgentKill,
    sendTerminalAttach,
    sendTerminalCreate,
    sendTerminalDetach,
    sendTerminalInput,
    sendTerminalResize,
    termWsConnected,
    thoughtsDraftInjection,
    thoughtsOpen,
    workspacePreviews,
  ]);

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--t-bg)',
      color: 'var(--t-text)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
      overflow: 'hidden',
    }}>
      {/* ── Update Banner ── */}
      <UpdateBanner currentVersion="0.1.0" />

      {/* ── Title Bar ── */}
      <TitleBar
        globalRepo={globalRepo}
        globalRepoBranch={globalRepoBranch}
        repoList={globalRepoList}
        repoDisplayNames={REPO_DISPLAY}
        onRepoChange={setGlobalRepo}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible(v => !v)}
        bottomPanelVisible={bottomPanelVisible}
        onToggleBottomPanel={toggleContextualPanelTile}
        chatVisible={chatVisible}
        onToggleChat={() => setChatVisible(v => !v)}
        wsStatus={wsStatus}
        renderSearch={(onClose) => (
          <UniversalSearch
            variant="desktop"
            workspace={activeWorkspace}
            agentsJson={agentsJson}
            onSelectSession={(sessionKey) => { setActiveSessionKey(sessionKey); onClose(); }}
            onSelectIssue={(num) => { handleSelectIssue(num); onClose(); }}
            onSelectFile={(filePath, line) => {
              openCanvasTab({
                id: `file:${filePath}${activeWorkspace ? `:${activeWorkspace}` : ''}`,
                kind: 'file',
                label: filePath.split('/').pop() ?? filePath,
                resourceId: filePath,
                meta: {
                  ...(activeWorkspace ? { workspace: activeWorkspace } : {}),
                  ...(line ? { line: String(line) } : {}),
                },
              });
              onClose();
            }}
            onClose={onClose}
          />
        )}
      />

      {/* ── Session Timeline ── */}
      <SessionTimeline onExpand={() => {
        openCanvasTab({
          id: 'timeline:session',
          kind: 'timeline',
          label: 'Session Replay',
          resourceId: 'session',
        });
      }} />

      {/* ── Main Layout (horizontal) ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
        minHeight: 0, // critical: allow flex children to shrink for scroll
      }}>
      {/* ── Nav Rail + Left Panel ── */}
      {sidebarVisible && <NavRail
        activeSection={activeNavSection}
        onSectionChange={(section) => {
          setActiveNavSection(section);
          // Always show chat when switching nav sections
          if (!chatVisible) setChatVisible(true);
          if (section === 'memory') setShowMemoryView(true);
          else setShowMemoryView(false);
          if (section === 'terminal') {
            // Show the contextual panel if not already visible
            const existing = findLeafByContentKind(tileLayout.root, 'contextual-panel');
            if (!existing) {
              toggleContextualPanelTile();
            }
          }
        }}
        alertCount={unreadCount}
        onAlertClick={() => setAlertTrayOpen(!alertTrayOpen)}
        alertTray={(
          <AlertTray
            alerts={activeAlerts}
            open={alertTrayOpen}
            onClose={() => setAlertTrayOpen(false)}
            onMarkRead={markRead}
            onMarkAllRead={markAllRead}
            onDismiss={dismiss}
            onDismissAll={dismissAll}
            onAction={handleAlertAction}
            variant="desktop"
          />
        )}
        thoughtsOpen={thoughtsOpen}
        onThoughtsToggle={() => setThoughtsOpen(v => !v)}
        onPortPreview={(port, url, repo) => {
          const previewId = `preview-${port}`;
          setWorkspacePreviews((current) => {
            if (current.some((preview) => preview.id === previewId)) {
              return current;
            }
            return [
              ...current,
              {
                id: previewId,
                tabId: '',
                url,
                port,
                detectedAt: Date.now(),
              },
            ];
          });
          ensureTileKind('preview', {
            direction: 'vertical',
            preferredKinds: ['terminal', 'contextual-panel'],
            ratio: 0.56,
            selectedPreviewId: previewId,
          });
        }}
      />}

      {/* ── Left: Agent Panel ── */}
      {sidebarVisible && <div style={{
        width: leftWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRight: '1px solid var(--t-divider)',
        position: 'relative',
      }}>
        <AgentPanel
          onSelectSession={handleSelectSession}
          onSelectIssue={handleSelectIssue}
          onSelectCommit={handleSelectCommit}
          onSelectPR={handleSelectPR}
          onExpandWorkspace={handleExpandWorkspace}
          onSelectFile={handleSelectFile}
          onOpenCI={handleOpenCI}
          onCreateIssue={handleCreateIssue}
          onOpenGitLog={handleOpenGitLog}
          onOpenDeploy={handleOpenDeploy}
          onOpenMemory={handleOpenMemory}
          onAgentsUpdate={handleAgentsUpdate}
          onAgentKill={sendAgentKill}
          lifecycleEvents={lifecycleEvents}
        />
      </div>}

      {/* ── Left drag handle ── */}
      {sidebarVisible && <div
        onMouseDown={startLeftDrag}
        style={{
          width: 6,
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div style={{
          width: 3,
          height: 40,
          borderRadius: 2,
          backgroundColor: 'var(--t-drag-handle)',
          transition: 'background-color 150ms',
        }} />
      </div>}

      {/* ── Center: Workspace Surface ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        minWidth: 0,
      }}>
        {activeNavSection === 'settings' && !showMemoryView && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <SettingsPage />
          </div>
        )}

        {activeNavSection === 'analytics' && !showMemoryView && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <AnalyticsPage />
          </div>
        )}

        {showMemoryView && (
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setShowMemoryView(false)}
              style={{
                position: 'absolute',
                bottom: 14,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 100,
                paddingTop: 6,
                paddingRight: 14,
                paddingBottom: 6,
                paddingLeft: 14,
                borderRadius: 8,
                border: '1px solid rgba(148,163,184,0.15)',
                background: 'rgba(10, 14, 26, 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                color: '#94a3b8',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              ← Back to Workspace
            </button>
            <GraphExplorer3D />
          </div>
        )}

        {!showMemoryView && activeNavSection !== 'settings' && activeNavSection !== 'analytics' && (
          <TileContainer
            layout={tileLayout}
            activeTileId={activeTileId}
            registry={tileRegistry}
            onActivateTile={setActiveTileId}
            onCloseTile={handleCloseTile}
            onResizeSplit={handleResizeSplit}
            onSplitTile={handleSplitTile}
          />
        )}
      </div>

      {/* ── Right drag handle ── */}
      {chatVisible && <div
        onMouseDown={startRightDrag}
        style={{
          width: 6,
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          zIndex: 10,
        }}
      >
        <div style={{
          width: 3,
          height: 40,
          borderRadius: 2,
          backgroundColor: 'var(--t-drag-handle)',
          transition: 'background-color 150ms',
        }} />
      </div>}

      {/* ── Right: Chat Sidebar ── */}
      {chatVisible && <div style={{
        width: rightWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderLeft: '1px solid var(--t-divider)',
      }}>
        <AgentPanelChat
          externalSessionKey={activeSessionKey}
          draftInjection={desktopDraftInjection}
          onOpenDiff={() => {
            openCanvasTab({
              id: 'diff:workspace',
              kind: 'diff',
              label: 'Diff',
              resourceId: 'workspace',
            });
          }}
          onOpenMermaid={(code) => {
            openCanvasTab({
              id: `mermaid:${code.slice(0, 40)}`,
              kind: 'mermaid',
              label: 'Diagram',
              resourceId: code,
            });
          }}
          onOpenFile={handleSelectFile}
          onRunInTerminal={handleRunInTerminal}
          onWsStatusChange={setWsStatus}
        />
      </div>}

      {/* ── Alert Toast (desktop only — urgent alerts slide in bottom-left near bell) ── */}
      <AlertToast alerts={activeAlerts} onAction={handleAlertAction} />
      </div>{/* end main layout */}

      {/* ── Thoughts Card (floating overlay — sits on top of everything) ── */}
      <ThoughtsCard
        open={thoughtsOpen}
        onClose={() => setThoughtsOpen(false)}
        agents={parsedAgents}
        draftInjection={thoughtsOpen ? thoughtsDraftInjection : null}
      />

      {/* ── First Launch Setup Wizard ── */}
      {setupWizardOpen && setupDetection && (
        <SetupWizard detection={setupDetection} onComplete={handleSetupComplete} />
      )}
    </div>
  );
}
