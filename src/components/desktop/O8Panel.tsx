'use client';

/**
 * O8Panel — Wide contextual panel with tabs: Changes, Browser, Files, PRs.
 *
 * Third state of the right panel morph button (collapsed → review → o8).
 * Modeled after Cursor 3's right panel, adapted for governance.
 */

import { useState } from 'react';
import { O8ActivityPane } from './O8ActivityPane';
import { O8BrowserPane } from './O8BrowserPane';
import { O8ChangesPane } from './O8ChangesPane';
import { O8FilesPane } from './O8FilesPane';
import { O8PRPane } from './O8PRPane';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
// O8 panel uses the native dark theme — no LIGHT_CANVAS_VARS override needed

// ── Phosphor Icons (raw SVG, per CLAUDE.md) ──

function IconGitDiff({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v4c0 2 2 4 4 4h1" />
      <path d="M18 15v-4c0-2-2-4-4-4h-1" />
    </svg>
  );
}

function IconGlobeSimple({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function IconFiles({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconGitPullRequest({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

function IconActivity({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

export type O8Tab = 'changes' | 'browser' | 'files' | 'prs' | 'activity';

interface O8PanelProps {
  onClose: () => void;
  repoPath?: string | null;
  previews?: DetectedLocalhostPreview[];
  onEditWithAI?: (context: string) => void;
  onOpenFile?: (filePath: string) => void;
  prNumber?: number | null;
  prRepo?: string | null;
  repoSlug?: string | null;
  activeTab?: O8Tab | null;
  browserUrl?: string | null;
  onActiveTabChange?: (tab: O8Tab) => void;
  commitSha?: string | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
}

// ── Tab Button ──

const O8_ICON_ACTIVE = '#e2e8f0';
const O8_ICON_INACTIVE = 'rgba(255,255,255,0.35)';

function O8TabButton({ icon, active, onClick, label }: {
  icon: (color: string) => React.ReactNode;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        border: 'none',
        borderRadius: 8,
        background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
        cursor: 'pointer',
        transition: 'background 120ms ease',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {icon(active ? O8_ICON_ACTIVE : O8_ICON_INACTIVE)}
    </button>
  );
}

// ── Main Component ──

export function O8Panel({ onClose, repoPath, previews = [], onEditWithAI, onOpenFile, prNumber, prRepo, repoSlug, activeTab: externalTab, browserUrl, onActiveTabChange, commitSha, onSelectCommit, onSelectPR, onSelectIssue }: O8PanelProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<O8Tab>('changes');
  const activeTab = externalTab ?? internalActiveTab;

  const handleTabChange = (tab: O8Tab) => {
    if (onActiveTabChange) {
      onActiveTabChange(tab);
      return;
    }
    setInternalActiveTab(tab);
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--t-bg)',
      borderLeft: '1px solid var(--t-divider)',
    }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        height: 40,
        paddingLeft: 8,
        paddingRight: 8,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
        gap: 2,
      }}>
        <O8TabButton icon={(c) => <IconGitDiff size={16} color={c} />} active={activeTab === 'changes'} onClick={() => handleTabChange('changes')} label="Changes" />
        <O8TabButton icon={(c) => <IconFiles size={16} color={c} />} active={activeTab === 'files'} onClick={() => handleTabChange('files')} label="Files" />
        <O8TabButton icon={(c) => <IconGitPullRequest size={16} color={c} />} active={activeTab === 'prs'} onClick={() => handleTabChange('prs')} label="PRs" />
        <O8TabButton icon={(c) => <IconGlobeSimple size={16} color={c} />} active={activeTab === 'browser'} onClick={() => handleTabChange('browser')} label="Browser" />
        <O8TabButton icon={(c) => <IconActivity size={16} color={c} />} active={activeTab === 'activity'} onClick={() => handleTabChange('activity')} label="Activity" />
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          title="Close panel"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            transition: 'background 120ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Tab content — all tabs stay mounted to preserve state */}
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'changes' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8ChangesPane repoPath={repoPath} initialCommitSha={commitSha} repoSlug={repoSlug} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'browser' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8BrowserPane previews={previews} onEditWithAI={onEditWithAI} onOpenFile={onOpenFile} navigateToUrl={browserUrl} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'files' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8FilesPane repoPath={repoPath ?? undefined} onOpenFile={onOpenFile} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'prs' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8PRPane prNumber={prNumber} repo={prRepo ?? repoSlug} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: activeTab === 'activity' ? 'flex' : 'none', flexDirection: 'column' }}>
        <O8ActivityPane repoSlug={repoSlug} onSelectCommit={onSelectCommit} onSelectPR={onSelectPR} onSelectIssue={onSelectIssue} />
      </div>
    </div>
  );
}
