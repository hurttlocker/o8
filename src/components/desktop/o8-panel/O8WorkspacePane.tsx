'use client';
/* eslint-disable react-hooks/set-state-in-effect -- external focus requests intentionally sync selected workspace file */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
          borderColor: 'var(--t-divider-subtle)',
          background: 'var(--t-input-bg)',
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
  const shouldCompact = !expanded && segments.length > 4;
  const visibleSegments = shouldCompact
    ? [segments[0] ?? '', '...', segments[segments.length - 2] ?? '', segments[segments.length - 1] ?? '']
    : segments;
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
        textAlign: 'left',
      }}
    >
      {visibleSegments.map((segment, index) => {
        const isLast = index === visibleSegments.length - 1;
        const isEllipsis = segment === '...';
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
              fontWeight: isLast ? 700 : isEllipsis ? 750 : 500,
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

  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--t-canvas-bg)',
        color: 'var(--t-chat-surface-text)',
        ['--t-text' as unknown as string]: 'var(--t-chat-surface-text)',
        ['--t-text-secondary' as unknown as string]: 'var(--t-chat-surface-text-secondary)',
        ['--t-text-muted' as unknown as string]: 'var(--t-chat-surface-text-muted)',
        ['--t-text-faint' as unknown as string]: 'var(--t-chat-surface-text-muted)',
        ['--t-input-bg' as unknown as string]: 'var(--t-chat-surface-input-bg)',
      } as CSSProperties}
    >
      <div style={{ display: 'flex', minHeight: 42, flexShrink: 0, borderBottom: '1px solid var(--t-divider-subtle)', fontFamily: UI_FONT }}>
        <div style={{ width: RAIL_WIDTH, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, borderRight: '1px solid var(--t-divider-subtle)', paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10 }}>
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
