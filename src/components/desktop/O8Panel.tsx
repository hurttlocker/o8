'use client';

/**
 * O8Panel — Wide contextual panel with Workspace, Browser, Activity, Inbox, and spec tabs.
 *
 * Third state of the right panel morph button (collapsed → review → o8).
 * Modeled after Cursor 3's right panel, adapted for governance.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { O8ActivityPane } from './O8ActivityPane';
import { O8ThreadTools } from './o8-panel/O8ThreadTools';
import { useHandoffSelection } from './o8-panel/useHandoffSelection';
import { SurfaceEmptyState } from './o8-panel/SurfaceEmptyState';
import { O8ResourcesPane } from './O8ResourcesPane';
import { O8BrowserPane } from './O8BrowserPane';
import { DevicePanel } from './o8-panel/devices/DevicePanel';
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
import { LinkedPullRequests } from './pr-panel/LinkedPullRequests';
import { WorkspaceFilesPane } from './o8-panel/workspace-rail/WorkspaceFilesPane';
import { ContextualPanel, type ContextualPanelHandle, type ContextualPanelProps } from './ContextualPanel';
import { canonicalPanelTab, isRightUtilityTab, type O8Tab } from './o8-panel/types';
import { O8PanelSplitDivider, panelPaneStyle, panelPaneVisible } from './o8-panel/O8PanelSplit';
import { ChatIcon, ReviewIcon, TerminalIcon, RightUtilityTabStrip, RightUtilityLauncher, type RightUtilityTab } from './o8-panel/O8PanelUtilityTabs';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { retryingLazy } from '@/lib/react/retrying-lazy';
const LazyOrchestratorTab = retryingLazy(() => import('@/components/desktop/workspace-terminal/OrchestratorTab').then((module) => ({ default: module.OrchestratorTab })), { label: 'Orchestrator tab' });

interface O8PanelProps {
  /** Mounted panels retain drafts, but hidden panels do not own live previews. */
  active?: boolean;
  repoPath?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  linkableRepos?: RepoRegistryEntry[];
  prContextId?: string;
  prContextTabId?: string | null;
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
  secondaryTab?: O8Tab | null;
  onSecondaryTabChange?: (tab: O8Tab) => void;
  selectedFile?: string | null;
  reviewLaneId?: string | null;
  browserUrl?: string | null;
  browserStateKey?: string;
  // Bubbles the browser pane's active URL up so the TitleBar Browser
  // button can render a hover preview iframe pointed at it.
  onBrowserActiveUrlChange?: (url: string | null) => void;
  /** Portal target for browser pages or utility tabs in the column header. */
  headerTabSlot?: HTMLElement | null;
  onSelectedFileChange?: (filePath: string) => void;
  commitSha?: string | null;
  onClearCommit?: () => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onClosePR?: (prNumber: number, repo?: string | null) => void;
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

// ── Main Component ──

