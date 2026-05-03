'use client';
/* eslint-disable react-hooks/set-state-in-effect -- external focus requests intentionally sync selected workspace file */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AllFilesTree } from './workspace-rail/AllFilesTree';
import { ChangesList, useWorkspaceChanges } from './workspace-rail/ChangesList';
import { DiffViewer, type DiffDisplayMode } from './workspace-rail/DiffViewer';
import { FileViewer } from './workspace-rail/FileViewer';

type ListMode = 'changes' | 'all';
type ViewerMode = 'diff' | 'file';

const UI_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const RAIL_WIDTH = 240;

function DownIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function ModeMenu<TMode extends string>({
  align = 'left',
  label,
  options,
  value,
  onChange,
}: {
  align?: 'left' | 'right';
  label: string;
  options: Array<{ value: TMode; label: string; detail?: string }>;
  value: TMode;
  onChange: (next: TMode) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  return (
    <details ref={detailsRef} style={{ position: 'relative', flexShrink: 0 }}>
      <summary
        style={{
          minHeight: 28,
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
        <span>{label}</span>
        <DownIcon size={12} />
      </summary>
      <div
        style={{
          position: 'absolute',
          top: 32,
          left: align === 'left' ? 0 : undefined,
          right: align === 'right' ? 0 : undefined,
          minWidth: 164,
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
              <span>{option.label}</span>
              {option.detail ? (
                <span style={{ color: active ? 'var(--t-accent)' : 'var(--t-text-faint)', fontSize: 11, fontWeight: 650 }}>
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

function DiffLayoutButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 28,
        border: '1px solid var(--t-divider-subtle)',
        borderRadius: 9,
        background: active ? 'var(--t-input-bg)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: UI_FONT,
        fontSize: 11,
        fontWeight: 700,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}

function Breadcrumb({ path }: { path: string | null }) {
  if (!path) {
    return (
      <span style={{ color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12, fontWeight: 650 }}>
        Select a file
      </span>
    );
  }

  const segments = path.split('/');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
      {segments.map((segment, index) => (
        <span key={`${index}:${segment}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: index === segments.length - 1 ? 0 : undefined, flexShrink: index === segments.length - 1 ? 1 : 0 }}>
          {index > 0 ? <span style={{ color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 10 }}>&gt;</span> : null}
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: index === segments.length - 1 ? 'var(--t-text)' : 'var(--t-text-secondary)',
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: index === segments.length - 1 ? 700 : 500,
            }}
          >
            {segment}
          </span>
        </span>
      ))}
    </div>
  );
}

export function O8WorkspacePane({
  repoPath,
  selectedFile: externalSelectedFile,
  onSelectedFileChange,
}: {
  repoPath?: string | null;
  selectedFile?: string | null;
  onSelectedFileChange?: (filePath: string) => void;
}) {
  const [listMode, setListMode] = useState<ListMode>('changes');
  const [selectedFile, setSelectedFile] = useState<string | null>(externalSelectedFile ?? null);
  const [viewerOverride, setViewerOverride] = useState<Record<string, ViewerMode>>({});
  const [diffDisplayMode, setDiffDisplayMode] = useState<DiffDisplayMode>('unified');
  const changes = useWorkspaceChanges(repoPath);

  useEffect(() => {
    setSelectedFile(externalSelectedFile ?? null);
  }, [externalSelectedFile]);

  const selectedDirty = Boolean(selectedFile && changes.dirtyFileSet.has(selectedFile));
  const viewerMode = useMemo<ViewerMode>(() => {
    if (!selectedFile) return 'file';
    return viewerOverride[selectedFile] ?? (selectedDirty ? 'diff' : 'file');
  }, [selectedDirty, selectedFile, viewerOverride]);

  const listOptions = useMemo(() => [
    { value: 'changes' as const, label: 'Changes', detail: String(changes.files.length) },
    { value: 'all' as const, label: 'All files' },
  ], [changes.files.length]);

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedFile(filePath);
    onSelectedFileChange?.(filePath);
  }, [onSelectedFileChange]);

  const handleViewerChange = useCallback((next: ViewerMode) => {
    if (!selectedFile) return;
    setViewerOverride((current) => ({ ...current, [selectedFile]: next }));
  }, [selectedFile]);

  const viewerOptions = useMemo(() => [
    { value: 'diff' as const, label: 'Diff', detail: selectedDirty ? 'Dirty' : 'Clean' },
    { value: 'file' as const, label: 'File', detail: 'Worktree' },
  ], [selectedDirty]);

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
        <div style={{ width: RAIL_WIDTH, flexShrink: 0, display: 'flex', alignItems: 'center', borderRight: '1px solid var(--t-divider-subtle)', paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10 }}>
          <ModeMenu
            label={listMode === 'changes' ? `Changes ${changes.files.length}` : 'All files'}
            options={listOptions}
            value={listMode}
            onChange={setListMode}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Breadcrumb path={selectedFile} />
          </div>
          {viewerMode === 'diff' ? (
            <>
              <DiffLayoutButton active={diffDisplayMode === 'unified'} label="Unified" onClick={() => setDiffDisplayMode('unified')} />
              <DiffLayoutButton active={diffDisplayMode === 'side'} label="Side-by-side" onClick={() => setDiffDisplayMode('side')} />
            </>
          ) : null}
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
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
            />
          ) : (
            <AllFilesTree
              repoPath={repoPath}
              selectedFile={selectedFile}
              dirtyFiles={changes.dirtyFileSet}
              onSelectFile={handleSelectFile}
            />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {viewerMode === 'diff' ? (
            <DiffViewer repoPath={repoPath} selectedFile={selectedFile} mode={diffDisplayMode} />
          ) : (
            <FileViewer repoPath={repoPath} selectedFile={selectedFile} />
          )}
        </div>
      </div>
    </div>
  );
}
