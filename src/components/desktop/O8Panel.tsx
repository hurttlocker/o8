'use client';

/**
 * O8Panel — Wide contextual panel with Workspace, Browser, Activity, Inbox, and spec tabs.
 *
 * Third state of the right panel morph button (collapsed → review → o8).
 * Modeled after Cursor 3's right panel, adapted for governance.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { CircleSpark, DoubleCheck, Folder, Internet } from 'iconoir-react';
import { Terminal as TablerTerminal } from '@/components/desktop/tabler-shims';
import { O8ActivityPane } from './O8ActivityPane';
import { O8BrowserPane } from './O8BrowserPane';
import { O8InboxPane } from './O8InboxPane';
import { O8SpecPane } from './o8-panel/O8SpecPane';
import { O8ScratchChat } from './o8-panel/workspace-rail/O8ScratchChat';
import { ComparisonMatrix } from './comparison/ComparisonMatrix';
import { useComparisonGroups } from './comparison/useComparisonGroups';
import { useOrchestratorData } from './orchestrator-data-context';
import { ReviewPanel } from './review/ReviewPanel';
import { O8RepoSelector } from './o8-panel/O8RepoSelector';
import { TargetsPanel } from './o8-panel/TargetsPanel';
import { ProjectChangesOverview } from './o8-panel/ProjectChangesOverview';
import { AllFilesTree } from './o8-panel/workspace-rail/AllFilesTree';
import { FileViewer } from './o8-panel/workspace-rail/FileViewer';
import { ContextualPanel, type ContextualPanelHandle, type ContextualPanelProps } from './ContextualPanel';
import type { O8Tab } from './o8-panel/types';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { retryingLazy } from '@/lib/react/retrying-lazy';
// O8 panel uses the native dark theme — no LIGHT_CANVAS_VARS override needed

const LazyOrchestratorTab = retryingLazy(() => import('@/components/desktop/workspace-terminal/OrchestratorTab').then((module) => ({ default: module.OrchestratorTab })), { label: 'Orchestrator tab' });

type RightUtilityTab = Extract<O8Tab, 'files' | 'side-chat' | 'browser' | 'review' | 'terminal'>;

const RIGHT_UTILITY_TAB_IDS: RightUtilityTab[] = ['files', 'side-chat', 'browser', 'review', 'terminal'];

function isRightUtilityTab(tab: O8Tab): tab is RightUtilityTab {
  return RIGHT_UTILITY_TAB_IDS.includes(tab as RightUtilityTab);
}

interface O8PanelProps {
  repoPath?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  onRepoPathChange?: (repoPath: string) => void;
  /** Shared repo scope: true = "All repos" aggregate across the active project. */
  allRepos?: boolean;
  onSelectAllRepos?: () => void;
  previews?: DetectedLocalhostPreview[];
  onOpenFile?: (filePath: string) => void;
  prNumber?: number | null;
  prRepo?: string | null;
  repoSlug?: string | null;
  activeTab?: O8Tab | null;
  onActiveTabChange?: (tab: O8Tab) => void;
  selectedFile?: string | null;
  reviewLaneId?: string | null;
  browserUrl?: string | null;
  browserStateKey?: string;
  // Bubbles the browser pane's active URL up so the TitleBar Browser
  // button can render a hover preview iframe pointed at it.
  onBrowserActiveUrlChange?: (url: string | null) => void;
  /** Header-rail portal target for the browser's page tabs (Cursor borrow,
   *  Q 2026-07-12) — provided by the dashboard's PanelHeaderStrip. Pages
   *  render up there next to the state drawer; the pane skips its own row. */
  browserHeaderTabSlot?: HTMLElement | null;
  onSelectedFileChange?: (filePath: string) => void;
  commitSha?: string | null;
  onClearCommit?: () => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  registerContextualPanelHandle?: (tileId: string, handle: ContextualPanelHandle | null) => void;
  sendTerminalCreate?: ContextualPanelProps['sendTerminalCreate'];
  sendTerminalAttach?: ContextualPanelProps['sendTerminalAttach'];
  sendTerminalInput?: ContextualPanelProps['sendTerminalInput'];
  sendTerminalResize?: ContextualPanelProps['sendTerminalResize'];
  sendTerminalDetach?: ContextualPanelProps['sendTerminalDetach'];
  sendAgentKill?: ContextualPanelProps['sendAgentKill'];
  termWsConnected?: boolean;
}

