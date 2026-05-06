'use client';
/* eslint-disable react-hooks/set-state-in-effect -- external focus requests intentionally sync selected workspace file */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTheme } from '@/lib/theme/context';
import { AllFilesTree } from './workspace-rail/AllFilesTree';
import { ChangesList, useWorkspaceChanges } from './workspace-rail/ChangesList';
import { DiffViewer } from './workspace-rail/DiffViewer';
import { FileViewer } from './workspace-rail/FileViewer';
import { O8ScratchChat } from './workspace-rail/O8ScratchChat';
import type { RepoRegistryEntry } from '@/lib/repos/types';

type ListMode = 'changes' | 'all';
type ViewerMode = 'diff' | 'file';
type WorkspaceRepoOption = Pick<RepoRegistryEntry, 'id' | 'name' | 'localPath' | 'defaultBranch' | 'readiness'>;

const UI_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const RAIL_WIDTH = 'clamp(224px, 30%, 292px)';
// Workspace pane local token block. Originally hardcoded for dark vibrancy
// (rgba whites). We now ship two variants and pick at render time via
// useTheme().paletteId so light + solid mode renders as paper instead of
// invisible white-on-white.
const O8_WORKSPACE_TOKENS_DARK = {
  colorScheme: 'dark',
  ['--t-bg' as string]: 'rgba(50, 57, 66, 0.42)',
  ['--t-bg-card' as string]: 'rgba(255, 255, 255, 0.07)',
  ['--t-bg-subtle' as string]: 'rgba(255, 255, 255, 0.055)',
  ['--t-panel' as string]: 'rgba(255, 255, 255, 0.055)',
  ['--t-panel-translucent' as string]: 'rgba(255, 255, 255, 0.045)',
  ['--t-panel-solid' as string]: 'linear-gradient(180deg, rgba(72, 80, 92, 0.54) 0%, rgba(50, 58, 69, 0.44) 100%)',
  ['--t-panel-border' as string]: 'rgba(255, 255, 255, 0.14)',
  ['--t-panel-shadow' as string]: '0 18px 44px rgba(0, 0, 0, 0.18)',
  ['--t-input-bg' as string]: 'rgba(255, 255, 255, 0.08)',
  ['--t-input-border' as string]: 'rgba(255, 255, 255, 0.16)',
  ['--t-border' as string]: 'rgba(255, 255, 255, 0.14)',
  ['--t-divider' as string]: 'rgba(255, 255, 255, 0.12)',
  ['--t-divider-subtle' as string]: 'rgba(255, 255, 255, 0.08)',
  ['--t-hover' as string]: 'rgba(255, 255, 255, 0.1)',
  ['--t-canvas-bg' as string]: 'rgba(49, 56, 66, 0.38)',
  ['--t-text' as string]: 'rgba(255, 255, 255, 0.94)',
  ['--t-text-strong' as string]: '#ffffff',
  ['--t-text-secondary' as string]: 'rgba(244, 248, 252, 0.78)',
  ['--t-text-muted' as string]: 'rgba(226, 232, 240, 0.62)',
  ['--t-text-faint' as string]: 'rgba(203, 213, 225, 0.44)',
  ['--t-accent' as string]: '#8fb4ff',
  ['--t-accent-soft' as string]: 'rgba(143, 180, 255, 0.14)',
  ['--t-accent-border' as string]: 'rgba(143, 180, 255, 0.28)',
  ['--t-brand-orange' as string]: '#f1c36a',
  ['--t-brand-red' as string]: '#f87171',
  ['--t-chat-surface-bg' as string]: 'rgba(255, 255, 255, 0.05)',
  ['--t-chat-surface-text' as string]: 'rgba(255, 255, 255, 0.94)',
  ['--t-chat-surface-text-secondary' as string]: 'rgba(244, 248, 252, 0.76)',
  ['--t-chat-surface-text-muted' as string]: 'rgba(226, 232, 240, 0.58)',
  ['--t-chat-surface-border' as string]: 'rgba(255, 255, 255, 0.12)',
  ['--t-chat-surface-input-bg' as string]: 'rgba(255, 255, 255, 0.08)',
  ['--t-chat-surface-input-border' as string]: 'rgba(255, 255, 255, 0.16)',
  ['--t-chat-surface-card-bg' as string]: 'rgba(255, 255, 255, 0.07)',
  ['--t-terminal-ansi-green' as string]: '#86efac',
  ['--t-terminal-ansi-bright-green' as string]: '#bbf7d0',
  ['--t-terminal-ansi-bright-red' as string]: '#fca5a5',
  ['--o8-workspace-header-bg' as string]: 'linear-gradient(180deg, rgba(255, 255, 255, 0.072) 0%, rgba(255, 255, 255, 0.035) 100%)',
  ['--o8-workspace-header-divider' as string]: 'rgba(255, 255, 255, 0.075)',
  ['--o8-workspace-control-bg' as string]: 'rgba(255, 255, 255, 0.062)',
  ['--o8-workspace-control-border' as string]: 'rgba(255, 255, 255, 0.13)',
  ['--o8-workspace-control-shadow' as string]: 'inset 0 1px 0 rgba(255, 255, 255, 0.1)',
  ['--o8-workspace-rail-header-bg' as string]: 'linear-gradient(180deg, rgba(255, 255, 255, 0.052) 0%, rgba(255, 255, 255, 0.028) 100%)',
  ['--o8-workspace-shell-bg' as string]: 'linear-gradient(180deg, rgba(70, 78, 90, 0.42) 0%, rgba(44, 52, 63, 0.34) 100%)',
  ['--o8-workspace-shell-inset' as string]: 'inset 0 1px 0 rgba(255, 255, 255, 0.09)',
  ['--o8-workspace-scrollbar' as string]: 'rgba(226, 232, 240, 0.34) rgba(255, 255, 255, 0.06)',
} satisfies CSSProperties;