export function O8Panel({
  active = true,
  repoPath,
  registeredRepos = [],
  linkableRepos = registeredRepos,
  prContextId,
  prContextTabId = null,
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
  secondaryTab: externalSecondaryTab = null,
  onSecondaryTabChange,
  selectedFile,
  reviewLaneId,
  browserUrl,
  browserStateKey = 'right-panel',
  onBrowserActiveUrlChange,
  headerTabSlot = null,
  onSelectedFileChange,
  onSelectCommit,
  onSelectIssue,
  onSelectPR,
  onClosePR,
  registerContextualPanelHandle,
  sendTerminalCreate,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
  sendAgentKill,
  termWsConnected = false,
}: O8PanelProps) {
  const activeTab = canonicalPanelTab(externalTab ?? 'activity');
  const requestedSecondary = externalSecondaryTab ? canonicalPanelTab(externalSecondaryTab) : null;
  const secondaryTab = requestedSecondary === activeTab ? null : requestedSecondary;
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [splitRatio, setSplitRatio] = useState(() => {
    if (typeof window === 'undefined') return 50;
    try {
      const saved = Number(window.localStorage.getItem('o8:right-panel:split-ratio'));
      if (Number.isFinite(saved) && saved >= 25 && saved <= 75) return saved;
    } catch { /* ignore */ }
    return 50;
  });
  useEffect(() => {
    try { window.localStorage.setItem('o8:right-panel:split-ratio', String(splitRatio)); } catch { /* ignore */ }
  }, [splitRatio]);
  const paneStyle = (tab: O8Tab) => panelPaneStyle(tab, activeTab, secondaryTab, splitRatio);
  const paneVisible = (tab: O8Tab) => panelPaneVisible(tab, activeTab, secondaryTab, active);
  // Browser is EXCLUDED from the utility shell (Q ruling 2026-07-12) — it's
  // a first-class drawer state whose pages render in the header rail, so it
  // never earns a strip row. activeTab === 'browser' renders the dedicated
  // main mount below instead.
  const activeUtilityTab = isRightUtilityTab(activeTab) && activeTab !== 'browser' ? activeTab : null;
  const utilityShellActive = !secondaryTab && (activeTab === 'launcher' || activeUtilityTab !== null);
  // Best-of-N compare matrix (item 3) — the first ready comparison group, read
  // from mission state. useOrchestratorData returns null outside the provider, so
  // this is inert when there's no orchestrator context.
  const orchestratorData = useOrchestratorData();
  const { readyGroups: compareReadyGroups } = useComparisonGroups(orchestratorData?.missionState);
  const compareGroup = compareReadyGroups[0] ?? null;
  const [utilityTabs, setUtilityTabs] = useState<RightUtilityTab[]>([]);
  const rightContextualPanelRef = useRef<ContextualPanelHandle | null>(null);
  const [localSelectedFile, setLocalSelectedFile] = useState<{ repoPath: string | null; path: string } | null>(null);
  // #1169 — orchestrator-driven browser open. The o8:open-browser window event
  // (fired by the o8_view_open_browser MCP tool) sets this; it overrides the
  // parent-owned browserUrl prop so the agent can open the Browser tab to a URL
  // in one call instead of snapshot/click-hunting. Cleared whenever the parent
  // drives its own navigation so the prop is never shadowed by a stale value.
  const [pendingBrowserNavigation, setPendingBrowserNavigation] = useState<{ baseUrl: string | null | undefined; url: string } | null>(null);
  const handoffSelection = useHandoffSelection(repoPath, onRepoPathChange, onActiveTabChange, orchestratorData?.onOpenO8Panel);
  const pendingBrowserUrl = pendingBrowserNavigation?.baseUrl === browserUrl ? pendingBrowserNavigation?.url ?? null : null;
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
  const selectedUtilityFile = selectedFile ?? (localSelectedFile?.repoPath === (repoPath ?? null) ? localSelectedFile.path : null);
  const renderedUtilityTabs = activeUtilityTab && !utilityTabs.includes(activeUtilityTab)
    ? [...utilityTabs, activeUtilityTab]
    : utilityTabs;
  const splitUtilityTabs = secondaryTab
    ? [activeTab, secondaryTab].filter((tab): tab is RightUtilityTab => isRightUtilityTab(tab) && tab !== 'browser')
    : [];
  const secondaryUtilityTab = secondaryTab && isRightUtilityTab(secondaryTab) && secondaryTab !== 'browser' ? secondaryTab : null;
  const mountedUtilityTabs = [...new Set([...renderedUtilityTabs, ...splitUtilityTabs])];
  useEffect(() => {
    if (!activeUtilityTab && !secondaryUtilityTab) return;
    queueMicrotask(() => {
      setUtilityTabs((prev) => [...new Set([...prev, ...[activeUtilityTab, secondaryUtilityTab].filter((tab) => tab !== null)])]);
    });
  }, [activeUtilityTab, secondaryUtilityTab]);

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

  const closeRightUtilityTab = useCallback(async (tab: RightUtilityTab) => {
    if (tab === 'terminal' && rightContextualPanelRef.current?.confirmClose && !await rightContextualPanelRef.current.confirmClose()) return false;
    const remaining = utilityTabs.filter((entry) => entry !== tab);
    setUtilityTabs(remaining);
    if (activeTab === tab) {
      const currentIndex = utilityTabs.indexOf(tab);
      onActiveTabChange?.(remaining[Math.min(currentIndex, remaining.length - 1)] ?? 'launcher');
    }
    return true;
  }, [activeTab, onActiveTabChange, utilityTabs]);

  const handleSelectUtilityFile = useCallback((path: string) => {
    setLocalSelectedFile({ repoPath: repoPath ?? null, path });
    onSelectedFileChange?.(path);
  }, [onSelectedFileChange, repoPath]);

  const handleRightContextualPanelRef = useCallback((handle: ContextualPanelHandle | null) => {
    rightContextualPanelRef.current = handle;
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
        setLocalSelectedFile({ repoPath: detail.repoPath || repoPath || null, path: detail.file });
        onSelectedFileChange?.(detail.file);
      }
    };
    window.addEventListener('o8:focus-review', handler);
    return () => window.removeEventListener('o8:focus-review', handler);
  }, [onActiveTabChange, onRepoPathChange, onSelectedFileChange, repoPath]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ repoPath?: string; path?: string | null }>).detail;
      if (!detail?.repoPath) return;
      onRepoPathChange?.(detail.repoPath);
      setLocalSelectedFile(detail.path ? { repoPath: detail.repoPath, path: detail.path } : null);
      onSelectedFileChange?.(detail.path ?? '');
      onActiveTabChange?.('files');
    };
    window.addEventListener('o8:browse-review-file', handler);
    return () => window.removeEventListener('o8:browse-review-file', handler);
  }, [onActiveTabChange, onRepoPathChange, onSelectedFileChange]);

  // #1169 — the o8_view_open_browser MCP tool dispatches `o8:open-browser`;
  // reveal the Browser tab and (optionally) navigate it. One deterministic
  // action instead of the snapshot/click hunt that cost the orchestrator ~5 min.
  useEffect(() => {
    const handler = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string | null }>).detail?.url;
      onActiveTabChange?.('browser');
      if (typeof url === 'string' && url.trim()) setPendingBrowserNavigation({ baseUrl: browserUrl, url: url.trim() });
    };
    window.addEventListener('o8:open-browser', handler);
    return () => window.removeEventListener('o8:open-browser', handler);
  }, [browserUrl, onActiveTabChange]);

  const renderUtilitySurface = (tab: RightUtilityTab, active: boolean) => {
    if (tab === 'device') return <DevicePanel active={active} />;
    if (tab === 'files') {
      return (
        <WorkspaceFilesPane repoPath={repoPath} selectedFile={selectedUtilityFile} dirtyFiles={dirtyFiles} onSelectFile={handleSelectUtilityFile} />
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
          tabStripSlot={headerTabSlot}
          onFocusRequest={() => onActiveTabChange?.('browser')}
        />
      );
    }

    if (tab === 'review') {
      return <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottom: '1px solid var(--t-divider)', flexShrink: 0 }}>
          <O8RepoSelector active={active} repos={registeredRepos} allRepos={allRepos} selectedRepoPath={repoPath ?? null} onSelectAll={() => onSelectAllRepos?.()} onSelectRepo={(path) => onRepoPathChange?.(path)} style={{ flex: 1 }} />
        </div>
        <LinkedPullRequests context={prContextId ?? `worktree:${repoPath ?? 'unbound'}`} tabId={prContextTabId} repoPath={repoPath ?? null} repos={linkableRepos} active={active} onOpen={onSelectPR} />
        {allRepos ? <ProjectChangesOverview repos={registeredRepos} onPickRepo={(path) => onRepoPathChange?.(path)} /> : repoPath
          ? <ReviewPanel repoPath={repoPath} registeredRepos={reviewRepos} onRepoPathChange={onRepoPathChange} selectedFile={selectedUtilityFile} reviewLaneId={reviewLaneId} />
          : <SurfaceEmptyState icon={<ReviewIcon size={18} />} title="No repository selected" detail="Select a repository to review its changes." />}
      </>;
    }

    if (tab === 'threads') return <O8ThreadTools active={active} exchanges={externalTab === 'handoffs' || externalSecondaryTab === 'handoffs'} onViewChange={(exchanges) => (secondaryTab === 'threads' ? onSecondaryTabChange : onActiveTabChange)?.(exchanges ? 'handoffs' : 'threads')} repoPath={repoPath ?? null} repos={registeredRepos} allRepos={allRepos} onRepoPathChange={onRepoPathChange} selection={handoffSelection} />;
    if (tab === 'activity') return <O8ActivityPane active={active} repoPath={repoPath} repoSlug={prRepo ?? repoSlug} registeredRepos={registeredRepos} allRepos={allRepos} onSelectAllRepos={onSelectAllRepos} onSelectRepoPath={onRepoPathChange} onSelectCommit={onSelectCommit} onSelectIssue={onSelectIssue} onSelectPR={onSelectPR} onClosePR={onClosePR} selectedPrNumber={prNumber ?? null} selectedPrRepo={prRepo ?? null} />;
    if (tab === 'resources') return <O8ResourcesPane active={active} />;
    if (tab === 'targets') return <TargetsPanel repoPath={repoPath} active={active} />;
    if (tab === 'spec') return <O8SpecPane repoPath={repoPath} active={active} toolbarSlot={(specRepoPath) => <O8ScratchChat repoPath={specRepoPath} selectedFile={specRepoPath === repoPath ? selectedFile ?? null : null} surface="diff" surfaceLabel="o8.md" />} />;

    if (tab === 'inbox') {
      // Incident Queue is a closeable contextual surface now (report RVKTQV):
      // it joins the utility strip like Review/Files rather than force-taking
      // the panel. The status-bar / header approval badge re-opens it.
      return <O8InboxPane active={active} repoPath={repoPath ?? null} repos={registeredRepos} />;
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
          showPanelLabel={false}
          onClose={() => { void closeRightUtilityTab('terminal'); }}
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
      ref={splitContainerRef}
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
          Operator restored post-#1089 (same restore-after-rework pattern). Mounts once per panel;
          internal Cmd+E hotkey + button click open the floating dialog. The
          review/workspace tab owns its compact toolbar trigger inside
          ReviewPanel; Activity/PR detail suppress it to keep local toolbars
          clear. o8.md/spec also suppresses the floating overlay — the
          Ask-o8 chat trigger renders inline in the spec pane's own
          toolbar (passed via toolbarSlot below) so all three buttons
          (Ask-o8 chat, Ask-to-review, Settings) sit in one row. */}
      {/* No Brain chat on the browser — it's a real browser now (Q ruling
          2026-07-12); its header/toolbar carry browser tools instead. */}
      {!utilityShellActive && activeTab !== 'workspace' && activeTab !== 'threads' && activeTab !== 'spec' && activeTab !== 'activity' && activeTab !== 'prs' && activeTab !== 'browser' && activeTab !== 'resources' && activeTab !== 'inbox' && activeTab !== 'device' && activeTab !== 'review' ? (
        <div style={{ position: 'absolute', top: 8, right: 12, zIndex: 5 }}>
          <O8ScratchChat
            repoPath={repoPath}
            selectedFile={selectedFile ?? null}
            surface="diff"
            surfaceLabel="panel"
          />
        </div>
      ) : null}

      {/* Open tools retain their state when another tab is selected. */}
      {secondaryTab && onSecondaryTabChange ? (
        <O8PanelSplitDivider
          secondary={secondaryTab}
          ratio={splitRatio}
          onRatioChange={setSplitRatio}
          onSecondaryChange={onSecondaryTabChange}
          containerRef={splitContainerRef}
        />
      ) : null}
      {utilityShellActive ? headerTabSlot ? createPortal(
        <RightUtilityTabStrip tabs={mountedUtilityTabs} activeTab={activeTab === 'activity' && prNumber ? 'prs' : activeTab} inHeader onOpenLauncher={() => onActiveTabChange?.('launcher')} onSelect={(tab) => onActiveTabChange?.(tab)} onClose={closeRightUtilityTab} />, headerTabSlot,
      ) : <RightUtilityTabStrip tabs={mountedUtilityTabs} activeTab={activeTab === 'activity' && prNumber ? 'prs' : activeTab} onOpenLauncher={() => onActiveTabChange?.('launcher')} onSelect={(tab) => onActiveTabChange?.(tab)} onClose={closeRightUtilityTab} /> : null}
      {activeTab === 'launcher' || secondaryTab === 'launcher' ? <div style={paneStyle('launcher')}><RightUtilityLauncher onOpen={openRightUtilityTab} /></div> : null}
      {mountedUtilityTabs.map((tab) => <div key={tab} aria-hidden={!paneVisible(tab)} inert={!paneVisible(tab)} style={{ ...paneStyle(tab), background: 'var(--t-bg)' }}>
        {renderUtilitySurface(tab, paneVisible(tab))}
      </div>)}
      <div style={paneStyle('browser')}>
        {/* The utility-mounted browser wins the header slot when both exist —
            two instances portaling into one node would duplicate the pills. */}
        <O8BrowserPane
          key={browserStateKey}
          previews={previews}
          navigateToUrl={pendingBrowserUrl ?? browserUrl}
          stateScopeKey={browserStateKey}
          onActiveUrlChange={onBrowserActiveUrlChange}
          tabStripSlot={paneVisible('browser') && !secondaryTab ? headerTabSlot : null}
          onFocusRequest={() => onActiveTabChange?.('browser')}
        />
      </div>
      <div style={paneStyle('compare')}>
        {compareGroup ? (
          <ComparisonMatrix group={compareGroup} />
        ) : (
          <div style={{ paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-faint)' }}>
            No comparison ready yet. Dispatch a best-of-N mission (set comparisonModels on create_mission) and the candidates land here side by side once they finish.
          </div>
        )}
      </div>

    </div>
  );
}
