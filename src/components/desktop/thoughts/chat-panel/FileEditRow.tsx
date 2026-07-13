'use client';

/**
 * FileEditRow — a dense, live-updating row for one file the agent is editing
 * during a turn (turn-grammar deliverable 2, Cursor parity).
 *
 * Transitions in place as the tool call's status advances:
 *   `Editing main.tsx`            (status: editing — orange spinner glyph)
 *   `Edited main.tsx  +82 −4`     (status: edited  — green/red counts if real)
 *   `Edited main.tsx  · failed`   (status: error   — red)
 *
 * Counts render ONLY when honestly derivable from the edit args (see
 * file-edits.ts). No counts → just `Edited <basename>`.
 *
 * Pure inline styles, theme tokens, raw SVG glyph — matches the transcript
 * density (13.5px / weight 300) already set by ChatActionCard + TurnSummaryCard.
 */

import type { FileEditRowData } from './file-edits';

export function FileEditRow({ edit }: { edit: FileEditRowData }) {
  const working = edit.status === 'editing';
  const failed = edit.status === 'error';
  const verb = working ? 'Editing' : failed ? 'Edited' : 'Edited';
  const hasCounts = typeof edit.added === 'number' || typeof edit.removed === 'number';

  return (
    <div
      role="listitem"
      aria-label={`${verb} ${edit.basename}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: '92%',
        paddingTop: 4,
        paddingRight: 9,
        paddingBottom: 4,
        paddingLeft: 9,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: failed
          ? 'color-mix(in srgb, var(--t-brand-red, #ef4444) 42%, transparent)'
          : 'var(--t-divider-subtle)',
        background: failed
          ? 'color-mix(in srgb, var(--t-brand-red, #ef4444) 8%, var(--t-bg-card))'
          : 'var(--t-bg-card)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 13,
          height: 13,
          flexShrink: 0,
          color: working ? '#FF5A1F' : failed ? 'var(--t-brand-red, #ef4444)' : 'var(--t-text-muted)',
        }}
      >
        <span
          style={working ? { display: 'inline-flex', animation: 'o8ToolChipPulse 1.6s ease-in-out infinite' } : undefined}
        >
          <PencilGlyph />
        </span>
      </span>

      <span
        style={{
          flexShrink: 0,
          fontFamily: 'var(--font-sans-system)',
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: working ? '#FF5A1F' : failed ? 'var(--t-brand-red, #ef4444)' : 'var(--t-text-muted)',
        }}
      >
        {verb}
      </span>

      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
          fontSize: 11,
          color: 'var(--t-text-secondary)',
        }}
        title={edit.path}
      >
        {edit.basename}
      </span>

      {failed ? (
        <span style={{
          flexShrink: 0,
          fontFamily: 'var(--font-sans-system)',
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--t-brand-red, #ef4444)',
        }}>
          failed
        </span>
      ) : hasCounts ? (
        <span style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
          fontSize: 10.5,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {edit.added ? (
            <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>{`+${edit.added}`}</span>
          ) : null}
          {edit.removed ? (
            <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>{`−${edit.removed}`}</span>
          ) : null}
          {!edit.added && !edit.removed ? (
            <span style={{ color: 'var(--t-text-faint)' }}>0</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** Stacked wrapper — renders each edit row in call order under the turn. */
export function FileEditRowStack({ edits }: { edits: FileEditRowData[] }) {
  if (edits.length === 0) return null;
  return (
    <div
      role="list"
      aria-label="Files edited this turn"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: '100%',
      }}
    >
      {edits.map((edit) => (
        <FileEditRow key={edit.id} edit={edit} />
      ))}
    </div>
  );
}

function PencilGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
