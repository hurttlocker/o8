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
 * Wave 2 — dual-fidelity diff wiring. Two fidelities from this one row (Cursor):
 *   1. INLINE PEEK (low friction): clicking the row BACKGROUND toggles a small
 *      unified-diff snippet inline (FileEditDiffPeek). Fetched once from
 *      `/api/panel/file-diff`, cached in row state. Click again collapses.
 *   2. FULL REVIEW (high fidelity): clicking the FILENAME dispatches the same
 *      `o8:focus-review` event ChatActionCard uses, so O8Panel flips to the
 *      Review tab and selects this file.
 * Both affordances only light up when a `repoPath` is known (needed to fetch +
 * to scope the review). Without one the row stays Wave-1 display-only.
 *
 * Counts render ONLY when honestly derivable from the edit args (see
 * file-edits.ts). No counts → just `Edited <basename>`.
 *
 * Pure inline styles, theme tokens, raw SVG glyph — matches the transcript
 * density (13.5px / weight 300) already set by ChatActionCard + TurnSummaryCard.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileEditRowData } from './file-edits';
import { FileEditDiffPeek } from './FileEditDiffPeek';
import {
  buildFileDiffUrl,
  formatPeekError,
  interpretFileDiffResponse,
  type FileDiffResponse,
  type PeekOutcome,
} from './file-edit-diff';

type PeekState = PeekOutcome | 'loading' | null;

function dispatchFocusReview(repoPath: string, file: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('o8:focus-review', {
    detail: { repoPath, file },
  }));
}

export function FileEditRow({ edit, repoPath }: { edit: FileEditRowData; repoPath?: string | null }) {
  const working = edit.status === 'editing';
  const failed = edit.status === 'error';
  const verb = working ? 'Editing' : 'Edited';
  const hasCounts = typeof edit.added === 'number' || typeof edit.removed === 'number';

  const trimmedRepo = repoPath?.trim() || '';
  const canInteract = trimmedRepo.length > 0;

  const [expanded, setExpanded] = useState(false);
  const [hoverRow, setHoverRow] = useState(false);
  const [hoverName, setHoverName] = useState(false);
  const [peek, setPeek] = useState<PeekState>(null);
  const loadedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const loadPeek = useCallback(() => {
    if (loadedRef.current || !canInteract) return;
    loadedRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setPeek('loading');
    fetch(buildFileDiffUrl(edit.path, trimmedRepo), { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as FileDiffResponse;
        if (!response.ok && !data.error) throw new Error(`HTTP ${response.status}`);
        return data;
      })
      .then((data) => setPeek(interpretFileDiffResponse(data)))
      .catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') {
          loadedRef.current = false; // allow a retry on the next expand
          return;
        }
        setPeek({ kind: 'error', message: formatPeekError(err) });
      });
  }, [canInteract, edit.path, trimmedRepo]);

  const togglePeek = useCallback(() => {
    if (!canInteract) return;
    setExpanded((prev) => {
      const next = !prev;
      if (next) loadPeek();
      return next;
    });
  }, [canInteract, loadPeek]);

  const onFilename = useCallback((event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation();
    if (canInteract) dispatchFocusReview(trimmedRepo, edit.path);
  }, [canInteract, edit.path, trimmedRepo]);

  return (
    <div role="listitem" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      <div
        {...(canInteract
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-expanded': expanded,
              onClick: togglePeek,
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  togglePeek();
                }
              },
              onMouseEnter: () => setHoverRow(true),
              onMouseLeave: () => setHoverRow(false),
            }
          : {})}
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
            : hoverRow
              ? 'var(--t-hover, var(--t-bg-card))'
              : 'var(--t-bg-card)',
          cursor: canInteract ? 'pointer' : 'default',
          transition: 'background 120ms ease',
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

        {canInteract ? (
          <button
            type="button"
            onClick={onFilename}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onFilename(event);
              }
            }}
            onMouseEnter={() => setHoverName(true)}
            onMouseLeave={() => setHoverName(false)}
            title={`Open ${edit.path} in Review`}
            style={{
              flex: 1,
              minWidth: 0,
              textAlign: 'left',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              borderWidth: 0,
              background: 'transparent',
              padding: 0,
              fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
              fontSize: 11,
              color: hoverName ? 'var(--t-text)' : 'var(--t-text-secondary)',
              textDecoration: hoverName ? 'underline' : 'none',
              textUnderlineOffset: 2,
              cursor: 'pointer',
            }}
          >
            {edit.basename}
          </button>
        ) : (
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
        )}

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

        {canInteract ? (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 12,
              height: 12,
              flexShrink: 0,
              color: 'var(--t-text-faint)',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 140ms ease',
            }}
          >
            <ChevronGlyph />
          </span>
        ) : null}
      </div>

      {expanded ? <FileEditDiffPeek state={peek} /> : null}
    </div>
  );
}

/** Stacked wrapper — renders each edit row in call order under the turn. */
export function FileEditRowStack({ edits, repoPath }: { edits: FileEditRowData[]; repoPath?: string | null }) {
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
        <FileEditRow key={edit.id} edit={edit} repoPath={repoPath} />
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

function ChevronGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
