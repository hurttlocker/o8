/* eslint-disable react-hooks/set-state-in-effect -- the async per-file diff fetch intentionally toggles loading/error/diff state */
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from '../../lucide-shims';
import type { ReviewChangedFile } from '@/lib/fleet/types';
import type { DiffMode, CollapseSignal, LocalDiffComment, LocalCommentTarget } from './types';
import { UI_FONT, MONO_FONT, REVIEW_CONTROL_BG_ACTIVE } from './constants';
import { DiffStatBadge, IconCheck } from './icons';
import { DiffPatch, RowMessage } from './DiffView';

/** One changed file: a collapsible header + an inline diff loaded on expand. */
const ReviewFileRow = memo(function ReviewFileRow({
  file,
  repoPath,
  mode,
  wrap,
  wordDiff,
  hideWhitespace,
  initialOpen,
  collapseSignal,
  focusSignal,
  selected,
  setRowRef,
}: {
  file: ReviewChangedFile;
  repoPath: string;
  mode: DiffMode;
  wrap: boolean;
  wordDiff: boolean;
  hideWhitespace: boolean;
  initialOpen: boolean;
  collapseSignal: CollapseSignal;
  focusSignal: { path: string | null; nonce: number };
  selected: boolean;
  setRowRef: (path: string, node: HTMLDivElement | null) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<LocalDiffComment[]>([]);
  const [activeComment, setActiveComment] = useState<LocalCommentTarget | null>(null);
  const [commentText, setCommentText] = useState('');

  // Apply the panel-level bulk collapse/expand signal only when it actually
  // changes — never on mount, so the #1084 `initialOpen` default holds.
  // Comparing the previous value (not a first-run flag) stays correct under
  // React StrictMode's double-invoked mount effects.
  const lastSignal = useRef(collapseSignal);
  useEffect(() => {
    if (collapseSignal !== lastSignal.current) {
      lastSignal.current = collapseSignal;
      setOpen(collapseSignal.open);
    }
  }, [collapseSignal]);

  useEffect(() => {
    if (focusSignal.path === file.path) setOpen(true);
  }, [file.path, focusSignal]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDiff(null);
    const params = new URLSearchParams({ path: file.path, workspace: repoPath });
    if (hideWhitespace) params.set('ignoreWhitespace', '1');
    fetch(`/api/panel/file-diff?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { diff?: string; stagedDiff?: string; error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        setDiff(data.diff ?? data.stagedDiff ?? '');
      })
      .catch((err) => {
        if (!cancelled && (err as { name?: string })?.name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Unable to load diff.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // file.additions/deletions are deps so the row re-fetches when
    // useWorkspaceChanges reports the file's diff stats changed (#1084).
  }, [open, file.path, repoPath, hideWhitespace, file.additions, file.deletions]);

  const openComment = useCallback((target: LocalCommentTarget) => {
    setActiveComment(target);
    setCommentText('');
  }, []);

  const cancelComment = useCallback(() => {
    setActiveComment(null);
    setCommentText('');
  }, []);

  const saveComment = useCallback(() => {
    const body = commentText.trim();
    if (!activeComment || !body) return;
    setComments((current) => [
      ...current,
      {
        id: `${activeComment.key}:${Date.now()}`,
        key: activeComment.key,
        label: activeComment.label,
        body,
        createdAt: Date.now(),
      },
    ]);
    setActiveComment(null);
    setCommentText('');
  }, [activeComment, commentText]);

  return (
    <div
      ref={(node) => setRowRef(file.path, node)}
      style={{
        borderBottom: '1px solid var(--t-divider-subtle)',
        background: selected ? 'var(--t-hover)' : 'transparent',
        scrollMarginTop: 46,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={file.path}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 14, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ color: 'var(--t-text-faint)', display: 'inline-flex', flexShrink: 0 }}>
          {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontFamily: MONO_FONT, fontSize: 12, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
          {file.path}
        </span>
        <DiffStatBadge additions={file.additions ?? 0} deletions={file.deletions ?? 0} />
      </button>
      {open ? (
        loading ? (
          <RowMessage text="Loading diff…" />
        ) : error ? (
          <RowMessage text={error} tone="error" />
        ) : diff && diff.trim() ? (
          <DiffPatch
            patch={diff}
            mode={mode}
            wrap={wrap}
            wordDiff={wordDiff}
            comments={comments}
            activeComment={activeComment}
            commentText={commentText}
            onOpenComment={openComment}
            onCommentTextChange={setCommentText}
            onCancelComment={cancelComment}
            onSaveComment={saveComment}
          />
        ) : (
          <RowMessage text="No diff available (binary file or too large)." />
        )
      ) : null}
    </div>
  );
});

// ── header toolbar ──

function ToolbarButton({ active, title, onClick, children }: { active?: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 'none',
        borderRadius: 8,
        background: active ? REVIEW_CONTROL_BG_ACTIVE : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

/** One row of the `···` overflow menu. Toggle items pass `checked`; plain actions omit it. */
function MenuItem({ onClick, checked, children }: { onClick: () => void; checked?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        height: 30,
        paddingLeft: 9,
        paddingRight: 8,
        border: 'none',
        borderRadius: 7,
        background: 'transparent',
        color: 'var(--t-text)',
        fontFamily: UI_FONT,
        fontSize: 12,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {checked !== undefined ? (
        <span style={{ display: 'inline-flex', width: 14, justifyContent: 'center', color: checked ? 'var(--t-accent)' : 'transparent' }}>
          <IconCheck size={13} />
        </span>
      ) : null}
    </button>
  );
}

function fileDisplayParts(path: string) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop() ?? path;
  const folder = parts.join('/');
  return { folder, name };
}

export { ReviewFileRow, ToolbarButton, MenuItem, fileDisplayParts };
