'use client';

/**
 * O8Panel — Wide contextual panel with Workspace, Browser, Activity, Inbox, and spec tabs.
 *
 * Third state of the right panel morph button (collapsed → review → o8).
 * Modeled after Cursor 3's right panel, adapted for governance.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { O8ActivityPane } from './O8ActivityPane';
import { O8HandoffsPane } from './O8HandoffsPane';
import { SurfaceEmptyState } from './o8-panel/SurfaceEmptyState';
import { O8ResourcesPane } from './O8ResourcesPane';
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
import { WorkspaceBrowserPreview } from './o8-panel/WorkspaceBrowserPreview';
import { AllFilesTree } from './o8-panel/workspace-rail/AllFilesTree';
import { FileViewer } from './o8-panel/workspace-rail/FileViewer';
import { ContextualPanel, type ContextualPanelHandle, type ContextualPanelProps } from './ContextualPanel';
import type { O8Tab } from './o8-panel/types';
import { O8PanelSplitDivider, panelPaneStyle, panelPaneVisible } from './o8-panel/O8PanelSplit';
import { ChatIcon, ReviewIcon, TerminalIcon, RightUtilityTabStrip, RightUtilityLauncher, isRightUtilityTab, type RightUtilityTab } from './o8-panel/O8PanelUtilityTabs';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { retryingLazy } from '@/lib/react/retrying-lazy';
// O8 panel uses the native dark theme — no LIGHT_CANVAS_VARS override needed

const LazyOrchestratorTab = retryingLazy(() => import('@/components/desktop/workspace-terminal/OrchestratorTab').then((module) => ({ default: module.OrchestratorTab })), { label: 'Orchestrator tab' });

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
  secondaryTab?: O8Tab | null;
  onSecondaryTabChange?: (tab: O8Tab) => void;
  selectedFile?: string | null;
  reviewLaneId?: string | null;
  browserUrl?: string | null;
  browserStateKey?: string;
  // Bubbles the browser pane's active URL up so the TitleBar Browser
  // button can render a hover preview iframe pointed at it.
  onBrowserActiveUrlChange?: (url: string | null) => void;
  /** Header-rail portal target for the browser's page tabs
   *  (Q 2026-07-12) — provided by the dashboard's PanelHeaderStrip. Pages
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
  secondaryTab = null,
  onSecondaryTabChange,
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
  const paneVisible = (tab: O8Tab) => panelPaneVisible(tab, activeTab, secondaryTab);
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
  const [localSelectedFile, setLocalSelectedFile] = useState<string | null>(null);
  // #1169 — orchestrator-driven browser open. The o8:open-browser window event
  // (fired by the o8_view_open_browser MCP tool) sets this; it overrides the
  // parent-owned browserUrl prop so the agent can open the Browser tab to a URL
  // in one call instead of snapshot/click-hunting. Cleared whenever the parent
  // drives its own navigation so the prop is never shadowed by a stale value.
  const [pendingBrowserNavigation, setPendingBrowserNavigation] = useState<{ baseUrl: string | null | undefined; url: string } | null>(null);
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
  const selectedUtilityFile = selectedFile ?? localSelectedFile;
  const renderedUtilityTabs = activeUtilityTab && !utilityTabs.includes(activeUtilityTab)
    ? [...utilityTabs, activeUtilityTab]
    : utilityTabs;
  const splitUtilityTabs = secondaryTab
    ? [activeTab, secondaryTab].filter((tab): tab is RightUtilityTab => isRightUtilityTab(tab) && tab !== 'browser')
    : [];
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
      if (typeof url === 'string' && url.trim()) setPendingBrowserNavigation({ baseUrl: browserUrl, url: url.trim() });
    };
    window.addEventListener('o8:open-browser', handler);
    return () => window.removeEventListener('o8:open-browser', handler);
  }, [browserUrl, onActiveTabChange]);

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

    if (tab === 'inbox') {
      // Incident Queue is a closeable contextual surface now (report RVKTQV):
      // it joins the utility strip like Review/Files rather than force-taking
      // the panel. The status-bar / header approval badge re-opens it.
      return <O8InboxPane active={active} />;
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
      {!utilityShellActive && activeTab !== 'workspace' && activeTab !== 'spec' && activeTab !== 'activity' && activeTab !== 'prs' && activeTab !== 'browser' && activeTab !== 'resources' ? (
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
      {secondaryTab && onSecondaryTabChange ? (
        <O8PanelSplitDivider
          secondary={secondaryTab}
          ratio={splitRatio}
          onRatioChange={setSplitRatio}
          onSecondaryChange={onSecondaryTabChange}
          containerRef={splitContainerRef}
        />
      ) : null}
      {secondaryTab && splitUtilityTabs.map((tab) => (
        <div key={`split-${tab}`} style={{ ...paneStyle(tab), background: 'var(--t-bg)' }}>
          {renderUtilitySurface(tab, true)}
        </div>
      ))}
      {secondaryTab && (activeTab === 'launcher' || secondaryTab === 'launcher') ? (
        <div style={paneStyle('launcher')}><RightUtilityLauncher onOpen={openRightUtilityTab} /></div>
      ) : null}
      {!secondaryTab && (utilityShellActive || renderedUtilityTabs.length > 0) ? (
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
      <div style={paneStyle('workspace')}>
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
        <WorkspaceBrowserPreview
          active={paneVisible('workspace')}
          suppressed={utilityShellActive && renderedUtilityTabs.includes('browser')}
          browserScopeKey={browserStateKey}
          onOpenBrowser={() => onActiveTabChange?.('browser')}
        />
        {allRepos ? (
          <ProjectChangesOverview repos={registeredRepos} onPickRepo={(path) => onRepoPathChange?.(path)} />
        ) : (
          <ReviewPanel repoPath={repoPath} registeredRepos={reviewRepos} onRepoPathChange={onRepoPathChange} selectedFile={selectedFile ?? null} reviewLaneId={reviewLaneId} />
        )}
      </div>
      <div style={paneStyle('browser')}>
        {/* The utility-mounted browser wins the header slot when both exist —
            two instances portaling into one node would duplicate the pills. */}
        <O8BrowserPane
          key={browserStateKey}
          previews={previews}
          navigateToUrl={pendingBrowserUrl ?? browserUrl}
          stateScopeKey={browserStateKey}
          onActiveUrlChange={onBrowserActiveUrlChange}
          tabStripSlot={secondaryTab === 'browser' || renderedUtilityTabs.includes('browser') ? null : browserHeaderTabSlot}
          onFocusRequest={() => onActiveTabChange?.('browser')}
        />
      </div>
      <div style={paneStyle('activity')}>
        <O8ActivityPane
          active={paneVisible('activity')}
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
      <div style={paneStyle('resources')}>
        <O8ResourcesPane active={paneVisible('resources')} />
      </div>
      <div style={paneStyle('handoffs')}>
        <O8HandoffsPane
          active={paneVisible('handoffs')}
          repoPath={repoPath}
          registeredRepos={registeredRepos}
          allRepos={allRepos ?? false}
          onRepoPathChange={onRepoPathChange}
        />
      </div>
      {/* Inbox (Incident Queue) now renders through the closeable utility strip
          above — see renderUtilitySurface('inbox'). No standalone main-tab mount
          (report RVKTQV): a second mount here would double the pane + its data
          subscriptions when the utility shell is active. */}
      <div style={paneStyle('spec')}>
        <O8SpecPane
          repoPath={repoPath}
          active={paneVisible('spec')}
          toolbarSlot={(specRepoPath) => (
            <O8ScratchChat
              repoPath={specRepoPath}
              selectedFile={specRepoPath === repoPath ? selectedFile ?? null : null}
              surface="diff"
              surfaceLabel="o8.md"
            />
          )}
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

      <div style={paneStyle('targets')}>
        <TargetsPanel repoPath={repoPath} active={paneVisible('targets')} />
      </div>
    </div>
  );
}