const O8_WORKSPACE_TOKENS_LIGHT = {
  colorScheme: 'light',
  ['--t-bg' as string]: '#F4F2ED',
  ['--t-bg-card' as string]: 'rgba(15, 23, 42, 0.04)',
  ['--t-bg-subtle' as string]: '#EFEDE6',
  ['--t-panel' as string]: '#FAF9F4',
  ['--t-panel-translucent' as string]: '#F4F2ED',
  ['--t-panel-solid' as string]: '#FAF9F4',
  ['--t-panel-border' as string]: 'rgba(15, 23, 42, 0.1)',
  ['--t-panel-shadow' as string]: '0 16px 36px rgba(15, 23, 42, 0.06)',
  ['--t-input-bg' as string]: '#FFFFFF',
  ['--t-input-border' as string]: 'rgba(15, 23, 42, 0.12)',
  ['--t-border' as string]: 'rgba(15, 23, 42, 0.1)',
  ['--t-divider' as string]: 'rgba(15, 23, 42, 0.08)',
  ['--t-divider-subtle' as string]: 'rgba(15, 23, 42, 0.05)',
  ['--t-hover' as string]: 'rgba(15, 23, 42, 0.04)',
  ['--t-canvas-bg' as string]: '#F4F2ED',
  ['--t-text' as string]: '#0f172a',
  ['--t-text-strong' as string]: '#020617',
  ['--t-text-secondary' as string]: '#475569',
  ['--t-text-muted' as string]: '#64748b',
  ['--t-text-faint' as string]: '#94a3b8',
  ['--t-accent' as string]: '#2563eb',
  ['--t-accent-soft' as string]: 'rgba(37, 99, 235, 0.1)',
  ['--t-accent-border' as string]: 'rgba(37, 99, 235, 0.26)',
  ['--t-brand-orange' as string]: '#c8923b',
  ['--t-brand-red' as string]: '#dc2626',
  ['--t-chat-surface-bg' as string]: '#F4F2ED',
  ['--t-chat-surface-text' as string]: '#0f172a',
  ['--t-chat-surface-text-secondary' as string]: '#475569',
  ['--t-chat-surface-text-muted' as string]: '#64748b',
  ['--t-chat-surface-border' as string]: 'rgba(15, 23, 42, 0.08)',
  ['--t-chat-surface-input-bg' as string]: '#FFFFFF',
  ['--t-chat-surface-input-border' as string]: 'rgba(15, 23, 42, 0.12)',
  ['--t-chat-surface-card-bg' as string]: 'rgba(15, 23, 42, 0.04)',
  ['--t-terminal-ansi-green' as string]: '#16a34a',
  ['--t-terminal-ansi-bright-green' as string]: '#22c55e',
  ['--t-terminal-ansi-bright-red' as string]: '#ef4444',
  ['--o8-workspace-header-bg' as string]: '#F4F2ED',
  ['--o8-workspace-header-divider' as string]: 'rgba(15, 23, 42, 0.08)',
  ['--o8-workspace-control-bg' as string]: '#FFFFFF',
  ['--o8-workspace-control-border' as string]: 'rgba(15, 23, 42, 0.12)',
  ['--o8-workspace-control-shadow' as string]: 'inset 0 0 0 1px rgba(15, 23, 42, 0.04)',
  ['--o8-workspace-rail-header-bg' as string]: '#FAF9F4',
  ['--o8-workspace-shell-bg' as string]: '#F4F2ED',
  ['--o8-workspace-shell-inset' as string]: 'inset 0 0 0 1px rgba(15, 23, 42, 0.04)',
  ['--o8-workspace-scrollbar' as string]: 'rgba(15, 23, 42, 0.24) rgba(15, 23, 42, 0.06)',
} satisfies CSSProperties;

