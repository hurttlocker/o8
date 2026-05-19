'use client';

/**
 * O8Panel — Wide contextual panel with Workspace, Browser, PRs, Inbox, Activity, and spec tabs.
 *
 * Third state of the right panel morph button (collapsed → review → o8).
 * Modeled after Cursor 3's right panel, adapted for governance.
 */

import { useEffect } from 'react';
import { O8ActivityPane } from './O8ActivityPane';
import { O8BrowserPane } from './O8BrowserPane';
import { O8PRPane } from './O8PRPane';
import { O8InboxPane } from './O8InboxPane';
import { O8SpecPane } from './o8-panel/O8SpecPane';
import { ReviewPanel } from './review/ReviewPanel';
import type { O8Tab } from './o8-panel/types';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
// O8 panel uses the native dark theme — no LIGHT_CANVAS_VARS override needed

interface O8PanelProps {
  repoPath?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  onRepoPathChange?: (repoPath: string) => void;
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

export function O8Panel({ repoPath, registeredRepos = [], onRepoPathChange, previews = [], onEditWithAI, onOpenFile, prNumber, prRepo, repoSlug, activeTab: externalTab, browserUrl, onBrowserActiveUrlChange, onSelectCommit, onSelectPR, onSelectIssue }: O8PanelProps) {
  const activeTab = externalTab ?? 'activity';

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
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--t-bg)',
        borderLeft: '1px solid var(--t-divider)',
      }}
    >
      {/* Tab content — all tabs stay mounted to preserve state */}
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'workspace' ? 'flex' : 'none', flexDirection: 'column' }}>
        <ReviewPanel repoPath={repoPath} registeredRepos={registeredRepos} onRepoPathChange={onRepoPathChange} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'browser' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8BrowserPane previews={previews} onEditWithAI={onEditWithAI} onOpenFile={onOpenFile} navigateToUrl={browserUrl} onActiveUrlChange={onBrowserActiveUrlChange} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'prs' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8PRPane prNumber={prNumber} repo={prRepo ?? repoSlug} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'activity' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8ActivityPane repoSlug={repoSlug} registeredRepos={registeredRepos} onSelectCommit={onSelectCommit} onSelectPR={onSelectPR} onSelectIssue={onSelectIssue} />
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
