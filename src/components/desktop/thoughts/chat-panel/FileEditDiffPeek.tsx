'use client';

/**
 * FileEditDiffPeek — the low-friction "inline peek" half of Wave 2's
 * dual-fidelity diff wiring (Cursor parity). Renders a compact unified-diff
 * snippet directly under a FileEditRow so the operator stays in chat context.
 *
 * Purely presentational: the parent FileEditRow owns fetch + cache state and
 * feeds this the resolved `PeekOutcome`. Reuses the app's diff visual language
 * (splitUnifiedDiff + diffLineTone) rather than a bespoke renderer. Capped
 * height with its own scroll; horizontal overflow contained; file-header meta
 * lines dropped so the snippet stays dense (hunk headers kept for context).
 */

import { useMemo } from 'react';
import { diffLineTone, splitUnifiedDiff } from '../../o8-panel/diff-render';
import type { PeekOutcome } from './file-edit-diff';

const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const UI_FONT = 'var(--font-sans-system)';
const MAX_HEIGHT = 320;

export function FileEditDiffPeek({ state }: { state: PeekOutcome | 'loading' | null }) {
  const lines = useMemo(() => {
    if (!state || state === 'loading' || state.kind !== 'diff') return [];
    // Drop the `diff --git` / `index` / `---` / `+++` file-header noise for the
    // compact peek; keep hunk headers as section separators.
    return splitUnifiedDiff(state.diff).filter((line) => line.kind !== 'meta');
  }, [state]);

  // Cursor anatomy (vid2 study): an inline block slightly darker than the
  // chat, NO outer border — the diff reads as part of the document flow, with
  // a colored gutter bar carrying the add/remove signal per row.
  const shellStyle = {
    marginTop: 4,
    borderRadius: 6,
    background: 'var(--t-terminal-bg, var(--t-bg-card))',
    overflow: 'hidden',
  };

  if (state === 'loading') {
    return (
      <div style={shellStyle}>
        <div style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span aria-hidden="true" style={{ display: 'inline-flex', animation: 'o8ToolChipPulse 1.6s ease-in-out infinite' }}>
            <DotGlyph />
          </span>
          <span style={{ fontFamily: UI_FONT, fontSize: 11.5, color: 'var(--t-text-muted)' }}>Loading diff…</span>
        </div>
      </div>
    );
  }

  if (!state) return null;

  if (state.kind === 'error') {
    return (
      <div style={shellStyle}>
        <div style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, fontFamily: UI_FONT, fontSize: 11.5, color: 'var(--t-brand-red, #ef4444)' }}>
          {state.message}
        </div>
      </div>
    );
  }

  if (state.kind === 'empty') {
    return (
      <div style={shellStyle}>
        <div style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, fontFamily: UI_FONT, fontSize: 11.5, color: 'var(--t-text-muted)' }}>
          {state.reason}
        </div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <div
        className="cortex-themed-scroll"
        style={{
          maxHeight: MAX_HEIGHT,
          overflowY: 'auto',
          overflowX: 'auto',
          paddingTop: 4,
          paddingBottom: 4,
        }}
      >
        <div style={{ width: '100%', minWidth: 0 }}>
          {lines.map((line, index) => {
            const tone = diffLineTone(line.kind);
            const gutterBar = line.kind === 'add'
              ? 'var(--t-terminal-ansi-bright-green, #16a34a)'
              : line.kind === 'del'
                ? 'var(--t-terminal-ansi-bright-red, #ef4444)'
                : 'transparent';
            return (
              <div
                key={`${index}:${line.text}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '3px 44px minmax(0, 1fr)',
                  minHeight: 17,
                  background: tone.background,
                }}
              >
                <span aria-hidden="true" style={{ background: gutterBar }} />
                <span
                  style={{
                    color: 'var(--t-text-faint)',
                    fontFamily: MONO_FONT,
                    fontSize: 9.5,
                    lineHeight: '17px',
                    paddingRight: 8,
                    textAlign: 'right',
                    userSelect: 'none',
                  }}
                >
                  {line.oldNumber ?? line.newNumber ?? ''}
                </span>
                <span
                  style={{
                    color: tone.color,
                    background: 'transparent',
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    lineHeight: '17px',
                    whiteSpace: 'pre',
                    paddingRight: 12,
                    tabSize: 2,
                  }}
                >
                  {line.text || ' '}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DotGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: 'block', color: 'var(--t-text-muted)' }}>
      <circle cx="12" cy="12" r="5" />
    </svg>
  );
}
