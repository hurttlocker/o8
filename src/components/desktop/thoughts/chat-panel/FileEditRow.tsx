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

/**
 * Stacked wrapper — renders each edit row in call order under the turn.
 *
 * Cursor parity (operator ruling 2026-07-13): once EVERY edit has settled and
 * there is more than one, the stack collapses to a single slim line —
 * "Edited 9 files +349 −3" with colored counts (summed only from honestly
 * derivable per-edit counts; no numbers when none derive) — expandable back to
 * the per-file rows. Live edits and failures always show the full rows.
 */
export function FileEditRowStack({ edits, repoPath }: { edits: FileEditRowData[]; repoPath?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (edits.length === 0) return null;

  const anyWorking = edits.some((edit) => edit.status === 'editing');
  const anyFailed = edits.some((edit) => edit.status === 'error');
  const collapsible = edits.length > 1 && !anyWorking && !anyFailed;

  if (collapsible && !expanded) {
    const added = edits.reduce((sum, edit) => sum + (typeof edit.added === 'number' ? edit.added : 0), 0);
    const removed = edits.reduce((sum, edit) => sum + (typeof edit.removed === 'number' ? edit.removed : 0), 0);
    const hasCounts = edits.some((edit) => typeof edit.added === 'number' || typeof edit.removed === 'number');
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        aria-label={`Show the ${edits.length} files edited this turn`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          border: 'none',
          background: 'transparent',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          color: 'var(--t-text-muted)',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 12,
          fontWeight: 400,
          letterSpacing: '-0.005em',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span>{`Edited ${edits.length} files`}</span>
        {hasCounts ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
            fontSize: 10.5,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {added > 0 ? (
              <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>{`+${added}`}</span>
            ) : null}
            {removed > 0 ? (
              <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>{`−${removed}`}</span>
            ) : null}
          </span>
        ) : null}
        <StackChevron open={false} />
      </button>
    );
  }

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
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-expanded={true}
          aria-label="Collapse the edited-files list"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: 'none',
            background: 'transparent',
            padding: 0,
            textAlign: 'left',
            cursor: 'pointer',
            color: 'var(--t-text-muted)',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 12,
            fontWeight: 400,
            letterSpacing: '-0.005em',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <span>{`Edited ${edits.length} files`}</span>
          <StackChevron open={true} />
        </button>
      ) : null}
      {edits.map((edit) => (
        <FileEditRow key={edit.id} edit={edit} repoPath={repoPath} />
      ))}
    </div>
  );
}

function StackChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        display: 'block',
        flexShrink: 0,
        color: 'var(--t-text-faint)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
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