// Easter-egg color ramp for the Changes count: the badge cools-to-warm
// as uncommitted files pile up. Nudges the operator to PR before the
// changeset gets unwieldy. 0 hides, 1–3 green, 4–7 amber, 8–15 orange,
// 16+ red.
function changesUrgencyColor(count: number): string {
  if (count <= 0) return 'var(--t-text-faint)';
  if (count <= 3) return '#22c55e';
  if (count <= 7) return '#f59e0b';
  if (count <= 15) return '#FF5A1F';
  return '#ef4444';
}

function leafFromPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function isWorktreePath(path: string) {
  const leaf = leafFromPath(path);
  const parts = path.split('/').filter(Boolean);
  return parts.includes('.cortex-worktrees') || /^worktree/.test(leaf);
}

function DownIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function ModeMenu<TMode extends string>({
  align = 'left',
  beforeLabel,
  afterLabel,
  label,
  maxWidth,
  menuMinWidth = 164,
  options,
  title,
  value,
  onChange,
}: {
  align?: 'left' | 'right';
  beforeLabel?: ReactNode;
  afterLabel?: ReactNode;
  label: string;
  maxWidth?: number | string;
  menuMinWidth?: number;
  options: Array<{ value: TMode; label: string; detail?: string; title?: string }>;
  title?: string;
  value: TMode;
  onChange: (next: TMode) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  return (
    <details ref={detailsRef} style={{ position: 'relative', flexShrink: 0 }}>
      <summary
        title={title}
        style={{
          minHeight: 28,
          maxWidth,
          borderRadius: 9,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--o8-workspace-control-border, var(--t-divider-subtle))',
          background: 'var(--o8-workspace-control-bg, var(--t-input-bg))',
          boxShadow: 'var(--o8-workspace-control-shadow, none)',
          color: 'var(--t-text)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          fontFamily: UI_FONT,
          fontSize: 11,
          fontWeight: 750,
          listStyle: 'none',
          paddingTop: 0,
          paddingRight: 10,
          paddingBottom: 0,
          paddingLeft: 10,
        }}
      >
        {beforeLabel}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {afterLabel}
        <DownIcon size={12} />
      </summary>
      <div
        style={{
          position: 'absolute',
          top: 32,
          left: align === 'left' ? 0 : undefined,
          right: align === 'right' ? 0 : undefined,
          minWidth: menuMinWidth,
          borderRadius: 10,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-panel-border)',
          background: 'var(--t-panel)',
          backdropFilter: 'blur(18px) saturate(1.3)',
          boxShadow: 'var(--t-panel-shadow)',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          zIndex: 20,
          paddingTop: 4,
          paddingRight: 4,
          paddingBottom: 4,
          paddingLeft: 4,
        }}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              title={option.title}
              onClick={() => {
                detailsRef.current?.removeAttribute('open');
                onChange(option.value);
              }}
              style={{
                minHeight: 30,
                border: 'none',
                borderRadius: 7,
                background: active ? 'var(--t-accent-soft)' : 'transparent',
                color: active ? 'var(--t-accent)' : 'var(--t-text)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                fontFamily: UI_FONT,
                fontSize: 12,
                fontWeight: 550,
                paddingTop: 0,
                paddingRight: 9,
                paddingBottom: 0,
                paddingLeft: 9,
                textAlign: 'left',
              }}
              onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
              {option.detail ? (
                <span style={{ flexShrink: 0, color: active ? 'var(--t-accent)' : 'var(--t-text-faint)', fontSize: 11, fontWeight: 650 }}>
                  {option.detail}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </details>
  );
}

function Breadcrumb({
  expanded,
  onToggle,
  path,
}: {
  expanded: boolean;
  onToggle: () => void;
  path: string | null;
}) {
  if (!path) {
    return (
      <span style={{ color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12, fontWeight: 650 }}>
        Select a file
      </span>
    );
  }

  const segments = path.split('/');
  // Minimized state = filename only, centered in the available space so a
  // narrow header doesn't clip leading characters. Click to expand to the
  // full slash-segmented path; click again to collapse.
  const filename = segments[segments.length - 1] ?? path;
  return (
    <button
      type="button"
      title={expanded ? 'Collapse path' : path}
      aria-label={expanded ? 'Collapse file path' : 'Expand file path'}
      onClick={onToggle}
      style={{
        width: '100%',
        minWidth: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        overflow: 'hidden',
        padding: 0,
        justifyContent: expanded ? 'flex-start' : 'center',
        textAlign: expanded ? 'left' : 'center',
      }}
    >
      {!expanded ? (
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--t-text)',
            fontFamily: MONO_FONT,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0,
          }}
        >
          {filename}
        </span>
      ) : segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
        <span key={`${index}:${segment}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: isLast ? 0 : undefined, flexShrink: isLast ? 1 : 0 }}>
          {index > 0 ? <span style={{ color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 10 }}>&gt;</span> : null}
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: isLast ? 'var(--t-text)' : 'var(--t-text-secondary)',
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: isLast ? 700 : 500,
              letterSpacing: 0,
            }}
          >
            {segment}
          </span>
        </span>
      );})}
    </button>
  );
}

export function O8WorkspacePane({
  repoPath,
  registeredRepos = [],
  onRepoPathChange,
  selectedFile: externalSelectedFile,
  onSelectedFileChange,
}: {
  repoPath?: string | null;
  registeredRepos?: WorkspaceRepoOption[];
  onRepoPathChange?: (repoPath: string) => void;
  selectedFile?: string | null;
  onSelectedFileChange?: (filePath: string) => void;
}) {
  const [listMode, setListMode] = useState<ListMode>('changes');
  const [selectedFile, setSelectedFile] = useState<string | null>(externalSelectedFile ?? null);
  const [selectedFileRepoPath, setSelectedFileRepoPath] = useState<string | null>(externalSelectedFile ? repoPath ?? null : null);
  const [viewerOverride, setViewerOverride] = useState<Record<string, ViewerMode>>({});
  const [breadcrumbExpanded, setBreadcrumbExpanded] = useState(false);
  const latestRepoPathRef = useRef<string | null>(repoPath ?? null);
  const changes = useWorkspaceChanges(repoPath);
  const scopedSelectedFile = selectedFileRepoPath === (repoPath ?? null) ? selectedFile : null;

  useEffect(() => {
    latestRepoPathRef.current = repoPath ?? null;
    setViewerOverride({});
  }, [repoPath]);

  useEffect(() => {
    const nextFile = externalSelectedFile ?? null;
    setSelectedFile(nextFile);
    setSelectedFileRepoPath(nextFile ? latestRepoPathRef.current : null);
  }, [externalSelectedFile]);

  useEffect(() => {
    if (!selectedFile) return;
    if (selectedFileRepoPath === (repoPath ?? null)) return;
    setSelectedFile(null);
    setSelectedFileRepoPath(null);
  }, [repoPath, selectedFile, selectedFileRepoPath]);

  // Auto-select the first dirty file when the pane lands on a worktree
  // with changes but nothing picked yet. Without this, the right pane
  // shows "select a file..." empty-state even though there ARE changes
  // to review — common when the operator clicks a NEEDS YOU row that
  // pops the panel here. Only runs when:
  //   - no file is currently selected
  //   - no externally-controlled selection is in flight
  //   - the changes list is non-empty
  // Switching repos clears externalSelectedFile (above effect), then
  // this fires and lands on the new repo's first dirty file.
  useEffect(() => {
    if (scopedSelectedFile) return;
    if (externalSelectedFile) return;
    if (listMode !== 'changes') return;
    if (changes.files.length === 0) return;
    const firstDirty = changes.files[0]?.path;
    if (!firstDirty) return;
    setSelectedFile(firstDirty);
    setSelectedFileRepoPath(repoPath ?? null);
    onSelectedFileChange?.(firstDirty);
  }, [changes.files, externalSelectedFile, listMode, onSelectedFileChange, repoPath, scopedSelectedFile]);

  const selectedDirty = Boolean(scopedSelectedFile && changes.dirtyFileSet.has(scopedSelectedFile));
  const viewerMode = useMemo<ViewerMode>(() => {
    if (!scopedSelectedFile) return 'file';
    return viewerOverride[scopedSelectedFile] ?? (selectedDirty ? 'diff' : 'file');
  }, [scopedSelectedFile, selectedDirty, viewerOverride]);

  const listOptions = useMemo(() => [
    { value: 'changes' as const, label: 'Changes', detail: String(changes.files.length) },
    { value: 'all' as const, label: 'All files' },
  ], [changes.files.length]);

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedFile(filePath);
    setSelectedFileRepoPath(repoPath ?? null);
    setBreadcrumbExpanded(false);
    onSelectedFileChange?.(filePath);
  }, [onSelectedFileChange, repoPath]);

  const handleViewerChange = useCallback((next: ViewerMode) => {
    if (!scopedSelectedFile) return;
    setViewerOverride((current) => ({ ...current, [scopedSelectedFile]: next }));
  }, [scopedSelectedFile]);

  const handleRepoChange = useCallback((nextRepoPath: string) => {
    if (nextRepoPath === repoPath) return;
    setSelectedFile(null);
    setSelectedFileRepoPath(null);
    setViewerOverride({});
    onRepoPathChange?.(nextRepoPath);
  }, [onRepoPathChange, repoPath]);

  const viewerOptions = useMemo(() => [
    { value: 'diff' as const, label: 'Diff', detail: selectedDirty ? 'Dirty' : 'Clean' },
    { value: 'file' as const, label: 'File', detail: 'Worktree' },
  ], [selectedDirty]);

  // Path-lens label — tells the operator at a glance which checkout the
  // Workspace tab is pointed at. Worktree leaves under .cortex-worktrees/
  // get the worktree dot; main checkouts get a neutral folder dot.
  const lensLabel = useMemo(() => {
    if (!repoPath) return null;
    return { text: leafFromPath(repoPath), isWorktree: isWorktreePath(repoPath), fullPath: repoPath };
  }, [repoPath]);

  const repoOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string; detail?: string; title: string }> = registeredRepos
      .filter((repo) => {
        if (!repo.localPath || seen.has(repo.localPath)) return false;
        seen.add(repo.localPath);
        return true;
      })
      .map((repo) => ({
        value: repo.localPath,
        label: repo.name || leafFromPath(repo.localPath),
        detail: repo.readiness?.currentBranch ?? repo.defaultBranch ?? undefined,
        title: repo.localPath,
      }));

    if (repoPath && !seen.has(repoPath)) {
      options.unshift({
        value: repoPath,
        label: leafFromPath(repoPath),
        detail: isWorktreePath(repoPath) ? 'worktree' : undefined,
        title: repoPath,
      });
    }

    return options;
  }, [registeredRepos, repoPath]);

  const currentRepoLabel = useMemo(() => {
    if (!repoPath) return 'Select repo';
    return repoOptions.find((option) => option.value === repoPath)?.label ?? lensLabel?.text ?? leafFromPath(repoPath);
  }, [lensLabel?.text, repoOptions, repoPath]);

  // Light tokens only apply in light + SOLID. Glass mode (any palette)
  // gets the original dark-translucent tokens because the chrome-surface
  // scope already paints white text over the OS vibrancy in light + glass.
  const { paletteId, surface } = useTheme();
  const workspaceTokens =
    paletteId === 'light' && surface === 'solid'
      ? O8_WORKSPACE_TOKENS_LIGHT
      : O8_WORKSPACE_TOKENS_DARK;
  // Glass: keep the saturating backdrop blur. Solid: drop the backdrop
  // entirely so the paper / graphite paint without ghosting from underneath.
  const isGlass = surface === 'glass';
  // In light + glass the workspace's bluish shell gradient + inset
  // didn't match the rest of the o8 panel tabs (which let the OS
  // vibrancy paint through cleanly). Use a transparent shell + no
  // inset there so the diff workspace blends with its siblings.
  const isLightGlass = paletteId === 'light' && surface === 'glass';
  const shellBg = isLightGlass ? 'transparent' : 'var(--o8-workspace-shell-bg)';
  const shellInset = isLightGlass ? 'none' : 'var(--o8-workspace-shell-inset)';

  return (
    <div
      style={{
        ...workspaceTokens,
        display: 'flex',
        flex: 1,
        flexDirection: 'column',
        minHeight: 0,
        background: shellBg,
        color: 'var(--t-text)',
        backdropFilter: isGlass ? 'blur(24px) saturate(1.16)' : 'none',
        WebkitBackdropFilter: isGlass ? 'blur(24px) saturate(1.16)' : 'none',
        boxShadow: shellInset,
        scrollbarColor: 'var(--o8-workspace-scrollbar)' as unknown as string,
        scrollbarWidth: 'thin',
      } as CSSProperties}
    >
      <div
        style={{
          display: 'flex',
          minHeight: 42,
          flexShrink: 0,
          borderBottom: '1px solid var(--o8-workspace-header-divider)',
          background: 'var(--o8-workspace-header-bg)',
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.055)',
          fontFamily: UI_FONT,
        }}
      >
        <div style={{ width: RAIL_WIDTH, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, borderRight: '1px solid var(--o8-workspace-header-divider)', paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10 }}>
          <ModeMenu
            label={listMode === 'changes' ? 'Changes' : 'All files'}
            options={listOptions}
            value={listMode}
            onChange={setListMode}
            afterLabel={listMode === 'changes' && changes.files.length > 0 ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 18,
                  height: 18,
                  paddingTop: 0,
                  paddingRight: 5,
                  paddingBottom: 0,
                  paddingLeft: 5,
                  borderRadius: 999,
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0,
                  lineHeight: 1,
                  color: changesUrgencyColor(changes.files.length),
                  background: `${changesUrgencyColor(changes.files.length)}1f`,
                  transition: 'color 240ms cubic-bezier(0.22, 1, 0.36, 1), background 240ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              >
                {changes.files.length}
              </span>
            ) : null}
          />
          {repoOptions.length > 0 && onRepoPathChange ? (
            <ModeMenu
              label={currentRepoLabel}
              title={lensLabel?.fullPath}
              options={repoOptions}
              value={(repoPath ?? '') as string}
              onChange={handleRepoChange}
              maxWidth={120}
              menuMinWidth={224}
              beforeLabel={(
                <span
                  aria-hidden="true"
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: lensLabel?.isWorktree ? '#FF5A1F' : 'var(--t-text-faint)',
                    flexShrink: 0,
                  }}
                />
              )}
            />
          ) : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12 }}>
          {!(repoOptions.length > 0 && onRepoPathChange) && lensLabel ? (
            <span
              title={lensLabel.fullPath}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 22,
                paddingTop: 0,
                paddingRight: 8,
                paddingBottom: 0,
                paddingLeft: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-border)',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontSize: 10.5,
                fontWeight: 500,
                letterSpacing: 0,
                whiteSpace: 'nowrap',
                fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
                flexShrink: 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  background: lensLabel.isWorktree ? '#FF5A1F' : 'var(--t-text-faint)',
                  flexShrink: 0,
                }}
              />
              {lensLabel.text}
            </span>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Breadcrumb
              expanded={breadcrumbExpanded}
              onToggle={() => setBreadcrumbExpanded((current) => !current)}
              path={scopedSelectedFile}
            />
          </div>
          <O8ScratchChat repoPath={repoPath} selectedFile={scopedSelectedFile} surface={viewerMode} />
          <ModeMenu
            align="right"
            label="Diff · File"
            options={viewerOptions}
            value={viewerMode}
            onChange={handleViewerChange}
          />
        </div>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ width: RAIL_WIDTH, minWidth: RAIL_WIDTH, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--t-divider-subtle)', overflow: 'hidden' }}>
          {listMode === 'changes' ? (
            <ChangesList
              changes={changes}
              repoPath={repoPath}
              selectedFile={scopedSelectedFile}
              onSelectFile={handleSelectFile}
            />
          ) : (
            <AllFilesTree
              repoPath={repoPath}
              selectedFile={scopedSelectedFile}
              dirtyFiles={changes.dirtyFileSet}
              onSelectFile={handleSelectFile}
            />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {viewerMode === 'diff' ? (
            <DiffViewer repoPath={repoPath} selectedFile={scopedSelectedFile} mode="unified" />
          ) : (
            <FileViewer repoPath={repoPath} selectedFile={scopedSelectedFile} />
          )}
        </div>
      </div>
    </div>
  );
}
