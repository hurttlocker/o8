'use client';

import { memo, useState } from 'react';
import { useTheme } from '@/lib/theme/context';
import { ChevronDown, ChevronRight, FileCode } from '../../lucide-shims';
import { PrDiffPatch } from '../PrDiffPatch';
import type { PrFile } from '../types';

interface ChangesTabProps {
  files: PrFile[];
  openFiles?: string[];
  onToggleFile?: (path: string) => void;
  totalFiles?: number;
  diffStyle?: 'unified' | 'split';
}

function DiffStatBadge({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ color: 'var(--t-success)' }}>+{additions}</span>
      <span style={{ color: 'var(--t-danger)' }}>-{deletions}</span>
    </span>
  );
}

const FileRow = memo(function FileRow({ file, controlledOpen, onToggle, diffStyle }: { file: PrFile; controlledOpen?: boolean; onToggle?: () => void; diffStyle: 'unified' | 'split' }) {
  const [localOpen, setOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const hasPatch = Boolean(file.patch && file.patch.trim());
  const { workspaceGlass } = useTheme();
  const headerSurface = workspaceGlass ? 'var(--t-glass-muted-strong)' : 'var(--t-panel-solid)';

  return (
    <div data-pr-file-row data-open={open} style={{ borderBottom: open ? '1px solid var(--t-divider-subtle)' : undefined }}>
      <button
        type="button"
        data-pr-file={file.path}
        aria-expanded={open}
        aria-label={`Changes in ${file.path}`}
        onClick={onToggle ?? (() => setOpen((current) => !current))}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 14,
          paddingRight: 14,
          border: 'none',
          borderRadius: 0,
          boxShadow: 'none',
          margin: 0,
          fontFamily: 'inherit',
          color: 'var(--t-text)',
          cursor: 'pointer',
          textAlign: 'left',
          scrollMarginTop: 0,
          background: open ? headerSurface : 'transparent',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = open ? headerSurface : 'var(--t-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = open ? headerSurface : 'transparent'; }}
      >
        <span style={{ color: 'var(--t-text-faint)', display: 'inline-flex' }}>
          {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        </span>
        <FileCode size={14} aria-hidden="true" style={{ color: 'var(--t-accent)', flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'inherit',
            fontSize: 14,
            fontWeight: 400,
            color: 'var(--t-text)',
            overflowWrap: 'anywhere',
            whiteSpace: 'normal',
            lineHeight: 1.5,
            textAlign: 'left',
          }}
        >
          {file.previousPath ? <span style={{ color: 'var(--t-text-muted)' }}>{file.previousPath} <span aria-label="renamed to">→</span> </span> : null}{file.path}
        </span>
        <DiffStatBadge additions={file.additions} deletions={file.deletions} />
      </button>
      {open && hasPatch ? <PrDiffPatch file={file} diffStyle={diffStyle} /> : null}
      {open && !hasPatch ? (
        <div
          style={{
            paddingTop: 8,
            paddingBottom: 12,
            paddingLeft: 14,
            paddingRight: 14,
            fontSize: 11,
            color: 'var(--t-text-muted)',
            background: 'var(--t-bg-card)',
            borderTop: '1px solid var(--t-divider-subtle)',
          }}
        >
          {file.status === 'renamed' && !file.additions && !file.deletions ? 'Renamed without content changes.' : 'GitHub did not return a textual patch for this file.'}
        </div>
      ) : null}
    </div>
  );
});

export const ChangesTab = memo(function ChangesTab({ files, openFiles, onToggleFile, totalFiles = files.length, diffStyle = 'unified' }: ChangesTabProps) {
  if (files.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
        No file changes available.
      </div>
    );
  }

  return (
    <div>
      {files.length < totalFiles ? <p role="status" style={{ margin: 0, padding: 14, fontSize: 11, color: 'var(--t-text-muted)' }}>Showing {files.length} of {totalFiles} changed files. Open the pull request on GitHub for the rest.</p> : null}
      {files.map((file) => (
        <FileRow key={file.path} file={file} diffStyle={diffStyle} controlledOpen={openFiles ? openFiles.includes(file.path) : undefined} onToggle={onToggleFile ? () => onToggleFile(file.path) : undefined} />
      ))}
    </div>
  );
});
