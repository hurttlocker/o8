'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- dashboard shell is mid-refactor and keeps dormant wiring for upcoming panels */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { DesktopWebSocketProvider, useSharedDesktopWs, type WsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '@/components/desktop/hooks/useDesktopWebSocket';
import type { TerminalHandle } from '@/components/desktop/LiveOutput';
import { WorkspaceTerminal, type TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import { AgentPanel } from '@/components/desktop/AgentPanel';
// WorkspacesPanel merged into AgentPanel — unified agent+workspace view
import { AgentPanelChat } from '@/components/desktop/AgentPanelChat';
import { Canvas, type CanvasTab } from '@/components/desktop/Canvas';
import { UniversalSearch, type CommandPaletteAction, type CommandPaletteStateTone } from '@/components/shared/UniversalSearch';
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
import { SettingsPage, type SettingsTab } from '@/components/desktop/SettingsPage';
import { AnalyticsPage } from '@/components/desktop/AnalyticsPage';
import { ThoughtsCard } from '@/components/desktop/ThoughtsCard';
import { SetupWizard, type DetectionResult } from '@/components/desktop/SetupWizard';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import { FOCUS_REPO_SETUP_EVENT, OPEN_REPO_WORKSPACE_EVENT } from '@/lib/desktop/events';
import { deriveWorkflowStage, describeWorkflowStage, type WorkflowStageBadge } from '@/lib/workflows/status';

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

function repoSlugFromRemote(remoteUrl?: string | null) {
  const url = (remoteUrl ?? '').replace(/\.git$/, '');
  const parts = url.split('/');
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

interface PaletteAgentSummary {
  id: string;
  name: string;
  status?: string;
  currentTask?: string;
  sessionKey: string;
  alerts?: number;
  isCurrentSession?: boolean;
  lastEventAt?: string;
  workspace?: string;
  branch?: string;
  workspaceStatus?: string;
  lifecycleState?: string;
  workflowStage?: WorkflowStageBadge | null;
  runtime?: string;
  repoReadiness?: RepoReadiness;
  pr?: {
    number: number;
    title: string;
    state?: 'open' | 'merged' | 'closed';
    url?: string;
  };
  runtimeSurface?: {
    lifecycle?: {
      availability?: string;
      summary?: string;
    };
    reviewContext?: {
      repoSlug?: string | null;
    };
  };
  worktree?: WorktreeInfo | null;
}

interface RepoWorktreeSummary {
  worktrees: WorktreeInfo[];
  conflicts: {
    safe: boolean;
    count: number;
  };
  totalDiskUsage: number;
}

function repoSlugFromAgent(agent?: PaletteAgentSummary | null) {
  return agent?.runtimeSurface?.reviewContext?.repoSlug?.trim() || null;
}

function parseIssueNumber(value?: string | null) {
  const match = value?.match(/\bIssue #(\d+)\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

function readinessTone(state?: RepoReadiness['state'] | null): CommandPaletteStateTone {
  if (state === 'ready') return 'green';
  if (state === 'needs_setup') return 'amber';
  if (state === 'blocked') return 'red';
  return 'slate';
}

function workflowTone(label?: string | null): CommandPaletteStateTone {
  if (label === 'Merge ready') return 'green';
  if (label === 'Working') return 'green';
  if (label === 'Reviewing') return 'purple';
  if (label === 'Waiting') return 'slate';
  if (label === 'Blocked') return 'red';
  return 'blue';
}

function paletteWorkflowLabel(agent: PaletteAgentSummary) {
  const workflow = deriveWorkflowStage({
    runtimeStatus: agent.status ?? null,
    workspaceStatus: agent.workspaceStatus ?? null,
    lifecycleState: agent.lifecycleState ?? null,
    latestText: agent.currentTask ?? agent.runtimeSurface?.lifecycle?.summary ?? '',
    lastActivityAt: agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : null,
    hasMessages: Boolean(agent.currentTask?.trim()),
    readinessState: agent.repoReadiness?.state ?? null,
  });

  return workflow?.label ?? 'Ready';
}

function attentionRank(status: string) {
  if (status === 'Needs setup') return 470;
  if (status === 'Blocked') return 500;
  if (status === 'Reviewing') return 420;
  if (status === 'Merge ready') return 360;
  if (status === 'Waiting') return 260;
  if (status === 'Ready') return 180;
  return 0;
}

function formatAttentionDetail(agent: PaletteAgentSummary) {
  const stage = deriveWorkflowStage({
    runtimeStatus: agent.status ?? null,
    workspaceStatus: agent.workspaceStatus ?? null,
    lifecycleState: agent.lifecycleState ?? null,
    latestText: agent.currentTask ?? agent.runtimeSurface?.lifecycle?.summary ?? '',
    lastActivityAt: agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : null,
    hasMessages: Boolean(agent.currentTask?.trim()),
    readinessState: agent.repoReadiness?.state ?? null,
  });
  const guidance = describeWorkflowStage({
    stage,
    runtimeStatus: agent.status ?? null,
    workspaceStatus: agent.workspaceStatus ?? null,
    lifecycleState: agent.lifecycleState ?? null,
    latestText: agent.currentTask ?? agent.runtimeSurface?.lifecycle?.summary ?? '',
    lastActivityAt: agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : null,
    hasMessages: Boolean(agent.currentTask?.trim()),
    readinessState: agent.repoReadiness?.state ?? null,
    readinessSummary: agent.repoReadiness?.summary ?? null,
    readinessNextAction: agent.repoReadiness?.nextAction ?? null,
  });
  return guidance.nextAction ? `${guidance.detail} ${guidance.nextAction}` : guidance.detail;
}

function repoReadinessDetail(entry: RepoRegistryEntry) {
  if (!entry.readiness) {
    return `Saved setup for ${entry.name} is not loaded yet.`;
  }
  return entry.readiness.nextAction
    ? `${entry.readiness.summary} ${entry.readiness.nextAction}`
    : entry.readiness.summary;
}

function formatBytes(value?: number | null) {
  if (!value || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx += 1;
  }
  return `${size >= 10 || unitIdx === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIdx]}`;
}

function repoWorktreeDetail(summary: RepoWorktreeSummary | null) {
  if (!summary) return 'No tracked worktrees yet.';
  const activeCount = summary.worktrees.filter((worktree) => ['ready', 'active', 'setup', 'creating'].includes(worktree.status)).length;
  const staleCount = summary.worktrees.filter((worktree) => worktree.status === 'stale').length;
  const parts = [
    `${summary.worktrees.length} worktree${summary.worktrees.length === 1 ? '' : 's'}`,
    `${activeCount} active`,
  ];
  if (staleCount > 0) parts.push(`${staleCount} stale`);
  if (summary.conflicts.count > 0) parts.push(`${summary.conflicts.count} conflict${summary.conflicts.count === 1 ? '' : 's'}`);
  if (summary.totalDiskUsage > 0) parts.push(formatBytes(summary.totalDiskUsage));
  return parts.join(' · ');
}

function worktreeStageLabel(status?: WorktreeInfo['status'] | null) {
  if (status === 'creating' || status === 'setup' || status === 'cleaning') return 'Waiting';
  if (status === 'stale') return 'Blocked';
  if (status === 'ready') return 'Ready';
  if (status === 'active') return 'Working';
  if (status === 'merging') return 'Reviewing';
  return 'Ready';
}

function worktreeStageTone(status?: WorktreeInfo['status'] | null): CommandPaletteStateTone {
  if (status === 'creating' || status === 'setup' || status === 'cleaning') return 'amber';
  if (status === 'stale') return 'red';
  if (status === 'ready') return 'blue';
  if (status === 'active') return 'green';
  if (status === 'merging') return 'purple';
  return 'blue';
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
  collectLeafContentKinds,
  countLeaves,
  splitTile,
  wrapRootWithSplit,
} from '@/lib/tiles/operations';
import type { TileContentKind, TileLayout, TileLeafNode } from '@/lib/tiles/types';

const TILE_LAYOUT_STORAGE_KEY = 'cortex-ide:dashboard-tiles:v1';
const DEFAULT_LEFT_PANEL_WIDTH = 332;
const DEFAULT_RIGHT_PANEL_WIDTH = 468;
const MIN_RIGHT_PANEL_WIDTH = 360;
const MAX_RIGHT_PANEL_WIDTH = 600;

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

  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_PANEL_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>();
  const [liveOutputCollapsed, setLiveOutputCollapsed] = useState(false);
  const [dashTermSession, setDashTermSession] = useState<string | null>(null);
  const termCreatedRef = useRef(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const workspaceTerminalHandlesRef = useRef<Map<string, TerminalTabHandle>>(new Map());
  const contextualPanelHandlesRef = useRef<Map<string, ContextualPanelHandle>>(new Map());
  const [agentsJson, setAgentsJson] = useState('[]');
  const [activeWorkspace, setActiveWorkspace] = useState<string | undefined>();
  const [showMemoryView, setShowMemoryView] = useState(false);
  const [alertTrayOpen, setAlertTrayOpen] = useState(false);
  const [activeNavSection, setActiveNavSection] = useState<NavSection>('agents');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('connectors');
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
  const [globalRepoId, setGlobalRepoId] = useState<string | null>(null);
  const [globalRepoBranch, setGlobalRepoBranch] = useState<string>('main');
  const [globalRepoEntries, setGlobalRepoEntries] = useState<RepoRegistryEntry[]>([]);
  const globalRepoEntry = useMemo(
    () => globalRepoEntries.find((repo) => repo.id === globalRepoId) ?? null,
    [globalRepoEntries, globalRepoId],
  );
  const globalRepo = useMemo(
    () => repoSlugFromRemote(globalRepoEntry?.remoteUrl),
    [globalRepoEntry],
  );
  const [selectedRepoWorktrees, setSelectedRepoWorktrees] = useState<RepoWorktreeSummary | null>(null);
  const [selectedRepoWorktreesLoading, setSelectedRepoWorktreesLoading] = useState(false);
  const [selectedRepoWorktreeRefreshNonce, setSelectedRepoWorktreeRefreshNonce] = useState(0);

  const refreshSelectedRepoWorktrees = useCallback(async () => {
    if (!globalRepoEntry?.localPath) {
      setSelectedRepoWorktrees(null);
      return;
    }
    setSelectedRepoWorktreesLoading(true);
    try {
      const response = await fetch(`/api/worktrees?repo=${encodeURIComponent(globalRepoEntry.localPath)}`);
      const data = await response.json() as RepoWorktreeSummary & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load worktree summary.');
      }
      setSelectedRepoWorktrees(data);
    } catch {
      setSelectedRepoWorktrees(null);
    } finally {
      setSelectedRepoWorktreesLoading(false);
    }
  }, [globalRepoEntry?.localPath]);

  const loadRegisteredRepos = useCallback(async () => {
    const response = await fetch('/api/panel/repos');
    const data = await response.json() as { repos?: RepoRegistryEntry[] };
    const repos = data.repos ?? [];
    setGlobalRepoEntries(repos);
    return repos;
  }, []);

  // Fetch registered repos on mount — but don't auto-select
  useEffect(() => {
    loadRegisteredRepos()
      .then((repos) => {
        const savedId = typeof window !== 'undefined' ? sessionStorage.getItem('cortex-global-repo-id') : null;
        if (savedId && repos.some((repo) => repo.id === savedId)) {
          setGlobalRepoId(savedId);
        }
        // Otherwise leave null — show "Open Folder" prompt
      })
      .catch(() => {
        setGlobalRepoEntries([]);
      });
  }, [loadRegisteredRepos]);

  const handleSelectRegisteredRepo = useCallback(async (repoId: string | null) => {
    setGlobalRepoId(repoId);
    if (!repoId) {
      setGlobalRepoBranch('main');
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('cortex-global-repo-id');
      }
      return;
    }

    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoId);
    }

    const selected = globalRepoEntries.find((repo) => repo.id === repoId) ?? null;
    if (!selected) return;

    setGlobalRepoBranch(selected.defaultBranch || 'main');

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoId }),
    })
      .then(async (response) => {
        const data = await response.json() as { repo?: RepoRegistryEntry };
        if (data.repo) {
          setGlobalRepoEntries((current) => {
            const next = current.map((repo) => (repo.id === data.repo?.id ? data.repo : repo));
            return next;
          });
        }
      })
      .catch(() => null);
  }, [globalRepoEntries]);

  const handleRemoveRegisteredRepo = useCallback(async (repoId: string) => {
    const target = globalRepoEntries.find((repo) => repo.id === repoId);
    if (!target) return;

    const confirmed = window.confirm(
      `Remove ${target.name} from Cortex?\n\nThis only removes it from the local repo list. It does not delete the folder on disk.`,
    );
    if (!confirmed) return;

    const response = await fetch('/api/panel/repos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: repoId }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      throw new Error(data.error ?? 'Unable to remove repository.');
    }

    setGlobalRepoEntries((current) => current.filter((repo) => repo.id !== repoId));
    if (globalRepoId === repoId) {
      setGlobalRepoId(null);
      setGlobalRepoBranch('main');
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('cortex-global-repo-id');
      }
    }
  }, [globalRepoEntries, globalRepoId]);

  // Fetch branch when selected repo changes
  useEffect(() => {
    if (!globalRepoEntry?.localPath) return;
    fetch(`/api/panel/branches?path=${encodeURIComponent(globalRepoEntry.localPath)}`)
      .then(r => r.json())
      .then(bData => {
        const current = (bData.branches ?? []).find((b: { current: boolean; name: string }) => b.current);
        if (current?.name) setGlobalRepoBranch(current.name);
      })
      .catch(() => {});
  }, [globalRepoEntry]);

  useEffect(() => {
    void refreshSelectedRepoWorktrees();
    if (!globalRepoEntry?.localPath) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refreshSelectedRepoWorktrees();
    }, 30_000);
    return () => window.clearInterval(intervalId);
  }, [globalRepoEntry?.localPath, refreshSelectedRepoWorktrees, selectedRepoWorktreeRefreshNonce]);

  const handleOpenFolder = useCallback(async () => {
    let folderPath: string | null = null;

    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ directory: true, title: 'Select project folder' });
      if (typeof result === 'string') folderPath = result;
    } catch {
      try {
        const response = await fetch('/api/panel/browse-folder', { method: 'POST' });
        const data = await response.json() as { path?: string | null };
        if (data.path) folderPath = data.path;
      } catch {
        folderPath = window.prompt('Enter folder path:');
      }
    }

    if (!folderPath) return;

    try {
      const response = await fetch('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath: folderPath }),
      });
      const data = await response.json() as {
        error?: string;
        repo?: RepoRegistryEntry;
      };

      if (!response.ok || !data.repo) {
        throw new Error(data.error ?? 'Unable to add repository.');
      }

      const repos = await loadRegisteredRepos();
      const selected = repos.find((repo) => repo.id === data.repo?.id) ?? data.repo;
      setGlobalRepoId(selected.id);
      if (data.repo.defaultBranch) {
        setGlobalRepoBranch(data.repo.defaultBranch);
      }
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('cortex-global-repo-id', selected.id);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to open folder.');
    }
  }, [loadRegisteredRepos]);

  const handleOpenSettingsTab = useCallback((tab: SettingsTab) => {
    setShowMemoryView(false);
    setSettingsInitialTab(tab);
    setActiveNavSection('settings');
  }, []);

  const focusRepoSetup = useCallback((repoEntry: RepoRegistryEntry) => {
    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }
    setShowMemoryView(false);
    setSidebarVisible(true);
    setActiveNavSection('agents');

    const dispatch = () => {
      window.dispatchEvent(new CustomEvent(FOCUS_REPO_SETUP_EVENT, {
        detail: {
          repoId: repoEntry.id,
          repoPath: repoEntry.localPath,
        },
      }));
    };

    if (sidebarVisible) {
      dispatch();
      return;
    }

    window.setTimeout(dispatch, 120);
  }, [sidebarVisible]);

  const handleFocusCurrentRepoSetup = useCallback(() => {
    if (!globalRepoEntry) {
      throw new Error('Select a repository before opening its setup profile.');
    }
    focusRepoSetup(globalRepoEntry);
  }, [focusRepoSetup, globalRepoEntry]);

  const openRepoWorkspaceModal = useCallback((repoEntry: RepoRegistryEntry) => {
    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }
    setShowMemoryView(false);
    setSidebarVisible(true);
    setActiveNavSection('agents');

    const dispatch = () => {
      window.dispatchEvent(new CustomEvent(OPEN_REPO_WORKSPACE_EVENT, {
        detail: {
          repoId: repoEntry.id,
          repoPath: repoEntry.localPath,
        },
      }));
    };

    if (sidebarVisible) {
      dispatch();
      return;
    }

    window.setTimeout(dispatch, 120);
  }, [sidebarVisible]);

  const handleOpenRepoInDesktop = useCallback(async (editor: 'finder' | 'terminal') => {
    if (!globalRepoEntry?.localPath) {
      throw new Error('Select a repository before opening it outside Cortex.');
    }

    const response = await fetch('/api/panel/open-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editor, repo: globalRepoEntry.localPath }),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Unable to open the repo in ${editor}.`);
    }
  }, [globalRepoEntry]);
  const [lifecycleEvents, setLifecycleEvents] = useState<Map<string, { state: string; exitCode?: number; ts: number }>>(new Map());
  const [desktopDraftInjection, setDesktopDraftInjection] = useState<{ id: string; text: string } | null>(null);
  const [thoughtsDraftInjection, setThoughtsDraftInjection] = useState<{ id: string; text: string } | null>(null);

  const registerWorkspaceTerminalHandle = useCallback((tileId: string, handle: TerminalTabHandle | null) => {
    if (handle) {
      workspaceTerminalHandlesRef.current.set(tileId, handle);
      return;
    }
    workspaceTerminalHandlesRef.current.delete(tileId);
  }, []);

  const registerContextualPanelHandle = useCallback((tileId: string, handle: ContextualPanelHandle | null) => {
    if (handle) {
      contextualPanelHandlesRef.current.set(tileId, handle);
      return;
    }
    contextualPanelHandlesRef.current.delete(tileId);
  }, []);

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
  }, [activeTileId]);

  const getPreferredWorkspaceTerminalTarget = useCallback((preferredTileId?: string | null) => {
    if (preferredTileId) {
      const preferredHandle = workspaceTerminalHandlesRef.current.get(preferredTileId);
      if (preferredHandle) {
        return { tileId: preferredTileId, handle: preferredHandle };
      }
    }
    if (activeTileId) {
      const activeHandle = workspaceTerminalHandlesRef.current.get(activeTileId);
      if (activeHandle) {
        return { tileId: activeTileId, handle: activeHandle };
      }
    }
    const firstEntry = workspaceTerminalHandlesRef.current.entries().next().value as [string, TerminalTabHandle] | undefined;
    return firstEntry ? { tileId: firstEntry[0], handle: firstEntry[1] } : null;
  }, [activeTileId]);

  // Terminal WS hook — routes events to WorkspaceTerminal + ContextualPanel
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
  }, [findInsertionTarget, findWorkspaceTarget, tileLayout, workspacePreviews]);

  const waitForWorkspaceTerminalTarget = useCallback(async (preferredTileId?: string | null) => {
    const initial = getPreferredWorkspaceTerminalTarget(preferredTileId);
    if (initial) {
      setActiveTileId(initial.tileId);
      return initial;
    }

    const ensuredTileId = ensureTileKind('terminal', {
      preferredKinds: ['terminal', 'workspace'],
      direction: 'vertical',
      ratio: 0.58,
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      const target = getPreferredWorkspaceTerminalTarget((ensuredTileId ?? preferredTileId) ?? undefined);
      if (target) {
        setActiveTileId(target.tileId);
        return target;
      }
    }

    return null;
  }, [ensureTileKind, getPreferredWorkspaceTerminalTarget]);

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
  }, [tileLayout]);

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
  }, [tileLayout, workspacePreviews]);

  // ── Canvas tab state ──
  const [canvasTabs, setCanvasTabs] = useState<CanvasTab[]>([]);
  const [activeCanvasTabId, setActiveCanvasTabId] = useState<string | null>(null);
  const [canvasRevealKey, setCanvasRevealKey] = useState(0);

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
    setCanvasRevealKey((current) => current + 1);
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
    void (async () => {
      const workspaceTarget = await waitForWorkspaceTerminalTarget();
      if (workspaceTarget) {
        workspaceTarget.handle.injectIntoCliChat(payload.text, {
          repo: globalRepoEntry
            ? {
                name: globalRepoEntry.name,
                localPath: globalRepoEntry.localPath,
                remoteUrl: globalRepoEntry.remoteUrl ?? undefined,
              }
            : undefined,
        });
        return;
      }
      setChatVisible(true);
      setDesktopDraftInjection(nextInjection);
    })();
  }, [globalRepoEntry, hasThoughtsTile, thoughtsOpen, waitForWorkspaceTerminalTarget]);

  // ── Feed agent data to alert engine + search ──
  const handleAgentsUpdate = useCallback((agents: unknown[]) => {
    // AgentDetail from AgentPanel is compatible with AgentSummary for alert detection
    // (has id, name, status, context, approvalStatus, lastEventAt, sessionKey)
    updateAgents(agents as import('@/lib/fleet/types').AgentSummary[]);
    setAgentsJson(JSON.stringify(agents));
  }, [updateAgents]);

  // ── Run command in bottom terminal ──
  const handleRunInTerminal = useCallback((command: string) => {
    const tileId = ensureTileKind('contextual-panel', {
      direction: 'horizontal',
      preferredKinds: ['terminal', 'contextual-panel', 'preview'],
      ratio: 0.68,
    });
    const runCommand = (attempt = 0) => {
      const handle = getPreferredContextualPanelHandle(tileId);
      if (handle) {
        handle.runCommand(command);
        return;
      }
      if (attempt < 8) {
        window.setTimeout(() => runCommand(attempt + 1), 50);
      }
    };
    runCommand();
  }, [ensureTileKind, getPreferredContextualPanelHandle]);

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

  const handleLaunchWorkspaceAgent = useCallback(async (request: {
    repoPath: string;
    runtime?: 'codex' | 'claude-code';
    modelId?: string;
    initialText?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
  }) => {
    const repos = globalRepoEntries.length > 0 ? globalRepoEntries : await loadRegisteredRepos();
    const repoEntry = repos.find((repo) => repo.localPath === request.repoPath);

    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repoPath}. Open the repo locally before launching work there.`);
    }

    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoEntry.id }),
    }).catch(() => null);

    const workspaceTarget = await waitForWorkspaceTerminalTarget();
    if (!workspaceTarget) {
      throw new Error('No workspace terminal is available to launch the CLI session.');
    }

    workspaceTarget.handle.openCliChatSession({
      runtime: request.runtime,
      repo: {
        name: repoEntry.name,
        localPath: repoEntry.localPath,
        remoteUrl: repoEntry.remoteUrl ?? undefined,
      },
      modelId: request.modelId,
      initialText: request.initialText,
      autoSend: request.autoSend,
      createNew: request.createNew ?? true,
      label: request.label,
    });
  }, [globalRepoEntries, loadRegisteredRepos, waitForWorkspaceTerminalTarget]);

  const handleLaunchWorkspaceRepoTask = useCallback(async (request: {
    kind: 'issue' | 'pr';
    repo: string;
    number: number;
    title: string;
    body?: string;
    branch?: string;
  }) => {
    const response = await fetch('/api/panel/repos');
    const data = await response.json() as { repos?: RepoRegistryEntry[] };
    const repoEntry = (data.repos ?? []).find((repo) => repoSlugFromRemote(repo.remoteUrl) === request.repo);

    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repo}. Open the repo locally before launching work there.`);
    }

    setGlobalRepoId(repoEntry.id);
    setGlobalRepoBranch(repoEntry.defaultBranch || 'main');
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cortex-global-repo-id', repoEntry.id);
    }

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoEntry.id }),
    }).catch(() => null);

    const workspaceTarget = await waitForWorkspaceTerminalTarget();
    if (!workspaceTarget) {
      throw new Error('No workspace terminal is available to launch the CLI session.');
    }

    let currentBranch = repoEntry.defaultBranch || 'main';
    try {
      const branchResponse = await fetch(`/api/panel/branches?path=${encodeURIComponent(repoEntry.localPath)}`);
      const branchData = await branchResponse.json() as { branches?: Array<{ name: string; current: boolean }> };
      const current = (branchData.branches ?? []).find((branch) => branch.current);
      if (current?.name) currentBranch = current.name;
    } catch {
      // keep default branch fallback
    }

    const effectiveBranch = repoEntry.readiness?.currentBranch ?? currentBranch;
    const readinessLines = [
      repoEntry.readiness
        ? `Readiness: ${repoEntry.readiness.label} — ${repoEntry.readiness.summary}`
        : 'Readiness: unknown',
      `Local checkout: ${repoEntry.localPath}`,
      `Current branch: ${effectiveBranch}`,
      `Default branch: ${repoEntry.defaultBranch}`,
      effectiveBranch === repoEntry.defaultBranch
        ? 'You are operating directly on the default branch right now.'
        : `You are not on the default branch; the current local branch is ${effectiveBranch}.`,
      repoEntry.setup.installCommand
        ? `Install command: ${repoEntry.setup.installCommand}${repoEntry.setup.installOnCreateWorkspace ? ' (saved as default setup)' : ''}`
        : 'Install command: none saved',
      repoEntry.setup.buildCommand
        ? `Build command: ${repoEntry.setup.buildCommand}${repoEntry.setup.runBuildOnCreateWorkspace ? ' (saved for bootstrap)' : ''}`
        : 'Build command: none saved',
      repoEntry.setup.devCommand
        ? `Dev command: ${repoEntry.setup.devCommand}${repoEntry.setup.defaultPort ? ` on port ${repoEntry.setup.defaultPort}` : ''}`
        : 'Dev command: none saved',
      repoEntry.setup.envFiles.length > 0
        ? `Env files: ${repoEntry.setup.envFiles.join(', ')} (mode: ${repoEntry.setup.envMode})`
        : 'Env files: none saved',
      repoEntry.readiness?.nextAction
        ? `Next readiness action: ${repoEntry.readiness.nextAction}`
        : null,
    ];

    const prompt = request.kind === 'issue'
      ? [
          `Work on GitHub issue #${request.number} in ${request.repo}: ${request.title}.`,
          'Use this workspace CLI session as the operator surface.',
          'Start by using the issue context included below and inspecting the current local repo state.',
          'Do not rely on `gh issue view`, GitHub GraphQL, or other remote issue fetches unless the provided issue context is clearly missing something critical.',
          'Before coding, establish whether this repo is actually runnable from this checkout using the saved setup/dev commands and the current branch state below.',
          'If the repo is not ready, say exactly what is missing or broken before you implement anything.',
          'Implement the smallest correct fix, validate it with focused checks, and do not claim success unless the relevant path actually works end to end.',
          'If a runtime/dev-server blocker prevents validation, stop and report the blocker explicitly instead of assuming the feature works.',
          `Repo readiness context:\n${readinessLines.join('\n')}`,
          request.body ? `Issue context:\n${request.body}` : null,
        ].filter(Boolean).join('\n\n')
      : [
          `Review GitHub PR #${request.number} in ${request.repo}: ${request.title}.`,
          `Head branch: ${request.branch ?? 'unknown'}.`,
          'Use this workspace CLI session as the review surface.',
          'Before signing off, establish whether this checkout is runnable and note any setup/runtime blockers using the readiness context below.',
          'Read the PR context and changed files, validate the change locally, identify risks or regressions, and state clearly if the branch cannot be verified end to end.',
          `Repo readiness context:\n${readinessLines.join('\n')}`,
        ].join('\n\n');

    const taskLabel = request.kind === 'issue'
      ? `Issue #${request.number}`
      : `PR #${request.number} review`;

    workspaceTarget.handle.openCliChatSession({
      runtime: undefined,
      repo: {
        name: repoEntry.name,
        localPath: repoEntry.localPath,
        remoteUrl: repoEntry.remoteUrl ?? undefined,
      },
      modelId: undefined,
      initialText: prompt,
      autoSend: true,
      createNew: true,
      label: taskLabel,
    });
  }, [waitForWorkspaceTerminalTarget]);

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
      setRightWidth(Math.min(Math.max(startW + (startX - ev.clientX), MIN_RIGHT_PANEL_WIDTH), MAX_RIGHT_PANEL_WIDTH));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [rightWidth]);

  const parsedAgents = useMemo(() => {
    try {
      return JSON.parse(agentsJson) as Parameters<typeof ThoughtsCard>[0]['agents'];
    } catch {
      return [] as Parameters<typeof ThoughtsCard>[0]['agents'];
    }
  }, [agentsJson]);

  const paletteAgents = useMemo(() => parsedAgents as unknown as PaletteAgentSummary[], [parsedAgents]);
  const selectedSessionAgent = useMemo(
    () => paletteAgents.find((agent) => agent.sessionKey === activeSessionKey)
      ?? paletteAgents.find((agent) => agent.isCurrentSession)
      ?? null,
    [activeSessionKey, paletteAgents],
  );
  const scopedRepoAgents = useMemo(
    () => paletteAgents.filter((agent) => {
      const repoSlug = repoSlugFromAgent(agent);
      return Boolean(globalRepo && repoSlug === globalRepo);
    }),
    [globalRepo, paletteAgents],
  );
  const currentReviewAgent = useMemo(() => {
    const seen = new Set<string>();
    const candidates = [selectedSessionAgent, ...scopedRepoAgents].filter((agent): agent is PaletteAgentSummary => {
      if (!agent || seen.has(agent.sessionKey)) return false;
      seen.add(agent.sessionKey);
      return true;
    });

    return candidates.find((agent) => {
      const repoSlug = repoSlugFromAgent(agent) || globalRepo;
      return Boolean(repoSlug && agent.pr?.number && agent.pr.state !== 'closed');
    }) ?? null;
  }, [globalRepo, scopedRepoAgents, selectedSessionAgent]);
  const currentIssueTarget = useMemo(() => {
    const seen = new Set<string>();
    const candidates = [selectedSessionAgent, ...scopedRepoAgents].filter((agent): agent is PaletteAgentSummary => {
      if (!agent || seen.has(agent.sessionKey)) return false;
      seen.add(agent.sessionKey);
      return true;
    });

    for (const agent of candidates) {
      const issueNumber = parseIssueNumber(agent.currentTask);
      const repoSlug = repoSlugFromAgent(agent) || globalRepo;
      if (issueNumber && repoSlug) {
        return {
          number: issueNumber,
          repo: repoSlug,
          title: agent.currentTask?.trim() || `Issue #${issueNumber}`,
        };
      }
    }

    return null;
  }, [globalRepo, scopedRepoAgents, selectedSessionAgent]);
  const selectedSessionWorktree = selectedSessionAgent?.worktree ?? null;
  const staleSelectedRepoWorktrees = useMemo(
    () => (selectedRepoWorktrees?.worktrees ?? []).filter((worktree) => worktree.status === 'stale'),
    [selectedRepoWorktrees],
  );
  const paletteActions = useMemo<CommandPaletteAction[]>(() => {
    const actions: CommandPaletteAction[] = [];
    const workflowContextAgent = currentReviewAgent ?? selectedSessionAgent ?? scopedRepoAgents[0] ?? null;
    const workflowContextStage = workflowContextAgent
      ? deriveWorkflowStage({
          runtimeStatus: workflowContextAgent.status ?? null,
          workspaceStatus: workflowContextAgent.workspaceStatus ?? null,
          lifecycleState: workflowContextAgent.lifecycleState ?? null,
          latestText: workflowContextAgent.currentTask ?? workflowContextAgent.runtimeSurface?.lifecycle?.summary ?? '',
          lastActivityAt: workflowContextAgent.lastEventAt ? new Date(workflowContextAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(workflowContextAgent.currentTask?.trim()),
          readinessState: workflowContextAgent.repoReadiness?.state ?? globalRepoEntry?.readiness?.state ?? null,
        })
      : deriveWorkflowStage({
          readinessState: globalRepoEntry?.readiness?.state ?? null,
          latestText: '',
        });
    const workflowContextGuidance = describeWorkflowStage({
      stage: workflowContextStage,
      runtimeStatus: workflowContextAgent?.status ?? null,
      workspaceStatus: workflowContextAgent?.workspaceStatus ?? null,
      lifecycleState: workflowContextAgent?.lifecycleState ?? null,
      latestText: workflowContextAgent?.currentTask ?? workflowContextAgent?.runtimeSurface?.lifecycle?.summary ?? '',
      lastActivityAt: workflowContextAgent?.lastEventAt ? new Date(workflowContextAgent.lastEventAt).getTime() : null,
      hasMessages: Boolean(workflowContextAgent?.currentTask?.trim()),
      readinessState: workflowContextAgent?.repoReadiness?.state ?? globalRepoEntry?.readiness?.state ?? null,
      readinessSummary: workflowContextAgent?.repoReadiness?.summary ?? globalRepoEntry?.readiness?.summary ?? null,
      readinessNextAction: workflowContextAgent?.repoReadiness?.nextAction ?? globalRepoEntry?.readiness?.nextAction ?? null,
    });
    const repoAttention = globalRepoEntries
      .filter((entry) => entry.readiness?.state === 'blocked' || entry.readiness?.state === 'needs_setup')
      .sort((a, b) => {
        const aScore = attentionRank(a.readiness?.label ?? '');
        const bScore = attentionRank(b.readiness?.label ?? '');
        if (aScore !== bScore) return bScore - aScore;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 4);

    for (const entry of repoAttention) {
      actions.push({
        id: `repo-attention:${entry.id}`,
        category: 'attention',
        title: `${entry.readiness?.label}: ${entry.name}`,
        detail: repoReadinessDetail(entry),
        stateLabel: entry.readiness?.label,
        stateTone: readinessTone(entry.readiness?.state),
        keywords: [entry.name, entry.localPath, entry.readiness?.summary ?? '', entry.readiness?.nextAction ?? ''],
        priority: attentionRank(entry.readiness?.label ?? ''),
        run: () => focusRepoSetup(entry),
      });
    }

    const attentionCandidates = paletteAgents
      .map((agent) => {
        const status = paletteWorkflowLabel(agent);
        return {
          agent,
          status,
          score: attentionRank(status) + Math.min(agent.alerts ?? 0, 8) * 12,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const { agent, status, score } of attentionCandidates) {
      actions.push({
        id: `attention:${agent.sessionKey}`,
        category: 'attention',
        title: `${status}: ${agent.name}`,
        detail: formatAttentionDetail(agent),
        stateLabel: status,
        stateTone: agent.repoReadiness
          ? readinessTone(agent.repoReadiness.state)
          : workflowTone(status),
        keywords: [agent.sessionKey, agent.currentTask ?? '', repoSlugFromAgent(agent) ?? '', agent.workspace ?? '', status],
        priority: score,
        run: () => {
          setSidebarVisible(true);
          setActiveSessionKey(agent.sessionKey);
        },
      });
    }

    if (globalRepoEntry) {
      const repoReadinessLabel = globalRepoEntry.readiness?.label;
      const repoReadinessTone = readinessTone(globalRepoEntry.readiness?.state);
      const repoReadinessSummary = repoReadinessDetail(globalRepoEntry);

      actions.push({
        id: 'workspace:launch-agent',
        category: 'workspace',
        title: 'Launch workspace agent',
        detail: globalRepoEntry.readiness
          ? `${repoReadinessLabel}: ${repoReadinessSummary}`
          : `Start a fresh CLI session in ${globalRepoEntry.name}.`,
        stateLabel: repoReadinessLabel,
        stateTone: repoReadinessTone,
        keywords: [globalRepoEntry.name, globalRepoEntry.localPath, globalRepo ?? '', 'launch', 'workspace', 'agent'],
        priority: 320,
        run: () => handleLaunchWorkspaceAgent({
          repoPath: globalRepoEntry.localPath,
          createNew: true,
        }),
      });

      actions.push({
        id: 'workspace:repo-setup',
        category: 'workspace',
        title: 'Open current repo setup',
        detail: globalRepoEntry.readiness
          ? repoReadinessSummary
          : `Edit saved env, build, and dev commands for ${globalRepoEntry.name}.`,
        stateLabel: repoReadinessLabel,
        stateTone: repoReadinessTone,
        keywords: [globalRepoEntry.name, 'repo setup', 'env', 'build', 'dev', 'profile'],
        priority: 300,
        run: handleFocusCurrentRepoSetup,
      });

      actions.push({
        id: 'workspace:create-worktree',
        category: 'workspace',
        title: 'Create workspace worktree',
        detail: selectedRepoWorktreesLoading
          ? `Checking worktree health for ${globalRepoEntry.name}…`
          : repoWorktreeDetail(selectedRepoWorktrees),
        stateLabel: globalRepoEntry.readiness?.label ?? (selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe ? 'Blocked' : 'Ready'),
        stateTone: globalRepoEntry.readiness
          ? readinessTone(globalRepoEntry.readiness.state)
          : selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe
            ? 'red'
            : 'blue',
        keywords: ['create worktree', 'new workspace', 'workspace branch', globalRepoEntry.name],
        priority: 298,
        run: () => openRepoWorkspaceModal(globalRepoEntry),
      });

      if (selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe) {
        actions.push({
          id: 'workspace:review-worktree-conflicts',
          category: 'attention',
          title: `Blocked: ${globalRepoEntry.name} worktree conflicts`,
          detail: `${selectedRepoWorktrees.conflicts.count} overlapping worktree file${selectedRepoWorktrees.conflicts.count === 1 ? '' : 's'} need operator attention before stacking more work.`,
          stateLabel: 'Blocked',
          stateTone: 'red',
          keywords: ['worktree conflict', 'overlap', 'blocked', globalRepoEntry.name],
          priority: 410,
          run: () => focusRepoSetup(globalRepoEntry),
        });
      }

      actions.push({
        id: 'workspace:open-cli-surface',
        category: 'workspace',
        title: 'Open workspace CLI surface',
        detail: `Focus the main workspace terminal for ${globalRepoEntry.name}.`,
        stateLabel: 'Ready',
        stateTone: 'blue',
        keywords: ['workspace cli', 'workspace terminal', 'terminal', 'focus terminal'],
        priority: 295,
        run: async () => {
          const target = await waitForWorkspaceTerminalTarget();
          if (!target) {
            throw new Error('No workspace CLI surface is available right now. Reload the workspace and try again.');
          }
        },
      });

      if (globalRepoEntry.readiness?.state === 'needs_setup' && globalRepoEntry.setup.installCommand) {
        actions.push({
          id: 'workspace:run-setup',
          category: 'recovery',
          title: `Run saved setup for ${globalRepoEntry.name}`,
          detail: `Execute ${globalRepoEntry.setup.installCommand} in the operator terminal.`,
          stateLabel: globalRepoEntry.readiness.label,
          stateTone: readinessTone(globalRepoEntry.readiness.state),
          keywords: [globalRepoEntry.setup.installCommand, 'install deps', 'setup', 'bootstrap', globalRepoEntry.name],
          priority: 340,
          run: () => {
            handleRunInTerminal(`cd ${JSON.stringify(globalRepoEntry.localPath)} && ${globalRepoEntry.setup.installCommand}`);
          },
        });
      }

      if (selectedSessionWorktree?.path) {
        actions.push({
          id: 'workspace:finder-worktree',
          category: 'workspace',
          title: 'Open current worktree in Finder',
          detail: `${selectedSessionWorktree.id} · ${selectedSessionWorktree.path}`,
          stateLabel: worktreeStageLabel(selectedSessionWorktree.status),
          stateTone: worktreeStageTone(selectedSessionWorktree.status),
          keywords: [selectedSessionWorktree.id, selectedSessionWorktree.path, 'worktree', 'finder', 'workspace path'],
          priority: 246,
          run: async () => {
            const response = await fetch('/api/panel/open-in', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ editor: 'finder', repo: selectedSessionWorktree.path }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to open the current worktree in Finder.');
            }
          },
        });

        actions.push({
          id: 'recovery:copy-worktree-path',
          category: 'recovery',
          title: 'Copy current worktree path',
          detail: shortenPath(selectedSessionWorktree.path),
          stateLabel: worktreeStageLabel(selectedSessionWorktree.status),
          stateTone: worktreeStageTone(selectedSessionWorktree.status),
          keywords: [selectedSessionWorktree.id, selectedSessionWorktree.path, 'copy worktree path', 'worktree'],
          priority: 226,
          run: async () => {
            await navigator.clipboard.writeText(selectedSessionWorktree.path);
          },
        });
      }

      actions.push({
        id: 'workspace:finder',
        category: 'workspace',
        title: 'Open current repo in Finder',
        detail: shortenPath(globalRepoEntry.localPath),
        keywords: [globalRepoEntry.localPath, 'finder', 'folder', 'open repo'],
        priority: 250,
        run: () => handleOpenRepoInDesktop('finder'),
      });

      actions.push({
        id: 'workspace:terminal-app',
        category: 'workspace',
        title: 'Open current repo in Terminal',
        detail: shortenPath(globalRepoEntry.localPath),
        keywords: [globalRepoEntry.localPath, 'terminal app', 'open in terminal', 'open repo'],
        priority: 248,
        run: () => handleOpenRepoInDesktop('terminal'),
      });

      actions.push({
        id: 'workspace:copy-path',
        category: 'recovery',
        title: 'Copy current repo path',
        detail: shortenPath(globalRepoEntry.localPath),
        keywords: [globalRepoEntry.localPath, 'copy path', 'cwd', 'repo path'],
        priority: 220,
        run: async () => {
          await navigator.clipboard.writeText(globalRepoEntry.localPath);
        },
      });

      if (staleSelectedRepoWorktrees.length > 0) {
        actions.push({
          id: 'recovery:prune-stale-worktrees',
          category: 'recovery',
          title: `Prune stale worktrees in ${globalRepoEntry.name}`,
          detail: `${staleSelectedRepoWorktrees.length} stale worktree${staleSelectedRepoWorktrees.length === 1 ? '' : 's'} will be removed. ${repoWorktreeDetail(selectedRepoWorktrees)}`,
          stateLabel: selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe ? 'Blocked' : 'Ready',
          stateTone: selectedRepoWorktrees && !selectedRepoWorktrees.conflicts.safe ? 'red' : 'blue',
          keywords: ['prune stale worktrees', 'cleanup worktrees', 'stale worktree', globalRepoEntry.name],
          priority: 345,
          run: async () => {
            const confirmed = window.confirm(
              `Prune ${staleSelectedRepoWorktrees.length} stale worktree${staleSelectedRepoWorktrees.length === 1 ? '' : 's'} for ${globalRepoEntry.name}?\n\nThis removes the stale worktree directories and their branches.`,
            );
            if (!confirmed) {
              return;
            }
            const response = await fetch('/api/worktrees', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repo: globalRepoEntry.localPath, action: 'prune' }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to prune stale worktrees.');
            }
            setSelectedRepoWorktreeRefreshNonce((current) => current + 1);
          },
        });
      }
    } else {
      actions.push({
        id: 'workspace:open-folder',
        category: 'workspace',
        title: 'Open folder',
        detail: 'Register a local checkout and make it the active workspace.',
        keywords: ['open folder', 'repo', 'workspace', 'register repo'],
        priority: 320,
        run: handleOpenFolder,
      });

      actions.push({
        id: 'workspace:open-cli-surface-empty',
        category: 'workspace',
        title: 'Open workspace CLI surface',
        detail: 'Focus the main workspace terminal even before a repo is selected.',
        stateLabel: 'Ready',
        stateTone: 'blue',
        keywords: ['workspace cli', 'workspace terminal', 'terminal', 'focus terminal'],
        priority: 260,
        run: async () => {
          const target = await waitForWorkspaceTerminalTarget();
          if (!target) {
            throw new Error('No workspace CLI surface is available right now. Reload the workspace and try again.');
          }
        },
      });
    }

    if (globalRepoEntry) {
      actions.push({
        id: 'workspace:open-folder-anyway',
        category: 'workspace',
        title: 'Open another folder',
        detail: 'Register or switch to a different local checkout.',
        keywords: ['open folder', 'switch repo', 'add repo', 'workspace'],
        priority: 180,
        run: handleOpenFolder,
      });
    }

    if (currentReviewAgent?.pr?.number) {
      const reviewRepo = repoSlugFromAgent(currentReviewAgent) || globalRepo;
      if (reviewRepo) {
        const reviewReadiness = globalRepoEntry?.readiness ?? currentReviewAgent.repoReadiness ?? null;
        const reviewStage = currentReviewAgent.workflowStage ?? deriveWorkflowStage({
          runtimeStatus: currentReviewAgent.status ?? null,
          workspaceStatus: currentReviewAgent.workspaceStatus ?? null,
          lifecycleState: currentReviewAgent.lifecycleState ?? null,
          latestText: currentReviewAgent.currentTask ?? '',
          lastActivityAt: currentReviewAgent.lastEventAt ? new Date(currentReviewAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(currentReviewAgent.currentTask?.trim()),
          readinessState: reviewReadiness?.state ?? null,
          prState: currentReviewAgent.pr.state ?? 'open',
        });
        const reviewGuidance = describeWorkflowStage({
          stage: reviewStage,
          runtimeStatus: currentReviewAgent.status ?? null,
          workspaceStatus: currentReviewAgent.workspaceStatus ?? null,
          lifecycleState: currentReviewAgent.lifecycleState ?? null,
          latestText: currentReviewAgent.currentTask ?? '',
          lastActivityAt: currentReviewAgent.lastEventAt ? new Date(currentReviewAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(currentReviewAgent.currentTask?.trim()),
          readinessState: reviewReadiness?.state ?? null,
          readinessSummary: reviewReadiness?.summary ?? null,
          readinessNextAction: reviewReadiness?.nextAction ?? null,
          prState: currentReviewAgent.pr.state ?? 'open',
        });
        const reviewStateLabel = reviewStage?.label ?? reviewReadiness?.label ?? 'Reviewing';
        const reviewStateTone = reviewStage ? workflowTone(reviewStage.label) : reviewReadiness ? readinessTone(reviewReadiness.state) : 'purple';
        actions.push({
          id: 'review:open-pr',
          category: 'review',
          title: `Open current PR #${currentReviewAgent.pr.number}`,
          detail: reviewGuidance.nextAction ? `${currentReviewAgent.pr.title} · ${reviewGuidance.nextAction}` : currentReviewAgent.pr.title,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, currentReviewAgent.pr.title, 'pull request', 'open pr', String(currentReviewAgent.pr.number)],
          priority: 310,
          run: () => handleSelectPR(currentReviewAgent.pr!.number, reviewRepo),
        });

        actions.push({
          id: 'review:launch-pr',
          category: 'review',
          title: `Launch PR #${currentReviewAgent.pr.number} review`,
          detail: reviewGuidance.nextAction ?? 'Open a CLI review lane with current repo readiness context.',
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'launch review', 'pr review', currentReviewAgent.pr.title],
          priority: 290,
          run: () => handleLaunchWorkspaceRepoTask({
            kind: 'pr',
            repo: reviewRepo,
            number: currentReviewAgent.pr!.number,
            title: currentReviewAgent.pr!.title,
            branch: currentReviewAgent.branch,
          }),
        });

        actions.push({
          id: 'review:checks',
          category: 'review',
          title: 'Open current checks',
          detail: reviewGuidance.detail,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'checks', 'ci', 'status checks'],
          priority: 280,
          run: () => handleOpenCI(reviewRepo),
        });

        actions.push({
          id: 'review:merge',
          category: 'review',
          title: `Merge current PR #${currentReviewAgent.pr.number}`,
          detail: reviewGuidance.mergeDetail,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'merge pr', 'merge pull request', currentReviewAgent.pr.title],
          priority: 260,
          disabled: !reviewGuidance.mergeAllowed,
          unavailableReason: !reviewGuidance.mergeAllowed ? reviewGuidance.mergeDetail : undefined,
          run: async () => {
            const response = await fetch(`/api/panel/prs/${currentReviewAgent.pr!.number}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'merge', repo: reviewRepo }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to merge the current pull request.');
            }
            handleSelectPR(currentReviewAgent.pr!.number, reviewRepo);
          },
        });
      }
    }

    if (!currentReviewAgent?.pr?.number && globalRepo) {
      actions.push({
        id: 'review:checks-only',
        category: 'review',
        title: 'Open current checks',
        detail: `Inspect the latest CI state for ${globalRepo}.`,
        stateLabel: globalRepoEntry?.readiness?.label ?? 'Reviewing',
        stateTone: globalRepoEntry?.readiness ? readinessTone(globalRepoEntry.readiness.state) : 'purple',
        keywords: [globalRepo, 'checks', 'ci', 'status checks'],
        priority: 240,
        run: () => handleOpenCI(globalRepo),
      });
    }

    if (currentIssueTarget) {
      actions.push({
        id: 'review:open-issue',
        category: 'review',
        title: `Open current issue #${currentIssueTarget.number}`,
        detail: `${currentIssueTarget.repo} · ${currentIssueTarget.title}`,
        stateLabel: globalRepoEntry?.readiness?.label ?? 'Working',
        stateTone: globalRepoEntry?.readiness ? readinessTone(globalRepoEntry.readiness.state) : 'green',
        keywords: [currentIssueTarget.repo, 'issue', currentIssueTarget.title, String(currentIssueTarget.number)],
        priority: 275,
        run: () => handleSelectIssue(currentIssueTarget.number, currentIssueTarget.repo),
      });
    }

    actions.push({
      id: 'settings:connectors',
      category: 'settings',
      title: 'Open connector settings',
      detail: 'GitHub auth, broker status, and repo access.',
      keywords: ['settings', 'connectors', 'github', 'broker'],
      priority: 210,
      run: () => handleOpenSettingsTab('connectors'),
    });

    actions.push({
      id: 'settings:agents',
      category: 'settings',
      title: 'Open agent settings',
      detail: 'Agent defaults, model choices, and runtime controls.',
      keywords: ['settings', 'agents', 'models', 'runtime'],
      priority: 205,
      run: () => handleOpenSettingsTab('agents'),
    });

    actions.push({
      id: 'settings:memory',
      category: 'settings',
      title: 'Open memory settings',
      detail: 'Cortex memory, embeddings, and maintenance.',
      keywords: ['settings', 'memory', 'cortex', 'embeddings'],
      priority: 200,
      run: () => handleOpenSettingsTab('memory'),
    });

    actions.push({
      id: 'settings:appearance',
      category: 'settings',
      title: 'Open appearance settings',
      detail: 'Theme and desktop shell behavior.',
      keywords: ['settings', 'appearance', 'theme', 'nav rail'],
      priority: 195,
      run: () => handleOpenSettingsTab('appearance'),
    });

    actions.push({
      id: 'recovery:setup',
      category: 'recovery',
      title: 'Rerun setup',
      detail: 'Open the setup flow and recheck local tools and providers.',
      stateLabel: wsStatus === 'disconnected' ? 'Blocked' : wsStatus === 'reconnecting' || wsStatus === 'connecting' ? 'Waiting' : undefined,
      stateTone: wsStatus === 'disconnected' ? 'red' : wsStatus === 'reconnecting' || wsStatus === 'connecting' ? 'amber' : undefined,
      keywords: ['rerun setup', 'setup wizard', 'doctor', 'recovery'],
      priority: wsStatus === 'connected' ? 170 : 260,
      run: () => setSetupWizardOpen(true),
    });

    if (wsStatus !== 'connected') {
      actions.push({
        id: 'recovery:workspace-bridge',
        category: 'recovery',
        title: wsStatus === 'disconnected' ? 'Workspace bridge disconnected' : 'Workspace bridge reconnecting',
        detail: wsStatus === 'disconnected'
          ? 'Saved tabs stay local, but live session updates are paused until the bridge comes back.'
          : 'Live session updates are resyncing. Reload only if the workspace does not recover on its own.',
        stateLabel: wsStatus === 'disconnected' ? 'Blocked' : 'Waiting',
        stateTone: wsStatus === 'disconnected' ? 'red' : 'amber',
        keywords: ['workspace bridge', 'disconnected', 'reconnecting', 'ws', 'reload workspace'],
        priority: wsStatus === 'disconnected' ? 520 : 300,
        run: () => window.location.reload(),
      });
    }

    if (activeSessionKey && !selectedSessionAgent && paletteAgents.length > 0) {
      const fallbackSession = paletteAgents.find((agent) => agent.isCurrentSession) ?? paletteAgents[0];
      actions.push({
        id: 'recovery:missing-session',
        category: 'recovery',
        title: 'Selected session is no longer live',
        detail: 'The current chat selection fell out of the live inventory. Jump to a monitored session or reload the workspace snapshot.',
        stateLabel: 'Blocked',
        stateTone: 'red',
        keywords: ['missing session', 'session unavailable', activeSessionKey].filter((keyword): keyword is string => Boolean(keyword)),
        priority: 510,
        run: () => {
          if (fallbackSession) {
            setActiveSessionKey(fallbackSession.sessionKey);
            setChatVisible(true);
            return;
          }
          window.location.reload();
        },
      });
    }

    actions.push({
      id: 'recovery:restore',
      category: 'recovery',
      title: 'Restore workspace tabs',
      detail: 'Reload the dashboard and reattach saved workspace tabs in place.',
      keywords: ['restore session', 'restore tabs', 'reload workspace', 'recover'],
      priority: wsStatus === 'connected' ? 160 : 250,
      run: () => window.location.reload(),
    });

    actions.push({
      id: 'workspace:archive-unavailable',
      category: 'workspace',
      title: 'Archive workspace',
      detail: workflowContextGuidance.archiveDetail,
      stateLabel: workflowContextStage?.label ?? 'Unavailable',
      stateTone: workflowContextStage ? workflowTone(workflowContextStage.label) : 'slate',
      keywords: ['archive workspace', 'archive lane', 'archive'],
      priority: 12,
      disabled: true,
      unavailableReason: workflowContextGuidance.archiveUnavailableReason,
      run: () => undefined,
    });

    actions.push({
      id: 'workspace:resume-unavailable',
      category: 'workspace',
      title: 'Resume archived workspace',
      detail: workflowContextGuidance.resumeDetail,
      stateLabel: workflowContextStage?.label ?? 'Unavailable',
      stateTone: workflowContextStage ? workflowTone(workflowContextStage.label) : 'slate',
      keywords: ['resume workspace', 'resume archived workspace', 'resume'],
      priority: 11,
      disabled: true,
      unavailableReason: workflowContextGuidance.resumeUnavailableReason,
      run: () => undefined,
    });

    return actions;
  }, [
    activeSessionKey,
    currentIssueTarget,
    currentReviewAgent,
    globalRepo,
    globalRepoEntry,
    globalRepoEntries,
    handleFocusCurrentRepoSetup,
    handleLaunchWorkspaceAgent,
    handleLaunchWorkspaceRepoTask,
    handleOpenFolder,
    handleOpenRepoInDesktop,
    handleOpenSettingsTab,
    handleOpenCI,
    handleRunInTerminal,
    handleSelectIssue,
    handleSelectPR,
    openRepoWorkspaceModal,
    paletteAgents,
    focusRepoSetup,
    selectedRepoWorktrees,
    selectedRepoWorktreesLoading,
    selectedSessionWorktree,
    selectedSessionAgent,
    scopedRepoAgents,
    staleSelectedRepoWorktrees,
    waitForWorkspaceTerminalTarget,
    wsStatus,
  ]);

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
      // closable determined dynamically in TileContainer (last terminal is protected)
      render: ({ tileId }) => (
        <WorkspaceTerminal
          ref={(handle) => registerWorkspaceTerminalHandle(tileId, handle)}
          stateScope={tileId}
          defaultTab={tileId === 'tile-root' ? 'llm-chat' : 'terminal'}
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
          ref={(handle) => registerContextualPanelHandle(tileId, handle)}
          sendTerminalCreate={sendTerminalCreate}
          sendTerminalAttach={sendTerminalAttach}
          sendTerminalInput={sendTerminalInput}
          sendTerminalResize={sendTerminalResize}
          sendTerminalDetach={sendTerminalDetach}
          sendAgentKill={sendAgentKill}
          termWsConnected={termWsConnected}
          selectedRepo={globalRepo ?? null}
          canvasTabs={canvasTabs}
          activeCanvasTabId={activeCanvasTabId}
          canvasRevealKey={canvasRevealKey}
          onSelectCanvasTab={setActiveCanvasTabId}
          onCloseCanvasTab={closeCanvasTab}
          onInjectChatContext={handleAgentPanelChatInjection}
          onSelectCommit={handleSelectCommit}
          onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
          onClose={() => handleCloseTile(tileId)}
        />
      ),
    },
  }), [
    activeCanvasTabId,
    canvasRevealKey,
    canvasTabs,
    closeCanvasTab,
    globalRepo,
    handleClosePreviewTileItem,
    handleCloseTile,
    handleAgentPanelChatInjection,
    handleLaunchWorkspaceRepoTask,
    handlePreviewDetected,
    handlePreviewSelection,
    handleSelectCommit,
    handleSelectPreviewTile,
    parsedAgents,
    registerContextualPanelHandle,
    registerWorkspaceTerminalHandle,
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
      <UpdateBanner />

      {/* ── Title Bar ── */}
      <TitleBar
        globalRepoBranch={globalRepoBranch}
        selectedRepoEntry={globalRepoEntry}
        repoEntries={globalRepoEntries}
        onRepoChange={handleSelectRegisteredRepo}
        onRepoRemove={(repoId) => {
          void handleRemoveRegisteredRepo(repoId).catch((error) => {
            window.alert(error instanceof Error ? error.message : 'Unable to remove repository.');
          });
        }}
        onOpenFolder={handleOpenFolder}
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
            repo={globalRepo ?? undefined}
            agentsJson={agentsJson}
            actions={paletteActions}
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
          selectedRepo={globalRepo}
          selectedRepoName={globalRepoEntry?.name ?? null}
          selectedRepoBranch={globalRepoBranch}
          selectedRepoLocalPath={globalRepoEntry?.localPath ?? null}
          selectedRepoReadiness={globalRepoEntry?.readiness ?? null}
          onLaunchWorkspaceAgent={handleLaunchWorkspaceAgent}
          onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
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
            <SettingsPage initialTab={settingsInitialTab} />
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
          onSelectSession={setActiveSessionKey}
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
