'use client';

import { useState } from 'react';
import type { WorkspacePanelTabId, WorkspaceSidePanelRepo, WorkspaceSidePanelView } from './types';
import { shortenPath, PanelTab, FilesTabDropdown } from './shared';
import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';
import { GitLogTab } from './GitLogTab';

export function WorkspaceSidePanel({
  view,
  repo,
  agentContext,
  onClearView,
  onOpenFile,
  onSelectCommit,
}: {
  view: WorkspaceSidePanelView;
  repo: WorkspaceSidePanelRepo | null;
  onClearView: () => void;
  onOpenFile: (path: string, repo: WorkspaceSidePanelRepo | null) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  agentContext?: { branch: string; fileCount: number; agentLabel: string; agentRunning: boolean } | null;
}) {
  const [activeTab, setActiveTab] = useState<WorkspacePanelTabId>(() => (
    view === 'git-log' ? 'git-log' : 'changes'
  ));

  if (view === 'blank') {
    return (
      <div
        aria-label="Workspace side panel"
        style={{
          flex: 1,
          background: 'var(--t-bg-gradient)',
        }}
      />
    );
  }

  const headerScopeSubtitle = agentContext
    ? [
        agentContext.branch,
        `${agentContext.fileCount} file${agentContext.fileCount !== 1 ? 's' : ''}`,
        `${agentContext.agentLabel} ${agentContext.agentRunning ? 'running' : 'idle'}`,
      ].join(' \u00B7 ')
    : repo
      ? [
          repo.branch ? (repo.isWorktree ? `${repo.branch} \u00B7 worktree` : repo.branch) : null,
          shortenPath(repo.localPath),
        ].filter((value): value is string => Boolean(value)).join(' \u00B7 ')
      : 'Workspace side panel';

  return (
    <div
      data-chrome-surface="true"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderBottom: '0.5px solid rgba(0, 0, 0, 0.04)',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{repo?.name ?? 'Workspace'}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {headerScopeSubtitle}
          </div>
        </div>
        <button
          type="button"
          onClick={onClearView}
          title="Clear workspace panel"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '8px 10px',
          borderBottom: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <FilesTabDropdown
          activeTab={activeTab}
          onSelectTab={setActiveTab}
        />
        <PanelTab active={activeTab === 'git-log'} label="Git Log" onClick={() => setActiveTab('git-log')} />
      </div>

      {activeTab === 'changes' ? <ChangesTab repo={repo} onOpenFile={onOpenFile} /> : null}
      {activeTab === 'files' ? <FilesTab repo={repo} mode="all" onOpenFile={onOpenFile} /> : null}
      {activeTab === 'env' ? <FilesTab repo={repo} mode="env" onOpenFile={onOpenFile} /> : null}
      {activeTab === 'git-log' ? <GitLogTab repo={repo} onSelectCommit={onSelectCommit} /> : null}
    </div>
  );
}
