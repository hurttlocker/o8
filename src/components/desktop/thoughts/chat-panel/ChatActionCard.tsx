'use client';

/**
 * ChatActionCard — inline "Edited N files" handle in the orchestrator transcript.
 *
 * Surfaces a compact summary + Review / Undo controls right after the turn that
 * touched files, so the operator does not have to leave chat to find the diff
 * surface. Review hands off to O8Panel's Review tab via the `o8:focus-review`
 * window event; Undo confirms then reverts each file through
 * /api/review/discard.
 *
 * Issue: #1095 (inline action cards).
 */

import { useState } from 'react';

type CardState = 'idle' | 'confirming' | 'undoing' | 'undone' | 'error';

type Props = {
  filesEditedCount: number;
  /** Repo root. Required for the Review handoff + Undo dispatch. */
  repoPath: string | null;
  /** Files to revert when Undo fires. Same list /api/review/workspace returned. */
  filePaths?: string[];
  /** Optional first file to scroll to in the Review surface. */
  firstFilePath?: string | null;
};

export function ChatActionCard({ filesEditedCount, repoPath, filePaths, firstFilePath }: Props) {
  const [state, setState] = useState<CardState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (filesEditedCount <= 0) return null;

  function onReview() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:focus-review', {
      detail: {
        repoPath: repoPath ?? null,
        file: firstFilePath ?? null,
      },
    }));
  }

  async function onUndoConfirmed() {
    if (!filePaths || filePaths.length === 0) {
      setState('idle');
      return;
    }
    setState('undoing');
    setErrorMessage(null);
    try {
      const results = await Promise.allSettled(
        filePaths.map((path) =>
          fetch('/api/review/discard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          }).then(async (response) => {
            if (!response.ok) {
              const body = await response.json().catch(() => null);
              throw new Error(body?.error || `Failed to discard ${path}`);
            }
          }),
        ),
      );
      const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (firstError) {
        setErrorMessage(firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason));
        setState('error');
        return;
      }
      setState('undone');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Undo failed');
      setState('error');
    }
  }

  const summaryText = state === 'undone'
    ? `Reverted ${filesEditedCount} ${filesEditedCount === 1 ? 'file' : 'files'}`
    : `Edited ${filesEditedCount} ${filesEditedCount === 1 ? 'file' : 'files'}`;

  // Wave 2 — the card's per-file list gets the same filename→full-review
  // handoff as FileEditRow (no inline peek here; the card is a rollup, not a
  // live turn). Only renders when we actually have the paths + a repo scope.
  const canReviewFiles = Boolean(repoPath?.trim()) && Array.isArray(filePaths) && filePaths.length > 0;

  return (
    <div
      role="group"
      aria-label="Turn action card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        paddingTop: 9,
        paddingRight: 8,
        paddingBottom: canReviewFiles ? 4 : 9,
        paddingLeft: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'var(--t-input-bg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          color: 'var(--t-text-muted)',
          flexShrink: 0,
        }}
      >
        <FileEditIcon />
      </span>

      <span
        style={{
          flex: 1,
          minWidth: 0,
          color: 'var(--t-text)',
          fontSize: 13.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          lineHeight: 1.25,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {summaryText}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {state === 'confirming' ? (
          <>
            <span style={{ fontSize: 11.5, color: 'var(--t-text-muted)', marginRight: 4 }}>Undo all?</span>
            <ActionButton label="Cancel" onClick={() => setState('idle')}>
              <CrossIcon />
            </ActionButton>
            <ActionButton label="Confirm undo" onClick={onUndoConfirmed} accent>
              <CheckIcon />
            </ActionButton>
          </>
        ) : null}

        {state === 'undoing' ? (
          <span style={{ fontSize: 11.5, color: 'var(--t-text-muted)' }}>Reverting…</span>
        ) : null}

        {state === 'error' ? (
          <>
            <span
              title={errorMessage ?? 'Undo failed'}
              style={{ fontSize: 11.5, color: 'var(--t-text-muted)', marginRight: 4 }}
            >
              Some files could not be reverted
            </span>
            <ActionButton label="Dismiss" onClick={() => { setState('idle'); setErrorMessage(null); }}>
              <CrossIcon />
            </ActionButton>
          </>
        ) : null}

        {state === 'idle' ? (
          <>
            <ActionButton label="Undo" onClick={() => setState('confirming')}>
              <UndoIcon />
              <span style={{ fontSize: 12, marginLeft: 5 }}>Undo</span>
            </ActionButton>
            <ActionButton label="Review" onClick={onReview} accent>
              <ReviewIcon />
              <span style={{ fontSize: 12, marginLeft: 5 }}>Review</span>
            </ActionButton>
          </>
        ) : null}
        </div>
      </div>

      {canReviewFiles && state !== 'undone' ? (
        <ChatActionFileList repoPath={repoPath!.trim()} filePaths={filePaths!} />
      ) : null}
    </div>
  );
}

