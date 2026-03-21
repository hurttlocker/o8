'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps -- dashboard shell is mid-refactor and keeps dormant wiring for upcoming panels */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { DesktopWebSocketProvider, useSharedDesktopWs, type WsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '@/components/desktop/hooks/useDesktopWebSocket';
import type { TerminalHandle } from '@/components/desktop/LiveOutput';
import { TerminalWorkspace, type TerminalTabHandle } from '@/components/desktop/TerminalWorkspace';
import { AgentPanel } from '@/components/desktop/AgentPanel';
// WorkspacesPanel merged into AgentPanel — unified agent+workspace view
import { DesktopChat } from '@/components/desktop/DesktopChat';
import { Canvas, CanvasTab } from '@/components/desktop/Canvas';
import { UniversalSearch } from '@/components/shared/UniversalSearch';
import { GraphExplorer3D } from '@/components/desktop/GraphExplorer3D';
import { AlertProvider, useAlerts } from '@/lib/alerts/context';
import { ThemeProvider } from '@/lib/theme/context';
import { AlertBell } from '@/components/shared/AlertBell';
import { AlertTray } from '@/components/shared/AlertTray';
import { AlertToast } from '@/components/shared/AlertToast';
import { NavRail, type NavSection } from '@/components/desktop/NavRail';
import { BottomTerminal, type BottomTerminalHandle } from '@/components/desktop/BottomTerminal';
import { TitleBar } from '@/components/desktop/TitleBar';
import { SessionTimeline } from '@/components/desktop/SessionTimeline';
import { IntentCanvas } from '@/components/desktop/IntentCanvas';
import { SettingsPage } from '@/components/desktop/SettingsPage';
import { AnalyticsPage } from '@/components/desktop/AnalyticsPage';
import { ThoughtsCard } from '@/components/desktop/ThoughtsCard';
import { SetupWizard, type DetectionResult } from '@/components/desktop/SetupWizard';
import { LocalhostPreviewTabs } from '@/components/desktop/LocalhostPreviewTabs';
import { TileContainer, type TileContentRegistry } from '@/components/desktop/TileContainer';
import type { DesktopChatInjectionPayload } from '@/lib/chat/injection';
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
  const bottomTermRef = useRef<BottomTerminalHandle>(null);
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
        const detection = await detectRes.json() as DetectionResult;
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
  const REPO_DISPLAY: Record<string, string> = {
    'hurttlocker/cortex-ide': 'Cortex IDE',
    'hurttlocker/cortex': 'Cortex',
    'hurttlocker/sleeping-beauties': 'Copy Trade',
  };

  // Fetch repos for picker on mount
  useEffect(() => {
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => {
        const repos = (data.repos ?? []).map((r: { remoteUrl?: string }) => {
          const url = (r.remoteUrl ?? '').replace(/\.git$/, '');
          const parts = url.split('/');
          return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
        }).filter(Boolean) as string[];
        const list = repos.length > 0 ? repos : Object.keys(REPO_DISPLAY);
        setGlobalRepoList(list);
        // Auto-select first or restore from sessionStorage
        const saved = typeof window !== 'undefined' ? sessionStorage.getItem('cortex-global-repo') : null;
        if (saved && list.includes(saved)) setGlobalRepo(saved);
        else if (list.length > 0) setGlobalRepo(list[0]);
      })
      .catch(() => {
        const list = Object.keys(REPO_DISPLAY);
        setGlobalRepoList(list);
        if (list.length > 0) setGlobalRepo(list[0]);
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

  // Terminal WS hook — routes events to TerminalWorkspace + BottomTerminal
  const terminalWsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onTerminalCreated: (sessionName: string) => {
      setDashTermSession(sessionName);
      // Route to BottomTerminal first — if it claims, skip TerminalWorkspace
      const claimed = bottomTermRef.current?.onSessionCreated(sessionName);
      if (!claimed) {
        termWorkspaceRef.current?.onSessionCreated(sessionName);
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

  // Terminal auto-creation now handled by TerminalWorkspace component

  // ── Alert system ──
  const {
    alerts: activeAlerts,
    unreadCount,
    urgentCount,
    hasUnread,
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
    () => Boolean(findLeafByContentKind(tileLayout.root, 'bottom-terminal')),
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
    const result = splitTile(tileLayout.root, tileId, direction, createTileContent('workspace'), ratio);
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

  const toggleBottomTerminalTile = useCallback(() => {
    const existingLeaf = findLeafByContentKind(tileLayout.root, 'bottom-terminal');
    if (existingLeaf) {
      handleCloseTile(existingLeaf.id);
      return;
    }
    ensureTileKind('bottom-terminal', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'canvas', 'preview'],
      ratio: 0.68,
    });
  }, [ensureTileKind, handleCloseTile, tileLayout.root]);

  const handlePreviewDetected = useCallback((preview: DetectedLocalhostPreview) => {
    setWorkspacePreviews((current) => {
      if (current.some((existing) => existing.port === preview.port)) {
        return current;
      }
      return [...current, preview];
    });
    ensureTileKind('preview', {
      direction: 'vertical',
      preferredKinds: ['terminal', 'canvas'],
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
    ensureTileKind('canvas', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'preview'],
      ratio: 0.62,
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
    const payload: DesktopChatInjectionPayload = {
      reason: 'preview',
      text: formatPreviewSelectionContext(selection),
    };
    setChatVisible(true);
    setDesktopDraftInjection({
      id: `${payload.reason}-${Date.now()}`,
      text: payload.text,
    });
  }, []);

  const handleDesktopChatInjection = useCallback((payload: DesktopChatInjectionPayload) => {
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
    ensureTileKind('bottom-terminal', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'canvas', 'preview'],
      ratio: 0.68,
    });
    // Send to BottomTerminal's session if ready, otherwise wait for it
    const session = bottomTermRef.current?.getSession();
    if (session) {
      sendTerminalInput(session, command + '\n');
    } else {
      // Terminal not ready yet — retry after a short delay
      setTimeout(() => {
        const s = bottomTermRef.current?.getSession();
        if (s) sendTerminalInput(s, command + '\n');
      }, 1500);
    }
  }, [ensureTileKind, sendTerminalInput]);

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
          }}>
            Split first, then open a preview, issue, or bottom terminal. Cortex will route it into the active workspace pane automatically.
          </div>
        </div>
      ),
    },
    terminal: {
      label: 'Terminal Workspace',
      description: 'Multi-tab terminal and chat workspace for active sessions.',
      singleton: true,
      render: () => (
        <TerminalWorkspace
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
    canvas: {
      label: 'Canvas',
      description: 'Issues, diffs, transcripts, files, deploys, and timeline tabs.',
      singleton: true,
      render: () => (
        <Canvas
          tabs={canvasTabs}
          activeTabId={activeCanvasTabId}
          onSelectTab={setActiveCanvasTabId}
          onCloseTab={closeCanvasTab}
          onInjectChatContext={handleDesktopChatInjection}
          onSelectCommit={handleSelectCommit}
        />
      ),
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
    'bottom-terminal': {
      label: 'Bottom Terminal',
      description: 'Single focused terminal with a CLI picker for quick command execution.',
      singleton: true,
      render: ({ tileId }) => (
        <BottomTerminal
          ref={bottomTermRef}
          sendTerminalCreate={sendTerminalCreate}
          sendTerminalAttach={sendTerminalAttach}
          sendTerminalInput={sendTerminalInput}
          sendTerminalResize={sendTerminalResize}
          sendTerminalDetach={sendTerminalDetach}
          sendAgentKill={sendAgentKill}
          termWsConnected={termWsConnected}
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
    handleDesktopChatInjection,
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
        onToggleBottomPanel={toggleBottomTerminalTile}
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
          if (section === 'memory') setShowMemoryView(true);
          else setShowMemoryView(false);
          if (section === 'terminal') {
            ensureTileKind('bottom-terminal', {
              direction: 'horizontal',
              preferredKinds: ['terminal', 'canvas', 'preview'],
              ratio: 0.68,
            });
          }
        }}
        alertCount={unreadCount}
        onAlertClick={() => setAlertTrayOpen(!alertTrayOpen)}
        onSearchClick={() => setSearchOpen(true)}
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
            preferredKinds: ['terminal', 'canvas'],
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
        {activeNavSection === 'intent' && !showMemoryView && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <IntentCanvas />
          </div>
        )}

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

        {!showMemoryView && activeNavSection !== 'intent' && activeNavSection !== 'settings' && activeNavSection !== 'analytics' && (
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
        <DesktopChat
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
