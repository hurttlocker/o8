'use client';

/**
 * O8Panel — Wide contextual panel with Workspace, Browser, Activity, Inbox, and spec tabs.
 *
 * Third state of the right panel morph button (collapsed → review → o8).
 * Modeled after Cursor 3's right panel, adapted for governance.
 */

import { useEffect } from 'react';
import { O8ActivityPane } from './O8ActivityPane';
import { O8BrowserPane } from './O8BrowserPane';
import { O8InboxPane } from './O8InboxPane';
import { O8SpecPane } from './o8-panel/O8SpecPane';
import { O8ScratchChat } from './o8-panel/workspace-rail/O8ScratchChat';
import { ReviewPanel } from './review/ReviewPanel';
import { O8RepoSelector } from './o8-panel/O8RepoSelector';
import { ProjectChangesOverview } from './o8-panel/ProjectChangesOverview';
import type { O8Tab } from './o8-panel/types';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
// O8 panel uses the native dark theme — no LIGHT_CANVAS_VARS override needed

interface O8PanelProps {
  repoPath?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  onRepoPathChange?: (repoPath: string) => void;
  /** Shared repo scope: true = "All repos" aggregate across the active project. */
  allRepos?: boolean;
  onSelectAllRepos?: () => void;
  previews?: DetectedLocalhostPreview[];
  onEditWithAI?: (context: string) => void;
  onOpenFile?: (filePath: string) => void;
  prNumber?: number | null;
  prRepo?: string | null;
  repoSlug?: string | null;
  activeTab?: O8Tab | null;
  selectedFile?: string | null;
  browserUrl?: string | null;
  // Bubbles the browser pane's active URL up so the TitleBar Browser
  // button can render a hover preview iframe pointed at it.
  onBrowserActiveUrlChange?: (url: string | null) => void;
  onSelectedFileChange?: (filePath: string) => void;
  commitSha?: string | null;
  onClearCommit?: () => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
}

// ── Main Component ──

export function O8Panel({ repoPath, registeredRepos = [], onRepoPathChange, allRepos = false, onSelectAllRepos, previews = [], onEditWithAI, onOpenFile, prNumber, prRepo, repoSlug, activeTab: externalTab, selectedFile, browserUrl, onBrowserActiveUrlChange, onSelectCommit, onSelectIssue }: O8PanelProps) {
  const activeTab = externalTab ?? 'activity';
  // The shared O8RepoSelector in the workspace header owns repo switching now,
  // so hide ReviewPanel's built-in dropdown: a single-entry list trips its own
  // `registeredRepos.length > 1` guard and keeps the inline selector hidden.
  const reviewRepos = registeredRepos.filter((r) => r.localPath === repoPath);

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

  return (
    <div
      data-chrome-surface="true"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--t-bg)',
        borderLeft: '1px solid var(--t-divider)',
      }}
    >
      {/* Scratch chat — floating Ask-o8 button + dialog, sits across tabs where
          it does not compete with local document/review controls.
          Operator restored post-#1089 ([[borrow_conductor_steer_queue]]
          sibling — same restore-after-rework pattern). Mounts once per panel;
          internal Cmd+E hotkey + button click open the floating dialog. The
          review/workspace tab owns its compact toolbar trigger inside
          ReviewPanel; Activity/PR detail and o8.md/spec suppress it to keep
          local toolbars clear. */}
      {activeTab !== 'workspace' && activeTab !== 'spec' && activeTab !== 'activity' && activeTab !== 'prs' ? (
        <div style={{ position: 'absolute', top: 8, right: 12, zIndex: 5 }}>
          <O8ScratchChat
            repoPath={repoPath}
            selectedFile={selectedFile ?? null}
            surface="diff"
          />
        </div>
      ) : null}

      {/* Tab content — all tabs stay mounted to preserve state */}
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
          <ReviewPanel repoPath={repoPath} registeredRepos={reviewRepos} onRepoPathChange={onRepoPathChange} selectedFile={selectedFile ?? null} />
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'browser' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8BrowserPane previews={previews} onEditWithAI={onEditWithAI} onOpenFile={onOpenFile} navigateToUrl={browserUrl} onActiveUrlChange={onBrowserActiveUrlChange} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'activity' || activeTab === 'prs' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8ActivityPane repoPath={repoPath} repoSlug={prRepo ?? repoSlug} registeredRepos={registeredRepos} allRepos={allRepos} onSelectAllRepos={onSelectAllRepos} onSelectRepoPath={onRepoPathChange} onSelectCommit={onSelectCommit} onSelectIssue={onSelectIssue} selectedPrNumber={prNumber ?? null} selectedPrRepo={prRepo ?? null} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'inbox' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8InboxPane />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'spec' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8SpecPane repoPath={repoPath} />
      </div>
    </div>
  );
}
