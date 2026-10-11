'use client';
import { Suspense } from 'react';
import type React from 'react';
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '../repo-registry/shared';
import { O8BrowserPane } from '../O8BrowserPane';
import { WorkspaceFilesPane } from '../o8-panel/workspace-rail/WorkspaceFilesPane';
import { ReviewPanel } from '../review/ReviewPanel';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { BottomPanelSurfaceKind } from '../ContextualPanel';
import { retryingLazy } from '@/lib/react/retrying-lazy';
const LazyOrchestratorTab = retryingLazy(() => import('../workspace-terminal/OrchestratorTab').then((module) => ({ default: module.OrchestratorTab })), { label: 'Orchestrator tab' });

// ── CLI Agents (terminal only, no chat modes) ──

export const CLI_AGENTS = [
  { id: 'shell', label: 'Shell', color: '#64748b', command: null },
  { id: 'claude', label: 'Claude Code', color: '#e07a3a', command: 'claude' },
  { id: 'codex', label: 'Codex', color: '#6b7280', command: 'codex' },
  { id: 'opencode', label: 'OpenCode 2', color: '#fb923c', command: 'opencode2' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4285f4', command: 'gemini' },
] as const;

export type CliAgent = (typeof CLI_AGENTS)[number];

export function AgentGlyph({ agentId, size = 14 }: { agentId: string; size?: number }) {
  if (agentId === 'claude') return <ClaudeIcon size={size} />;
  if (agentId === 'codex') return <CodexIcon size={size} />;
  if (agentId === 'opencode') return <OpenCodeIcon size={size} />;
  if (agentId === 'gemini') return <GeminiIcon size={size} />;
  // shell fallback — a small square/terminal glyph via AgentDot below
  return null;
}

// ── Helpers ──

export function AgentDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
    }} />
  );
}

// Lucide icons as raw SVG (Tauri webview compatibility)
export function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

export function FilesIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
      <path d="M2 10h20" />
    </svg>
  );
}

export function ChatIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </svg>
  );
}

export function BrowserIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 0 20" />
      <path d="M12 2a15.3 15.3 0 0 0 0 20" />
    </svg>
  );
}

export function ReviewIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="m9 15 2 2 4-5" />
    </svg>
  );
}

export function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

// ── Main Component ──

interface BottomPanelSurface {
  id: BottomPanelSurfaceKind;
  label: string;
  description: string;
  icon: (props: { size?: number }) => React.ReactNode;
}

export const BOTTOM_PANEL_SURFACES: BottomPanelSurface[] = [
  { id: 'files', label: 'Files', description: 'Browse project files', icon: FilesIcon },
  { id: 'side-chat', label: 'Side chat', description: 'Start a side conversation', icon: ChatIcon },
  { id: 'browser', label: 'Browser', description: 'Open a website', icon: BrowserIcon },
  { id: 'review', label: 'Review', description: 'View code changes', icon: ReviewIcon },
  { id: 'terminal', label: 'Terminal', description: 'Start an interactive shell', icon: TerminalIcon },
];

export const SURFACE_LABELS = Object.fromEntries(
  BOTTOM_PANEL_SURFACES.map((surface) => [surface.id, surface.label]),
) as Record<BottomPanelSurfaceKind, string>;

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
      <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--t-text)' }}>{title}</div>
      <div style={{ maxWidth: 360, fontSize: 12, lineHeight: 1.5 }}>{detail}</div>
    </div>
  );
}

export function BottomUtilitySurface({
  kind,
  tabId,
  active,
  repoPath,
  repoLabel,
  registeredRepos,
  previews,
  selectedFile,
  dirtyFiles,
  onSelectFile,
  onRepoPathChange,
}: {
  kind: Exclude<BottomPanelSurfaceKind, 'terminal'>;
  tabId: string;
  active: boolean;
  repoPath: string | null;
  repoLabel: string | null;
  registeredRepos: RepoRegistryEntry[];
  previews: DetectedLocalhostPreview[];
  selectedFile: string | null;
  dirtyFiles: Set<string>;
  onSelectFile: (path: string) => void;
  onRepoPathChange?: (repoPath: string) => void;
}) {
  if (kind === 'files') {
    return (
      <WorkspaceFilesPane repoPath={repoPath} selectedFile={selectedFile} dirtyFiles={dirtyFiles} onSelectFile={onSelectFile} />
    );
  }

  if (kind === 'side-chat') {
    return (
      <Suspense fallback={<SurfaceEmptyState icon={<ChatIcon size={18} />} title="Loading side chat" detail="Preparing a repo-aware conversation in the bottom panel." />}>
        <LazyOrchestratorTab
          tabId={tabId}
          active={active}
          repoPath={repoPath}
          repoLabel={repoLabel}
          initialMode="fleet"
          acceptHistoryThreadLoads={false}
          restoreLastThread={false}
          publishWorkspaceThread={false}
          persistLastThread={false}
          projectContextRailVisible={false}
        />
      </Suspense>
    );
  }

  if (kind === 'browser') {
    return (
      <O8BrowserPane previews={previews} />
    );
  }

  if (kind === 'review') {
    if (!repoPath) {
      return (
        <SurfaceEmptyState
          icon={<ReviewIcon size={18} />}
          title="No repository selected"
          detail="Select or register a repo before opening review in the bottom panel."
        />
      );
    }
    return (
      <ReviewPanel
        repoPath={repoPath}
        registeredRepos={registeredRepos}
        onRepoPathChange={onRepoPathChange}
        selectedFile={selectedFile}
      />
    );
  }

  return (
    <SurfaceEmptyState
      icon={<FilesIcon size={18} />}
      title={repoLabel ?? 'Bottom panel'}
      detail="Choose a bottom panel surface from the plus menu."
    />
  );
}