function FilesIcon({ size = 18 }: { size?: number }) {
  return <Folder width={size} height={size} color="currentColor" strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

function ChatIcon({ size = 18 }: { size?: number }) {
  return <CircleSpark width={size} height={size} color="currentColor" strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

function BrowserIcon({ size = 18 }: { size?: number }) {
  return <Internet width={size} height={size} color="currentColor" strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

function ReviewIcon({ size = 18 }: { size?: number }) {
  return <DoubleCheck width={size} height={size} color="currentColor" strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

function TerminalIcon({ size = 18 }: { size?: number }) {
  return <TablerTerminal size={size} strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function SurfaceEmptyState({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      color: 'var(--t-text-muted)',
      background: 'var(--t-bg)',
      textAlign: 'center',
      padding: 24,
    }}>
      <div style={{
        width: 42,
        height: 42,
        borderRadius: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--t-text-secondary)',
        background: 'var(--t-input-bg)',
        border: '1px solid var(--t-divider-subtle)',
      }}>
        {icon}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 350, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>{title}</div>
      <div style={{ maxWidth: 360, fontSize: 13, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.45, color: 'var(--t-text-faint)' }}>{detail}</div>
    </div>
  );
}

interface RightUtilityDefinition {
  id: RightUtilityTab;
  label: string;
  description: string;
  icon: (props: { size?: number }) => React.ReactNode;
}

const RIGHT_UTILITY_TABS: RightUtilityDefinition[] = [
  { id: 'files', label: 'Files', description: 'Browse project files', icon: FilesIcon },
  { id: 'side-chat', label: 'Side chat', description: 'Start a side conversation', icon: ChatIcon },
  { id: 'browser', label: 'Browser', description: 'Open a website', icon: BrowserIcon },
  { id: 'review', label: 'Review', description: 'View code changes', icon: ReviewIcon },
  { id: 'terminal', label: 'Terminal', description: 'Start an interactive shell', icon: TerminalIcon },
];

const RIGHT_UTILITY_BY_ID = Object.fromEntries(
  RIGHT_UTILITY_TABS.map((tab) => [tab.id, tab]),
) as Record<RightUtilityTab, RightUtilityDefinition>;

function RightUtilityTabStrip({
  tabs,
  activeTab,
  onOpenLauncher,
  onSelect,
  onClose,
}: {
  tabs: RightUtilityTab[];
  activeTab: O8Tab;
  onOpenLauncher: () => void;
  onSelect: (tab: RightUtilityTab) => void;
  onClose: (tab: RightUtilityTab) => void;
}) {
  return (
    <div style={{
      // Cursor-density strip (browser siphon pass 1, Q 2026-07-12): 34px not
      // 44, quiet weights per the locked tab language — active = bg fill,
      // never bold.
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      minHeight: 34,
      paddingTop: 4,
      paddingRight: 8,
      paddingBottom: 4,
      paddingLeft: 8,
      borderBottom: '1px solid var(--t-divider)',
      background: 'var(--t-bg)',
      flexShrink: 0,
    }}>
      <button
        type="button"
        onClick={onOpenLauncher}
        aria-label="Open right panel tab picker"
        title="Open tab picker"
        style={{
          width: 24,
          height: 24,
          borderRadius: 7,
          border: 'none',
          background: activeTab === 'launcher' ? 'var(--t-panel-hover)' : 'transparent',
          color: activeTab === 'launcher' ? 'var(--t-text)' : 'var(--t-text-muted)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = activeTab === 'launcher' ? 'var(--t-panel-hover)' : 'transparent'; }}
      >
        <PlusIcon size={14} />
      </button>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
      }}>
        {tabs.map((tab) => {
          const def = RIGHT_UTILITY_BY_ID[tab];
          const Icon = def.icon;
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onSelect(tab)}
              aria-label={def.label}
              style={{
                height: 24,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                paddingTop: 0,
                paddingRight: 6,
                paddingBottom: 0,
                paddingLeft: 8,
                borderRadius: 7,
                border: '1px solid transparent',
                background: active ? 'var(--t-panel-hover)' : 'transparent',
                color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
            >
              {Icon({ size: 12.5 })}
              <span style={{ fontSize: 12, fontWeight: active ? 400 : 300, letterSpacing: '-0.1px', whiteSpace: 'nowrap' }}>
                {def.label}
              </span>
              <span
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab);
                }}
                style={{
                  width: 15,
                  height: 15,
                  borderRadius: 4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--t-text-faint)',
                }}
              >
                <XIcon size={9} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RightUtilityLauncher({ onOpen }: { onOpen: (tab: RightUtilityTab) => void }) {
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setPanelHeight(node.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setPanelHeight(entry.contentRect.height);
    });
    observer.observe(node);
    // Cleanup handled by callback-ref re-fire when node changes.
  }, []);
  // Available height per card after subtracting padding + gaps. Targets a
  // taller card on big screens; compact rows when the panel is short
  // (e.g. split layouts) — never overflows into a scroll.
  const padding = 28; // 14 top + 14 bottom
  const gapsTotal = 6 * 4; // 5 cards = 4 gaps × 6px
  const usable = Math.max(0, (panelHeight ?? 600) - padding - gapsTotal);
  const fairShare = usable / RIGHT_UTILITY_TABS.length;
  const cardHeight = Math.max(52, Math.min(64, fairShare));
  const compact = cardHeight < 64;
  const iconSize = compact ? 14 : 16;
  const iconBoxSize = compact ? 26 : 30;
  const labelSize = compact ? 12.5 : 13.5;
  const metaSize = compact ? 9 : 9.5;
  return (
    <div
      ref={measureRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--t-bg)',
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 14,
      }}
    >
      <div style={{
        width: '100%',
        height: '100%',
        maxWidth: 460,
        marginLeft: 'auto',
        marginRight: 'auto',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 6,
      }}>
        {RIGHT_UTILITY_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onOpen(tab.id)}
              style={{
                minHeight: cardHeight,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingTop: compact ? 8 : 12,
                paddingRight: 14,
                paddingBottom: compact ? 8 : 12,
                paddingLeft: 14,
                borderRadius: 10,
                border: '1px solid var(--t-divider-subtle)',
                background: 'var(--t-panel)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-panel-hover)';
                event.currentTarget.style.borderColor = 'var(--t-divider)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'var(--t-panel)';
                event.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
              }}
            >
              <span style={{
                width: iconBoxSize,
                height: iconBoxSize,
                borderRadius: 8,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--t-text-secondary)',
                background: 'var(--t-input-bg)',
                border: '1px solid var(--t-divider-subtle)',
                flexShrink: 0,
              }}>
                {Icon({ size: iconSize })}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: labelSize, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px' }}>
                  {tab.label}
                </span>
                <span style={{ fontSize: metaSize, lineHeight: 1.25, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-muted)' }}>
                  {tab.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Component ──

export function O8Panel({
  repoPath,
  registeredRepos = [],
  onRepoPathChange,
  allRepos = false,
  onSelectAllRepos,
  previews = [],
  onOpenFile,
  prNumber,
  prRepo,
  repoSlug,
  activeTab: externalTab,
  onActiveTabChange,
  selectedFile,
  reviewLaneId,
  browserUrl,
  browserStateKey = 'right-panel',
  onBrowserActiveUrlChange,
  browserHeaderTabSlot = null,
  onSelectedFileChange,
  onSelectCommit,
  onSelectIssue,
  registerContextualPanelHandle,
  sendTerminalCreate,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
  sendAgentKill,
  termWsConnected = false,
}: O8PanelProps) {
  const activeTab = externalTab ?? 'activity';
  // Browser is EXCLUDED from the utility shell (Q ruling 2026-07-12) — it's
  // a first-class drawer state whose pages render in the header rail, so it
  // never earns a strip row. activeTab === 'browser' renders the dedicated
  // main mount below instead.
  const activeUtilityTab = isRightUtilityTab(activeTab) && activeTab !== 'browser' ? activeTab : null;
  const utilityShellActive = activeTab === 'launcher' || activeUtilityTab !== null;
  // Best-of-N compare matrix (item 3) — the first ready comparison group, read
  // from mission state. useOrchestratorData returns null outside the provider, so
  // this is inert when there's no orchestrator context.
  const orchestratorData = useOrchestratorData();
  const { readyGroups: compareReadyGroups } = useComparisonGroups(orchestratorData?.missionState);
  const compareGroup = compareReadyGroups[0] ?? null;
  const [utilityTabs, setUtilityTabs] = useState<RightUtilityTab[]>([]);
  const [localSelectedFile, setLocalSelectedFile] = useState<string | null>(null);
  // #1169 — orchestrator-driven browser open. The o8:open-browser window event
  // (fired by the o8_view_open_browser MCP tool) sets this; it overrides the
  // parent-owned browserUrl prop so the agent can open the Browser tab to a URL
  // in one call instead of snapshot/click-hunting. Cleared whenever the parent
  // drives its own navigation so the prop is never shadowed by a stale value.
  const [pendingBrowserUrl, setPendingBrowserUrl] = useState<string | null>(null);
  useEffect(() => { setPendingBrowserUrl(null); }, [browserUrl]);
  // The shared O8RepoSelector in the workspace header owns repo switching now,
  // so hide ReviewPanel's built-in dropdown: a single-entry list trips its own
  // `registeredRepos.length > 1` guard and keeps the inline selector hidden.
  const reviewRepos = registeredRepos.filter((r) => r.localPath === repoPath);
  const repoLabel = useMemo(() => (
    registeredRepos.find((repo) => repo.localPath === repoPath)?.name
    ?? repoPath?.split('/').filter(Boolean).pop()
    ?? null
  ), [registeredRepos, repoPath]);
  const dirtyFiles = useMemo(() => new Set<string>(), []);
  const selectedUtilityFile = selectedFile ?? localSelectedFile;
  const renderedUtilityTabs = activeUtilityTab && !utilityTabs.includes(activeUtilityTab)
    ? [...utilityTabs, activeUtilityTab]
    : utilityTabs;
  // One-time sweep: browser left the utility system (Q 2026-07-12) — drop
  // any lingering strip membership from earlier in the session.
  useEffect(() => {
    setUtilityTabs((prev) => (prev.includes('browser') ? prev.filter((t) => t !== 'browser') : prev));
  }, []);
  useEffect(() => {
    if (!activeUtilityTab) return;
    queueMicrotask(() => {
      setUtilityTabs((prev) => (prev.includes(activeUtilityTab) ? prev : [...prev, activeUtilityTab]));
    });
  }, [activeUtilityTab]);

  const openRightUtilityTab = useCallback((tab: RightUtilityTab) => {
    // Browser is a first-class drawer state now (Q ruling 2026-07-12: "the
    // browser pill in the middle — why do we need it?") — its pages live in
    // the header rail, so it never joins the utility strip. The launcher
    // entry just activates the main browser tab.
    if (tab === 'browser') {
      onActiveTabChange?.('browser');
      return;
    }
    setUtilityTabs((prev) => (prev.includes(tab) ? prev : [...prev, tab]));
    onActiveTabChange?.(tab);
  }, [onActiveTabChange]);

  const closeRightUtilityTab = useCallback((tab: RightUtilityTab) => {
    setUtilityTabs((prev) => {
      const remaining = prev.filter((entry) => entry !== tab);
      if (activeTab === tab) {
        const currentIndex = prev.indexOf(tab);
        const next = remaining[Math.min(currentIndex, remaining.length - 1)] ?? null;
        onActiveTabChange?.(next ?? 'launcher');
      }
      return remaining;
    });
  }, [activeTab, onActiveTabChange]);

  const handleSelectUtilityFile = useCallback((path: string) => {
    setLocalSelectedFile(path);
    onSelectedFileChange?.(path);
  }, [onSelectedFileChange]);

  const handleRightContextualPanelRef = useCallback((handle: ContextualPanelHandle | null) => {
    registerContextualPanelHandle?.('right-utility-panel', handle);
  }, [registerContextualPanelHandle]);

  // Phase 3 — file paths clicked in agent chat dispatch `o8:open-file`;
  // route them to the dashboard's openInspectorTab via the onOpenFile prop.
  useEffect(() => {
    const handler = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (typeof path === 'string' && path) onOpenFile?.(path);
    };
    window.addEventListener('o8:open-file', handler);
    return () => window.removeEventListener('o8:open-file', handler);
  }, [onOpenFile]);

  // #1095 — ChatActionCard's Review button dispatches `o8:focus-review` so the
  // panel flips to the Review tab and (optionally) scrolls to the first file
  // the turn touched. Mirrors the `o8:open-file` precedent above.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ repoPath?: string | null; file?: string | null }>).detail ?? {};
      if (detail.repoPath && detail.repoPath !== repoPath) {
        onRepoPathChange?.(detail.repoPath);
      }
      onActiveTabChange?.('review');
      if (typeof detail.file === 'string' && detail.file) {
        setLocalSelectedFile(detail.file);
        onSelectedFileChange?.(detail.file);
      }
    };
    window.addEventListener('o8:focus-review', handler);
    return () => window.removeEventListener('o8:focus-review', handler);
  }, [onActiveTabChange, onRepoPathChange, onSelectedFileChange, repoPath]);

  // #1169 — the o8_view_open_browser MCP tool dispatches `o8:open-browser`;
  // reveal the Browser tab and (optionally) navigate it. One deterministic
  // action instead of the snapshot/click hunt that cost the orchestrator ~5 min.
  useEffect(() => {
    const handler = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string | null }>).detail?.url;
      onActiveTabChange?.('browser');
      if (typeof url === 'string' && url.trim()) setPendingBrowserUrl(url.trim());
    };
    window.addEventListener('o8:open-browser', handler);
    return () => window.removeEventListener('o8:open-browser', handler);
  }, [onActiveTabChange]);

  const renderUtilitySurface = (tab: RightUtilityTab, active: boolean) => {
    if (tab === 'files') {
      // Cursor arrangement (Q ruling 2026-07-12, vid2 3:10-4:10): the file
      // CONTENT reads in the center-left, the tree hugs the far-right edge.
      return (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(210px, 34%)', background: 'var(--t-bg)' }}>
          <FileViewer repoPath={repoPath} selectedFile={selectedUtilityFile} />
          <div style={{ minWidth: 0, minHeight: 0, display: 'flex', borderLeft: '1px solid var(--t-divider-subtle)', background: 'var(--t-panel)' }}>
            <AllFilesTree
              repoPath={repoPath}
              selectedFile={selectedUtilityFile}
              dirtyFiles={dirtyFiles}
              onSelectFile={handleSelectUtilityFile}
            />
          </div>
        </div>
      );
    }

    if (tab === 'side-chat') {
      // Opaque chat-surface wrapper: without it the OrchestratorTab's empty
      // state bleeds through translucent over the layer behind (the ghosted
      // "What should we build" hero). --t-chat-surface-bg is pinned solid in
      // every palette × surface, so the side chat always reads as paper.
      return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--t-chat-surface-bg)' }}>
          <Suspense fallback={<SurfaceEmptyState icon={<ChatIcon size={18} />} title="Loading side chat" detail="Preparing a repo-aware conversation in the right panel." />}>
            <LazyOrchestratorTab
              tabId="right-side-chat"
              active={active}
              repoPath={repoPath ?? null}
              repoLabel={repoLabel}
              initialMode="fleet"
              acceptHistoryThreadLoads={false}
              restoreLastThread={false}
              publishWorkspaceThread={false}
              persistLastThread={false}
              projectContextRailVisible={false}
            />
          </Suspense>
        </div>
      );
    }

    if (tab === 'browser') {
      return (
        <O8BrowserPane
          key={browserStateKey}
          previews={previews}
          navigateToUrl={pendingBrowserUrl ?? browserUrl}
          stateScopeKey={browserStateKey}
          onActiveUrlChange={onBrowserActiveUrlChange}
          tabStripSlot={browserHeaderTabSlot}
          onFocusRequest={() => onActiveTabChange?.('browser')}
        />
      );
    }

    if (tab === 'review') {
      if (!repoPath) {
        return (
          <SurfaceEmptyState
            icon={<ReviewIcon size={18} />}
            title="No repository selected"
            detail="Select or register a repo before opening review in the right panel."
          />
        );
      }
      return (
        <ReviewPanel
          repoPath={repoPath}
          registeredRepos={reviewRepos}
          onRepoPathChange={onRepoPathChange}
          selectedFile={selectedUtilityFile}
          reviewLaneId={reviewLaneId}
        />
      );
    }

    if (sendTerminalCreate && sendTerminalAttach && sendTerminalInput && sendTerminalResize && sendTerminalDetach && sendAgentKill) {
      return (
        <ContextualPanel
          ref={handleRightContextualPanelRef}
          sendTerminalCreate={sendTerminalCreate}
          sendTerminalAttach={sendTerminalAttach}
          sendTerminalInput={sendTerminalInput}
          sendTerminalResize={sendTerminalResize}
          sendTerminalDetach={sendTerminalDetach}
          sendAgentKill={sendAgentKill}
          termWsConnected={termWsConnected}
          repoPath={repoPath}
          repoLabel={repoLabel}
          registeredRepos={registeredRepos}
          previews={previews}
          onRepoPathChange={onRepoPathChange}
          panelLabel="Right Panel"
          onClose={() => onActiveTabChange?.('launcher')}
        />
      );
    }

    return (
      <SurfaceEmptyState
        icon={<TerminalIcon size={18} />}
        title="Terminal unavailable"
        detail="The terminal bridge is not connected for this right panel."
      />
    );
  };

  return (
    <div
      data-chrome-surface="true"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        // Glass chrome, matching the left AgentPanel: --t-chrome is transparent
        // in glass (ThemeProvider flips it) so the panel shows the dark window
        // vibrancy instead of painting a light --t-bg tint over it. Opaque chrome
        // in solid mode. (Per-tab content that must stay paper — e.g. the
        // workspace orchestrator hero — paints its own --t-chat-surface-bg.)
        background: 'var(--t-chrome)',
        // No explicit left divider: the solid center transcript meeting the
        // glass panel already reads as a boundary. On the DARK slab a white-alpha
        // --t-divider rendered as a hard vertical seam (invisible on light paper,
        // so light never showed it) — operator fix 2026-07-14.
      }}
    >
      {/* Scratch chat — floating Ask-o8 button + dialog, sits across tabs where
          it does not compete with local document/review controls.
          Operator restored post-#1089 ([[borrow_conductor_steer_queue]]
          sibling — same restore-after-rework pattern). Mounts once per panel;
          internal Cmd+E hotkey + button click open the floating dialog. The
          review/workspace tab owns its compact toolbar trigger inside
          ReviewPanel; Activity/PR detail suppress it to keep local toolbars
          clear. o8.md/spec also suppresses the floating overlay — the
          Ask-o8 chat trigger renders inline in the spec pane's own
          toolbar (passed via toolbarSlot below) so all three buttons
          (Ask-o8 chat, Ask-to-review, Settings) sit in one row. */}
      {/* No Brain chat on the browser — it's a real browser now (Q ruling
          2026-07-12); its header/toolbar carry browser tools instead. */}
      {!utilityShellActive && activeTab !== 'workspace' && activeTab !== 'spec' && activeTab !== 'activity' && activeTab !== 'prs' && activeTab !== 'browser' ? (
        <div style={{ position: 'absolute', top: 8, right: 12, zIndex: 5 }}>
          <O8ScratchChat
            repoPath={repoPath}
            selectedFile={selectedFile ?? null}
            surface="diff"
            surfaceLabel="panel"
          />
        </div>
      ) : null}

      {/* Tab content — all tabs stay mounted to preserve state */}
      {utilityShellActive || renderedUtilityTabs.length > 0 ? (
        <div style={{ flex: 1, minHeight: 0, display: utilityShellActive ? 'flex' : 'none', flexDirection: 'column' }}>
          <RightUtilityTabStrip
            tabs={renderedUtilityTabs}
            activeTab={activeTab}
            onOpenLauncher={() => onActiveTabChange?.('launcher')}
            onSelect={(tab) => onActiveTabChange?.(tab)}
            onClose={closeRightUtilityTab}
          />
          {activeTab === 'launcher' ? (
            <RightUtilityLauncher onOpen={openRightUtilityTab} />
          ) : null}
          {renderedUtilityTabs.map((tab) => (
            <div
              key={tab}
              aria-hidden={activeUtilityTab !== tab}
              style={{
                flex: 1,
                minHeight: 0,
                display: activeUtilityTab === tab ? 'flex' : 'none',
                flexDirection: 'column',
                overflow: 'hidden',
                background: 'var(--t-bg)',
              }}
            >
              {renderUtilitySurface(tab, activeUtilityTab === tab)}
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'workspace' ? 'flex' : 'none', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottom: '1px solid var(--t-divider)', flexShrink: 0 }}>
          <O8RepoSelector
            repos={registeredRepos}
            allRepos={allRepos}
            selectedRepoPath={repoPath ?? null}
            onSelectAll={() => onSelectAllRepos?.()}
            onSelectRepo={(path) => onRepoPathChange?.(path)}
            style={{ flex: 1 }}
          />
        </div>
        {allRepos ? (
          <ProjectChangesOverview repos={registeredRepos} onPickRepo={(path) => onRepoPathChange?.(path)} />
        ) : (
          <ReviewPanel repoPath={repoPath} registeredRepos={reviewRepos} onRepoPathChange={onRepoPathChange} selectedFile={selectedFile ?? null} reviewLaneId={reviewLaneId} />
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'browser' && !utilityShellActive ? 'flex' : 'none', flexDirection: 'column' }}>
        {/* The utility-mounted browser wins the header slot when both exist —
            two instances portaling into one node would duplicate the pills. */}
        <O8BrowserPane
          key={browserStateKey}
          previews={previews}
          navigateToUrl={pendingBrowserUrl ?? browserUrl}
          stateScopeKey={browserStateKey}
          onActiveUrlChange={onBrowserActiveUrlChange}
          tabStripSlot={renderedUtilityTabs.includes('browser') ? null : browserHeaderTabSlot}
          onFocusRequest={() => onActiveTabChange?.('browser')}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'activity' || activeTab === 'prs' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8ActivityPane
          active={activeTab === 'activity' || activeTab === 'prs'}
          repoPath={repoPath}
          repoSlug={prRepo ?? repoSlug}
          registeredRepos={registeredRepos}
          allRepos={allRepos}
          onSelectAllRepos={onSelectAllRepos}
          onSelectRepoPath={onRepoPathChange}
          onSelectCommit={onSelectCommit}
          onSelectIssue={onSelectIssue}
          selectedPrNumber={prNumber ?? null}
          selectedPrRepo={prRepo ?? null}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'inbox' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8InboxPane active={activeTab === 'inbox'} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'spec' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8SpecPane
          repoPath={repoPath}
          active={activeTab === 'spec'}
          toolbarSlot={(
            <O8ScratchChat
              repoPath={repoPath}
              selectedFile={selectedFile ?? null}
              surface="diff"
              surfaceLabel="o8.md"
            />
          )}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'compare' ? 'flex' : 'none', flexDirection: 'column' }}>
        {compareGroup ? (
          <ComparisonMatrix group={compareGroup} />
        ) : (
          <div style={{ paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-faint)' }}>
            No comparison ready yet. Dispatch a best-of-N mission (set comparisonModels on create_mission) and the candidates land here side by side once they finish.
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'targets' ? 'flex' : 'none', flexDirection: 'column' }}>
        <TargetsPanel repoPath={repoPath} active={activeTab === 'targets'} />
      </div>
    </div>
  );
}
