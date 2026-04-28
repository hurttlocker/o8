'use client';

/**
 * HunkBlock — single hunk renderer for the desktop InlineDiffViewer (#659).
 *
 * Shows a unified-diff hunk with:
 *   - sticky header (range, +/- counts, accept toggle, collapse caret)
 *   - +/- coloured line rows with old/new line numbers
 *   - "expand N more lines" button when the hunk is huge
 *
 * Stateless toward acceptance — the parent owns the per-hunk acceptance map
 * keyed by `hunkKey()`. Local state covers only collapse + line truncation.
 */

import { memo, useMemo, useState } from 'react';
import type { ParsedDiffHunk } from '@/lib/diff/parse';
import { Check, ChevronDown, ChevronRight } from '../lucide-shims';

export interface HunkBlockProps {
  fileKey: string;
  hunkIndex: number;
  hunk: ParsedDiffHunk;
  accepted: boolean;
  onToggleAccepted: (next: boolean) => void;
}

const MAX_INITIAL_HUNK_LINES = 80;

interface DecoratedLine {
  raw: string;
  isAdd: boolean;
  isDel: boolean;
  oldCell: string;
  newCell: string;
}

/**
 * Walk the hunk lines once to attach old/new line numbers per row. Done in a
 * useMemo (not via mutating top-level locals during .map) so eslint's
 * react-hooks/immutability rule stays happy.
 */
function decorateLines(hunk: ParsedDiffHunk): DecoratedLine[] {
  const out: DecoratedLine[] = [];
  let oldNumber = hunk.startOldLine - 1;
  let newNumber = hunk.startNewLine - 1;
  for (const raw of hunk.lines) {
    const isAdd = raw.startsWith('+') && !raw.startsWith('+++');
    const isDel = raw.startsWith('-') && !raw.startsWith('---');
    if (isAdd) newNumber += 1;
    else if (isDel) oldNumber += 1;
    else {
      oldNumber += 1;
      newNumber += 1;
    }
    out.push({
      raw,
      isAdd,
      isDel,
      oldCell: isAdd ? '' : String(oldNumber),
      newCell: isDel ? '' : String(newNumber),
    });
  }
  return out;
}

export const HunkBlock = memo(function HunkBlock({
  fileKey,
  hunkIndex,
  hunk,
  accepted,
  onToggleAccepted,
}: HunkBlockProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(hunk.lines.length <= MAX_INITIAL_HUNK_LINES);

  const decoratedLines = useMemo(() => decorateLines(hunk), [hunk]);
  const visibleLines = showAll ? decoratedLines : decoratedLines.slice(0, MAX_INITIAL_HUNK_LINES);
  const hiddenCount = Math.max(0, decoratedLines.length - visibleLines.length);
  const addCount = useMemo(() => decoratedLines.filter((l) => l.isAdd).length, [decoratedLines]);
  const delCount = useMemo(() => decoratedLines.filter((l) => l.isDel).length, [decoratedLines]);

  return (
    <div
      key={`${fileKey}-${hunkIndex}`}
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'var(--t-bg-subtle)',
        marginBottom: 10,
        overflow: 'hidden',
        opacity: accepted ? 1 : 0.55,
        transition: 'opacity 150ms ease',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingRight: 10,
          paddingBottom: 6,
          paddingLeft: 10,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          background: 'var(--t-panel-translucent)',
        }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-label={collapsed ? 'Expand hunk' : 'Collapse hunk'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            flexShrink: 0,
          }}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <span
          style={{
            fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
            fontSize: 11,
            color: 'var(--t-text-secondary)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {hunk.header}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a', flexShrink: 0 }}>+{addCount}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', flexShrink: 0 }}>-{delCount}</span>
        <button
          type="button"
          onClick={() => onToggleAccepted(!accepted)}
          title={accepted ? 'Click to skip this hunk in the emitted patch' : 'Click to include this hunk in the emitted patch'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 4,
            paddingRight: 8,
            paddingBottom: 4,
            paddingLeft: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: accepted ? 'rgba(34, 197, 94, 0.3)' : 'var(--t-divider)',
            background: accepted ? 'rgba(34, 197, 94, 0.08)' : 'transparent',
            color: accepted ? '#16a34a' : 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
            minHeight: 24,
            letterSpacing: '-0.01em',
          }}
        >
          <Check size={11} />
          {accepted ? 'Accepted' : 'Skipped'}
        </button>
      </div>
      {!collapsed ? (
        <div style={{ display: 'block', overflowX: 'auto' }}>
          {visibleLines.map((line, idx) => {
            const isContext = !line.isAdd && !line.isDel;
            const lineBg = line.isAdd
              ? 'rgba(34, 197, 94, 0.10)'
              : line.isDel
              ? 'rgba(239, 68, 68, 0.10)'
              : 'transparent';
            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  background: lineBg,
                  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
                  fontSize: 12,
                  lineHeight: 1.55,
                  minHeight: 18,
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    width: 44,
                    textAlign: 'right',
                    paddingRight: 8,
                    paddingLeft: 6,
                    color: 'var(--t-text-faint)',
                    userSelect: 'none',
                  }}
                >
                  {line.oldCell}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    width: 44,
                    textAlign: 'right',
                    paddingRight: 10,
                    color: 'var(--t-text-faint)',
                    userSelect: 'none',
                  }}
                >
                  {line.newCell}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    paddingRight: 10,
                    color: isContext ? 'var(--t-text-secondary)' : 'var(--t-text-strong)',
                    whiteSpace: 'pre',
                    wordBreak: 'normal',
                  }}
                >
                  {line.raw || ' '}
                </span>
              </div>
            );
          })}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              style={{
                width: '100%',
                minHeight: 32,
                borderWidth: 0,
                borderTopWidth: 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle)',
                background: 'var(--t-panel-translucent)',
                color: 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                letterSpacing: '-0.01em',
              }}
            >
              Expand {hiddenCount} more line{hiddenCount === 1 ? '' : 's'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
