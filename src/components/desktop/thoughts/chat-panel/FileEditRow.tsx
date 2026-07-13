'use client';

/**
 * FileEditRow — one file the agent is editing during a turn, as a SLIM TEXT
 * LINE (Cursor parity, vid2 2:26–3:20 mechanics — operator ruling 2026-07-13:
 * no boxes, no pills; shimmer for live, text + a small chevron for settled).
 *
 * Lifecycle per file:
 *   `Editing main.tsx`            — live: plain text with the sheen shimmer
 *   `Edited main.tsx +82 −4 ›`    — settled: muted verb, mono filename
 *                                   (hover underline → opens Review), green/red
 *                                   counts, chevron toggles the inline diff peek
 *   `Edited main.tsx failed`      — error: red
 *
 * The stack renders a live AGGREGATE header above the per-file lines:
 *   `Editing 12 files, explored 2 files, ran 1 command +903 −3` — the counts
 * TICK UP as each edit settles (re-render per status change, tabular-nums), the
 * verb flips to `Edited` when the run completes, and the chevron collapses the
 * per-file list (expanded by default — the finished run stays visible).
 *
 * Counts render ONLY when honestly derivable from the edit args (see
 * file-edits.ts). No counts → just the filename. Wave 2 dual-fidelity diff
 * wiring (inline peek + filename→review) is unchanged underneath.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileEditRowData } from './file-edits';
import { FileEditDiffPeek } from './FileEditDiffPeek';
import { DiffCounts, ShimmerLine, TurnChevron, turnLineStyle } from './turn-line';
import {
  buildFileDiffUrl,
  formatPeekError,
  interpretFileDiffResponse,
  type FileDiffResponse,
  type PeekOutcome,
} from './file-edit-diff';

type PeekState = PeekOutcome | 'loading' | null;

const MONO_FONT = 'var(--font-mono, "SF Mono", Menlo, monospace)';

function dispatchFocusReview(repoPath: string, file: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('o8:focus-review', {
    detail: { repoPath, file },
  }));
}

export function FileEditRow({ edit, repoPath }: { edit: FileEditRowData; repoPath?: string | null }) {
  const working = edit.status === 'editing';
  const failed = edit.status === 'error';
  const hasCounts = typeof edit.added === 'number' || typeof edit.removed === 'number';

  const trimmedRepo = repoPath?.trim() || '';
  const canInteract = trimmedRepo.length > 0;

  const [expanded, setExpanded] = useState(false);
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

  // Live: a plain shimmering text line — no icon, no chevron, no box.
  if (working) {
    return (
      <div role="listitem" style={{ paddingLeft: 12 }}>
        <ShimmerLine>
          Editing
          <span style={{ fontFamily: MONO_FONT, fontSize: 11.5 }}>{edit.basename}</span>
        </ShimmerLine>
      </div>
    );
  }

  return (
    <div role="listitem" style={{ display: 'flex', flexDirection: 'column', width: '100%', paddingLeft: 12 }}>
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
            }
          : {})}
        aria-label={`Edited ${edit.basename}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          maxWidth: '92%',
          cursor: canInteract ? 'pointer' : 'default',
        }}
      >
        <span style={{ ...turnLineStyle, flexShrink: 0, color: failed ? 'var(--t-brand-red, #ef4444)' : 'var(--t-text-muted)' }}>
          Edited
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
              minWidth: 0,
              maxWidth: '60%',
              textAlign: 'left',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              borderWidth: 0,
              background: 'transparent',
              padding: 0,
              fontFamily: MONO_FONT,
              fontSize: 11.5,
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
              minWidth: 0,
              maxWidth: '60%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: MONO_FONT,
              fontSize: 11.5,
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
            fontSize: 10.5,
            fontWeight: 500,
            color: 'var(--t-brand-red, #ef4444)',
          }}>
            failed
          </span>
        ) : hasCounts ? (
          <DiffCounts added={edit.added ?? 0} removed={edit.removed ?? 0} />
        ) : null}

        {canInteract && !failed ? <TurnChevron open={expanded} /> : null}
      </div>

      {expanded ? <FileEditDiffPeek state={peek} /> : null}
    </div>
  );
}

/**
 * Stacked wrapper — the live-counting aggregate line plus per-file lines.
 *
 * `extras` folds the turn's non-edit tool summary into the aggregate line
 * (Cursor's settled form: "Edited 12 files, ran 1 command, explored 1 lint
 * +379 −0") — passed by DesktopAgentMessage from the tool cluster's counts.
 */
export function FileEditRowStack({ edits, repoPath, extras = [] }: {
  edits: FileEditRowData[];
  repoPath?: string | null;
  extras?: string[];
}) {
  // Expanded by default — a finished run stays visible; the chevron collapses.
  const [collapsed, setCollapsed] = useState(false);
  if (edits.length === 0) return null;

  const anyWorking = edits.some((edit) => edit.status === 'editing');
  const added = edits.reduce((sum, edit) => sum + (typeof edit.added === 'number' ? edit.added : 0), 0);
  const removed = edits.reduce((sum, edit) => sum + (typeof edit.removed === 'number' ? edit.removed : 0), 0);

  const verb = anyWorking ? 'Editing' : 'Edited';
  // Count DISTINCT files (a file edited twice is still one file), matching
  // Cursor's aggregate semantics; the per-call rows below stay one-per-call.
  const count = new Set(edits.map((edit) => edit.path)).size;
  const noun = count === 1 ? 'file' : 'files';
  const summaryParts = [`${count} ${noun}`, ...extras];
  const summaryText = `${verb} ${summaryParts.join(', ')}`;

  return (
    <div
      role="list"
      aria-label="Files edited this turn"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        width: '100%',
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show the edited files' : 'Collapse the edited-files list'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          border: 'none',
          background: 'transparent',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {anyWorking ? (
          <ShimmerLine>{summaryText}</ShimmerLine>
        ) : (
          <span style={{ ...turnLineStyle, flexShrink: 0 }}>{summaryText}</span>
        )}
        <DiffCounts added={added} removed={removed} />
        <TurnChevron open={!collapsed} />
      </button>

      {collapsed ? null : edits.map((edit) => (
        <FileEditRow key={edit.id} edit={edit} repoPath={repoPath} />
      ))}
    </div>
  );
}