function basenameOf(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/**
 * The rollup card's per-file list (Wave 2). Truncated at INITIAL_SHOWN with a
 * "Show N more" expander; each row's filename dispatches `o8:focus-review` —
 * same full-fidelity handoff as FileEditRow, no inline peek (this is a rollup,
 * not a live turn). Typography matches the card's mono file idiom.
 */
const INITIAL_SHOWN = 4;

function ChatActionFileList({ repoPath, filePaths }: { repoPath: string; filePaths: string[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? filePaths : filePaths.slice(0, INITIAL_SHOWN);
  const remaining = filePaths.length - shown.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 4, paddingBottom: 4 }}>
      {shown.map((path, index) => (
        <FileListRow key={`${path}-${index}`} path={path} repoPath={repoPath} />
      ))}
      {remaining > 0 && !showAll ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{
            alignSelf: 'flex-start',
            borderWidth: 0,
            background: 'transparent',
            padding: 0,
            marginTop: 2,
            marginLeft: 22,
            fontFamily: 'var(--font-sans-system)',
            fontSize: 11,
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
          }}
        >
          {`Show ${remaining} more`}
        </button>
      ) : null}
    </div>
  );
}

function FileListRow({ path, repoPath }: { path: string; repoPath: string }) {
  const [hover, setHover] = useState(false);
  const onOpen = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation();
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:focus-review', { detail: { repoPath, file: path } }));
  };
  return (
    <button
      type="button"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(event); }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Open ${path} in Review`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        borderWidth: 0,
        background: hover ? 'var(--t-hover)' : 'transparent',
        borderRadius: 6,
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 6,
        paddingRight: 6,
        cursor: 'pointer',
        transition: 'background 120ms ease',
      }}
    >
      <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--t-text-faint)' }}>
        <FileGlyph />
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
          color: hover ? 'var(--t-text)' : 'var(--t-text-secondary)',
          textDecoration: hover ? 'underline' : 'none',
          textUnderlineOffset: 2,
        }}
      >
        {basenameOf(path)}
      </span>
    </button>
  );
}

function FileGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M9 2 H4 a1 1 0 0 0 -1 1 v10 a1 1 0 0 0 1 1 h8 a1 1 0 0 0 1 -1 V7" />
      <path d="M9 2 V7 H13" />
    </svg>
  );
}

function ActionButton({
  label,
  onClick,
  children,
  accent,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  accent?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const hasText = Array.isArray(children);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        width: hasText ? 'auto' : 26,
        paddingTop: 0,
        paddingRight: hasText ? 8 : 0,
        paddingBottom: 0,
        paddingLeft: hasText ? 7 : 0,
        borderWidth: 0,
        borderRadius: 7,
        background: hover ? 'var(--t-hover)' : 'transparent',
        color: accent ? 'var(--t-accent)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      {children}
    </button>
  );
}

function FileEditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2 H4 a1 1 0 0 0 -1 1 v10 a1 1 0 0 0 1 1 h8 a1 1 0 0 0 1 -1 V7" />
      <path d="M9 2 V7 H13" />
      <path d="M10.5 9.5 L7 13 L5.5 13.5 L6 12 L9.5 8.5 Z" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7 L6 4 L6 6 H10 a3 3 0 0 1 3 3 v1 a3 3 0 0 1 -3 3 H5" />
      <path d="M6 6 L3 7 L6 8" />
    </svg>
  );
}

function ReviewIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4 H14" />
      <path d="M2 8 H10" />
      <path d="M2 12 H8" />
      <circle cx="12" cy="12" r="2" />
      <path d="M13.5 13.5 L15 15" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5 L6.5 12 L13 4" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4 L12 12" />
      <path d="M12 4 L4 12" />
    </svg>
  );
}
