'use client';

/**
 * DiffCard row primitives — file header + hunk renderer (#525).
 *
 * Extracted from DiffCard.tsx to keep the composer file under the 600-line
 * ceiling. Pure presentational components — all state lives in DiffCard.
 */

import React, { useMemo } from 'react';
import { Check } from './lucide-shims';
import { DiffStatusIcon } from './diff-utils';
import { hunkKey, type ParsedDiffFile, type ParsedDiffHunk, type ParsedDiffStatus } from '@/lib/llm/diff-parse';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';

const STATUS_LABEL: Record<ParsedDiffStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  unknown: 'Patch',
};

function statusIconKind(status: ParsedDiffStatus): string {
  if (status === 'added') return 'added';
  if (status === 'deleted') return 'deleted';
  if (status === 'renamed') return 'renamed';
  return 'modified';
}

interface HunkRow {
  key: string;
  line: string;
  color: string;
  background: string;
  leftNum: string;
  rightNum: string;
}

function buildHunkRows(hunk: ParsedDiffHunk): HunkRow[] {
  let oldLine = hunk.startOldLine;
  let newLine = hunk.startNewLine;
  const rows: HunkRow[] = [];
  for (let i = 0; i < hunk.lines.length; i += 1) {
    const line = hunk.lines[i];
    if (line.startsWith('+') && !line.startsWith('+++')) {
      rows.push({
        key: `${hunk.header}-${i}`,
        line,
        color: '#166534',
        background: 'rgba(34, 197, 94, 0.08)',
        leftNum: '',
        rightNum: String(newLine),
      });
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      rows.push({
        key: `${hunk.header}-${i}`,
        line,
        color: '#991b1b',
        background: 'rgba(239, 68, 68, 0.08)',
        leftNum: String(oldLine),
        rightNum: '',
      });
      oldLine += 1;
    } else if (line.startsWith('\\')) {
      rows.push({
        key: `${hunk.header}-${i}`,
        line,
        color: 'var(--t-text-muted)',
        background: 'transparent',
        leftNum: '',
        rightNum: '',
      });
    } else {
      rows.push({
        key: `${hunk.header}-${i}`,
        line,
        color: 'var(--t-text)',
        background: 'transparent',
        leftNum: String(oldLine),
        rightNum: String(newLine),
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

const LINE_NUMBER_STYLE: React.CSSProperties = {
  width: 42,
  flexShrink: 0,
  textAlign: 'right',
  paddingTop: 1,
  paddingRight: 6,
  paddingBottom: 1,
  paddingLeft: 0,
  color: 'var(--t-text-faint)',
  fontSize: 12,
  fontFamily: '"SF Mono", ui-monospace, monospace',
  userSelect: 'none',
  borderRight: '1px solid var(--t-divider-subtle)',
};

export function DiffCardHunk({
  hunk,
  selected,
  onToggleSelected,
  pickerOpen,
  freshlyArrived,
}: {
  hunk: ParsedDiffHunk;
  selected: boolean;
  onToggleSelected: () => void;
  pickerOpen: boolean;
  freshlyArrived: boolean;
}) {
  const rows = useMemo(() => buildHunkRows(hunk), [hunk]);

  return (
    <div style={freshlyArrived ? { animation: 'llmFadeIn 220ms ease-out' } : undefined}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingRight: 12,
          paddingBottom: 6,
          paddingLeft: 12,
          background: 'rgba(99, 102, 241, 0.06)',
          color: '#6366f1',
          fontSize: 12,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          borderTop: '1px solid var(--t-divider-subtle)',
          borderBottom: '1px solid var(--t-divider-subtle)',
        }}
      >
        {pickerOpen ? (
          <button
            type="button"
            onClick={onToggleSelected}
            aria-label={selected ? 'Deselect hunk' : 'Select hunk'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              borderRadius: 3,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: selected ? THEME_ACCENT : 'var(--t-panel-border)',
              background: selected ? THEME_ACCENT : 'transparent',
              color: '#ffffff',
              cursor: 'pointer',
              flexShrink: 0,
              padding: 0,
            }}
          >
            {selected ? <Check size={10} strokeWidth={3} /> : null}
          </button>
        ) : null}
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hunk.header}</span>
      </div>
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'flex', color: row.color, background: row.background }}>
          <span style={LINE_NUMBER_STYLE}>{row.leftNum}</span>
          <span style={LINE_NUMBER_STYLE}>{row.rightNum}</span>
          <span
            style={{
              flex: 1,
              paddingTop: 1,
              paddingRight: 12,
              paddingBottom: 1,
              paddingLeft: 8,
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {row.line || '\u00A0'}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DiffCardFile({
  file,
  fileIndex,
  selection,
  onToggleHunk,
  onToggleFile,
  pickerOpen,
  newHunkKeys,
}: {
  file: ParsedDiffFile;
  fileIndex: number;
  selection: Record<string, boolean>;
  onToggleHunk: (key: string) => void;
  onToggleFile: (file: ParsedDiffFile) => void;
  pickerOpen: boolean;
  newHunkKeys: Set<string>;
}) {
  const allSelected = file.hunks.every((_, i) => selection[hunkKey(file, i)] !== false);
  const someSelected = file.hunks.some((_, i) => selection[hunkKey(file, i)] !== false);
  return (
    <div
      style={{
        borderTop: fileIndex === 0 ? 'none' : '1px solid var(--t-divider)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 12,
          background: 'var(--t-bg-card, rgba(148, 163, 184, 0.05))',
          borderBottom: file.hunks.length > 0 ? '1px solid var(--t-divider-subtle)' : 'none',
        }}
      >
        {pickerOpen ? (
          <button
            type="button"
            onClick={() => onToggleFile(file)}
            aria-label={allSelected ? 'Deselect file' : 'Select file'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              borderRadius: 3,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: someSelected ? THEME_ACCENT : 'var(--t-panel-border)',
              background: allSelected ? THEME_ACCENT : someSelected ? THEME_ACCENT_SOFT : 'transparent',
              color: '#ffffff',
              cursor: 'pointer',
              flexShrink: 0,
              padding: 0,
            }}
          >
            {allSelected ? (
              <Check size={10} strokeWidth={3} />
            ) : someSelected ? (
              <span style={{ display: 'inline-block', width: 6, height: 2, background: THEME_ACCENT, borderRadius: 1 }} />
            ) : null}
          </button>
        ) : null}
        <DiffStatusIcon status={statusIconKind(file.status)} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--t-text)',
              lineHeight: 1.4,
              wordBreak: 'break-word',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {file.filePath || file.oldPath || 'untitled'}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--t-text-muted)',
              marginTop: 2,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {STATUS_LABEL[file.status]} · {file.hunks.length} hunk{file.hunks.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      {file.hunks.length > 0 ? (
        file.hunks.map((hunk, hunkIndex) => {
          const key = hunkKey(file, hunkIndex);
          return (
            <DiffCardHunk
              key={`${file.filePath}-hunk-${hunkIndex}`}
              hunk={hunk}
              selected={selection[key] !== false}
              onToggleSelected={() => onToggleHunk(key)}
              pickerOpen={pickerOpen}
              freshlyArrived={newHunkKeys.has(key)}
            />
          );
        })
      ) : (
        <div
          style={{
            paddingTop: 12,
            paddingRight: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            fontSize: 12,
            color: 'var(--t-text-muted)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
        >
          No hunks parsed yet.
        </div>
      )}
    </div>
  );
}
