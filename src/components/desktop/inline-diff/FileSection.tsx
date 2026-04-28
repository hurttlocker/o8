'use client';

/**
 * FileSection — single-file group inside the desktop InlineDiffViewer (#659).
 *
 * Renders the sticky file header (status pill, path, +/-) and walks the
 * file's hunks through HunkBlock. Pure presentation; acceptance state is
 * owned upstream by InlineDiffViewer.
 */

import { useMemo } from 'react';
import { hunkKey, type ParsedDiffFile } from '@/lib/diff/parse';
import { HunkBlock } from './HunkBlock';

export interface FileSectionProps {
  file: ParsedDiffFile;
  acceptance: Record<string, boolean>;
  onToggleHunk: (key: string, next: boolean) => void;
}

export function fileAnchorId(filePath: string): string {
  return `inline-diff-file-${filePath.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function statusLabel(status: ParsedDiffFile['status']): string {
  switch (status) {
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'renamed':
      return 'Renamed';
    case 'modified':
      return 'Modified';
    default:
      return 'Changed';
  }
}

export function statusTone(status: ParsedDiffFile['status']): { color: string; bg: string; border: string } {
  switch (status) {
    case 'added':
      return { color: '#16a34a', bg: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.22)' };
    case 'deleted':
      return { color: '#dc2626', bg: 'rgba(239, 68, 68, 0.10)', border: 'rgba(239, 68, 68, 0.22)' };
    case 'renamed':
      return { color: '#7c3aed', bg: 'rgba(139, 92, 246, 0.10)', border: 'rgba(139, 92, 246, 0.22)' };
    default:
      return { color: '#2563eb', bg: 'rgba(37, 99, 235, 0.10)', border: 'rgba(37, 99, 235, 0.22)' };
  }
}

export function FileSection({ file, acceptance, onToggleHunk }: FileSectionProps) {
  const tone = statusTone(file.status);
  const fileAdd = useMemo(
    () => file.hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, 0),
    [file.hunks],
  );
  const fileDel = useMemo(
    () => file.hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length, 0),
    [file.hunks],
  );

  return (
    <div id={fileAnchorId(file.filePath)} style={{ marginBottom: 18 }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(20px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider)',
          paddingTop: 8,
          paddingRight: 14,
          paddingBottom: 8,
          paddingLeft: 14,
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            paddingTop: 2,
            paddingRight: 8,
            paddingBottom: 2,
            paddingLeft: 8,
            borderRadius: 999,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: tone.border,
            background: tone.bg,
            color: tone.color,
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            flexShrink: 0,
          }}
        >
          {statusLabel(file.status)}
        </span>
        <span
          style={{
            fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--t-text-strong)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {file.filePath}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a', flexShrink: 0 }}>+{fileAdd}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', flexShrink: 0 }}>-{fileDel}</span>
      </div>

      {file.hunks.length === 0 ? (
        <div
          style={{
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 10,
            paddingLeft: 14,
            borderRadius: 10,
            background: 'var(--t-bg-subtle)',
            color: 'var(--t-text-muted)',
            fontSize: 12,
            fontStyle: 'italic',
            marginLeft: 14,
            marginRight: 14,
          }}
        >
          No textual changes (binary or empty diff).
        </div>
      ) : (
        <div style={{ paddingLeft: 14, paddingRight: 14 }}>
          {file.hunks.map((hunk, idx) => {
            const key = hunkKey(file, idx);
            const accepted = acceptance[key] !== false;
            return (
              <HunkBlock
                key={key}
                fileKey={file.filePath}
                hunkIndex={idx}
                hunk={hunk}
                accepted={accepted}
                onToggleAccepted={(next) => onToggleHunk(key, next)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
