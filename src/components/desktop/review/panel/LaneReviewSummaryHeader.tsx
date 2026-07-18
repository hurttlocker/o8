'use client';

/**
 * LaneReviewSummaryHeader — the summary-first block above a packet's branch
 * diff (Q ruling 2026-07-18, Codex PR-view parity: "they would love to see
 * the summary first, not the files — but ours still needed"). Order:
 *
 *   SUMMARY            ← the agent's own prose (transcript tail), clamped
 *   N files · +X −Y    ← counts line
 *   <file rows>        ← per-file +/- rows, click jumps to the file's diff
 *
 * Renders nothing when there is neither prose nor files. Style stays ours:
 * uppercase 10px labels, theme tokens, Issues-density rows, flat hairline
 * separation from the diff below — no card chrome.
 */

import { useState } from 'react';
import type { ReviewChangedFile } from '@/lib/fleet/types';
import { UI_FONT } from './constants';

const MONO_FONT = 'var(--font-mono-system)';
const CLAMP_LINES = 7;

export function LaneReviewSummaryHeader({
  summary,
  files,
  totalAdditions,
  totalDeletions,
  onSelectFile,
}: {
  summary: string | null;
  files: ReviewChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  onSelectFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longSummary = Boolean(summary && (summary.length > 620 || summary.split('\n').length > CLAMP_LINES));
  if (!summary && files.length === 0) return null;

  return (
    <div
      style={{
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontFamily: UI_FONT,
      }}
    >
      {summary ? (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              color: 'var(--t-text-faint)',
              marginBottom: 6,
            }}
          >
            Summary
          </div>
          <div
            style={{
              fontSize: 12.5,
              lineHeight: '18px',
              color: 'var(--t-text-secondary)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
              ...(expanded || !longSummary
                ? {}
                : {
                    display: '-webkit-box',
                    WebkitLineClamp: CLAMP_LINES,
                    WebkitBoxOrient: 'vertical' as const,
                    overflow: 'hidden',
                  }),
            } as React.CSSProperties}
          >
            {summary}
          </div>
          {longSummary ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              style={{
                marginTop: 4,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-faint)',
                fontSize: 11,
                fontWeight: 500,
                fontFamily: UI_FONT,
                cursor: 'pointer',
              }}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </>
      ) : null}

      {files.length > 0 ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 7,
              marginTop: summary ? 12 : 0,
              marginBottom: 3,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase' as const,
                color: 'var(--t-text-faint)',
              }}
            >
              {files.length === 1 ? '1 file' : `${files.length} files`}
            </span>
            <span style={{ fontSize: 11, fontFamily: MONO_FONT, color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>+{totalAdditions}</span>
            <span style={{ fontSize: 11, fontFamily: MONO_FONT, color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>−{totalDeletions}</span>
          </div>
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => onSelectFile(file.path)}
              title={file.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                height: 26,
                paddingLeft: 6,
                paddingRight: 6,
                paddingTop: 0,
                paddingBottom: 0,
                border: 'none',
                borderRadius: 6,
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left' as const,
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-glass-muted)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  direction: 'rtl',
                  fontSize: 11.5,
                  fontFamily: MONO_FONT,
                  color: 'var(--t-text)',
                }}
              >
                {file.path}
              </span>
              <span style={{ flexShrink: 0, fontSize: 11, fontFamily: MONO_FONT, color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>
                +{file.additions ?? 0}
              </span>
              <span style={{ flexShrink: 0, fontSize: 11, fontFamily: MONO_FONT, color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>
                −{file.deletions ?? 0}
              </span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}
