'use client';

import { memo, useState } from 'react';
import { ChevronDown, ChevronRight } from '../../lucide-shims';
import { splitUnifiedDiff, diffLineTone, type DiffLine } from '../../o8-panel/diff-render';
import type { PrFile } from '../types';

const MONO_FONT = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";

interface ChangesTabProps {
  files: PrFile[];
  totalAdditions: number;
  totalDeletions: number;
}

function DiffStatBadge({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: MONO_FONT,
        fontSize: 11,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ color: '#16a34a' }}>+{additions}</span>
      <span style={{ color: '#ef4444' }}>-{deletions}</span>
    </span>
  );
}

function DiffPatch({ patch }: { patch: string }) {
  const lines: DiffLine[] = splitUnifiedDiff(patch);
  return (
    <div
      style={{
        fontFamily: MONO_FONT,
        fontSize: 11,
        lineHeight: 1.55,
        background: 'var(--t-bg-card)',
        borderTop: '1px solid var(--t-divider-subtle)',
      }}
    >
      {lines.map((line, index) => {
        const tone = diffLineTone(line.kind);
        return (
          <div
            key={index}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              paddingTop: 1,
              paddingBottom: 1,
              paddingLeft: 12,
              paddingRight: 12,
              background: tone.background,
              color: tone.color,
              whiteSpace: 'pre',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 32,
                color: 'var(--t-text-faint)',
                textAlign: 'right',
                flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {line.oldNumber ?? ''}
            </span>
            <span
              style={{
                display: 'inline-block',
                width: 32,
                color: 'var(--t-text-faint)',
                textAlign: 'right',
                flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {line.newNumber ?? ''}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{line.text}</span>
          </div>
        );
      })}
    </div>
  );
}

const FileRow = memo(function FileRow({ file }: { file: PrFile }) {
  const [open, setOpen] = useState(false);
  const hasPatch = Boolean(file.patch && file.patch.trim());

  return (
    <div style={{ borderBottom: '1px solid var(--t-divider-subtle)' }}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 14,
          paddingRight: 14,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{ color: 'var(--t-text-faint)', display: 'inline-flex' }}>
          {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: MONO_FONT,
            fontSize: 12,
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
          }}
          title={file.path}
        >
          {file.path}
        </span>
        <DiffStatBadge additions={file.additions} deletions={file.deletions} />
      </button>
      {open && hasPatch ? <DiffPatch patch={file.patch ?? ''} /> : null}
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
          No patch available (binary file or too large).
        </div>
      ) : null}
    </div>
  );
});

export const ChangesTab = memo(function ChangesTab({ files, totalAdditions, totalDeletions }: ChangesTabProps) {
  if (files.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
        No file changes available.
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 14,
          paddingRight: 14,
          borderBottom: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
        }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
          {files.length} File{files.length === 1 ? '' : 's'} Changed
        </span>
        <DiffStatBadge additions={totalAdditions} deletions={totalDeletions} />
      </div>
      {files.map((file) => (
        <FileRow key={file.path} file={file} />
      ))}
    </div>
  );
});
