'use client';
/* eslint-disable react-hooks/set-state-in-effect -- the async per-file diff fetch intentionally toggles loading/error/diff state */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from '../lucide-shims';
import { splitUnifiedDiff, diffLineTone, wordDiffSegments, type DiffLine, type WordSegment } from '../o8-panel/diff-render';
import { useWorkspaceChanges } from '../o8-panel/workspace-rail/ChangesList';
import { O8ScratchChat } from '../o8-panel/workspace-rail/O8ScratchChat';
import { ReviewGitActions } from './ReviewGitActions';
import type { ReviewChangedFile } from '@/lib/fleet/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

/**
 * ReviewPanel — the dedicated Review surface for the right panel's `review`
 * mode. Codex-style: one continuous diff, no file-list rail. Every changed
 * file is a collapsible row whose diff loads inline on expand.
 *
 * Phase 1: continuous diff.  Phase 2: Codex-style header — file filter +
 * unified/split diff toggle.  Phase 3: chat-file clicks → header tabs.
 * (A scope dropdown — Last turn / Staged — needs backend data wiring and is
 * tracked as its own follow-up, not part of this header.)
 */

type DiffMode = 'unified' | 'side';
/** Panel → row signal for bulk collapse/expand; rows re-apply `open` on each new identity. */
type CollapseSignal = { open: boolean; nonce: number };
type ReviewScope = 'all' | 'staged' | 'unstaged';
type LocalDiffComment = { id: string; key: string; label: string; body: string; createdAt: number };
type LocalCommentTarget = { key: string; label: string };
const SCOPE_LABELS: Record<ReviewScope, string> = { all: 'All changes', staged: 'Staged', unstaged: 'Unstaged' };
const SCOPE_ORDER: ReviewScope[] = ['all', 'staged', 'unstaged'];
// Above this many visible rows, files default to collapsed so the panel
// doesn't fire N concurrent /api/panel/file-diff requests on mount (#1084).
const BIG_CHANGESET = 25;

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";
const REVIEW_CONTROL_BG = 'var(--t-input-bg, #ffffff)';
const REVIEW_CONTROL_BG_ACTIVE = 'var(--t-chrome-btn-active-bg, var(--t-input-bg, #ffffff))';
const REVIEW_POPOVER_BG = 'var(--t-chat-surface-bg, #faf9f4)';
const REVIEW_POPOVER_SHADOW = '0 16px 40px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.06)';
const REVIEW_DRAWER_WIDTH = 320;

// ── icons (raw SVG — React icon components don't render in the Tauri webview) ──

function IconSearch({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function IconFilesDrawer({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M3 7.5h6l2 2h10" />
      <path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13A2.5 2.5 0 0 0 21 17.5v-8" />
      <path d="M7 4h10a2 2 0 0 1 2 2v3.5" />
    </svg>
  );
}

function IconScopeFilter({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <circle cx="16" cy="7" r="2" />
      <path d="M4 17h2" />
      <path d="M10 17h10" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  );
}

function IconSplit({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

function IconUnified({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function DiffStatBadge({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO_FONT, fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
      {additions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>+{additions}</span> : null}
      {deletions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{deletions}</span> : null}
      {additions === 0 && deletions === 0 ? <span style={{ color: 'var(--t-text-faint)' }}>0</span> : null}
    </span>
  );
}

function lineCommentTarget(line: DiffLine, index: number): LocalCommentTarget {
  const side = line.kind === 'del' ? 'L' : 'R';
  const number = line.kind === 'del' ? line.oldNumber : line.newNumber ?? line.oldNumber;
  const label = `${side}${number ?? index + 1}`;
  return { key: `${side}:${number ?? index}`, label };
}

function LocalCommentComposer({
  label,
  value,
  onChange,
  onCancel,
  onSave,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div style={{ paddingTop: 9, paddingRight: 14, paddingBottom: 10, paddingLeft: 48, background: 'var(--t-bg-card)' }}>
      <div style={{ overflow: 'hidden', borderRadius: 14, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg)', boxShadow: '0 10px 26px rgba(15, 23, 42, 0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 38, paddingLeft: 12, paddingRight: 12, borderBottom: '1px solid var(--t-divider-subtle)' }}>
          <span style={{ flex: 1, fontFamily: UI_FONT, fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>Local comment</span>
          <span style={{ fontFamily: UI_FONT, fontSize: 11, fontWeight: 650, color: 'var(--t-text-muted)' }}>Comment on line {label}</span>
        </div>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Request change"
          autoFocus
          rows={3}
          style={{
            display: 'block',
            width: '100%',
            resize: 'vertical',
            minHeight: 82,
            paddingTop: 10,
            paddingRight: 12,
            paddingBottom: 8,
            paddingLeft: 12,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--t-text)',
            fontFamily: UI_FONT,
            fontSize: 12,
            lineHeight: '18px',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 0, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ height: 28, paddingLeft: 10, paddingRight: 10, border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12, fontWeight: 650, cursor: 'pointer' }}
            onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!value.trim()}
            style={{ height: 28, paddingLeft: 12, paddingRight: 12, border: 'none', borderRadius: 8, background: value.trim() ? 'var(--t-text)' : 'var(--t-hover)', color: value.trim() ? 'var(--t-bg)' : 'var(--t-text-faint)', fontFamily: UI_FONT, fontSize: 12, fontWeight: 750, cursor: value.trim() ? 'pointer' : 'default' }}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}

function LocalCommentNote({ comment }: { comment: LocalDiffComment }) {
  return (
    <div style={{ paddingTop: 7, paddingRight: 14, paddingBottom: 7, paddingLeft: 48, background: 'var(--t-bg-card)' }}>
      <div style={{ borderRadius: 11, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-subtle)', paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: UI_FONT, fontSize: 11, fontWeight: 800, color: 'var(--t-text)' }}>Local comment</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: 'var(--t-text-muted)' }}>{comment.label}</span>
        </div>
        <div style={{ whiteSpace: 'pre-wrap', fontFamily: UI_FONT, fontSize: 12, lineHeight: '18px', color: 'var(--t-text)' }}>{comment.body}</div>
      </div>
    </div>
  );
}

// ── diff rendering ──

const NUM_CELL: CSSProperties = {
  display: 'inline-block',
  width: 32,
  color: 'var(--t-text-faint)',
  textAlign: 'right',
  flexShrink: 0,
  fontVariantNumeric: 'tabular-nums',
  userSelect: 'none',
};

/** Renders a diff line's text with word-level change segments highlighted. */
function WordDiffText({ line, segments }: { line: DiffLine; segments: WordSegment[] }) {
  const strong = line.kind === 'add'
    ? 'color-mix(in srgb, var(--t-terminal-ansi-green, #16a34a) 40%, transparent)'
    : 'color-mix(in srgb, var(--t-brand-red, #ef4444) 40%, transparent)';
  return (
    <>
      <span>{line.text.slice(0, 1)}</span>
      {segments.map((segment, index) => (
        <span key={index} style={segment.changed ? { background: strong, borderRadius: 2 } : undefined}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

function UnifiedDiff({
  lines,
  wrap,
  segMap,
  comments,
  activeComment,
  commentText,
  onOpenComment,
  onCommentTextChange,
  onCancelComment,
  onSaveComment,
}: {
  lines: DiffLine[];
  wrap: boolean;
  segMap: Map<DiffLine, WordSegment[]> | null;
  comments: LocalDiffComment[];
  activeComment: LocalCommentTarget | null;
  commentText: string;
  onOpenComment: (target: LocalCommentTarget) => void;
  onCommentTextChange: (value: string) => void;
  onCancelComment: () => void;
  onSaveComment: () => void;
}) {
  return (
    <div style={{ fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.55, background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)' }}>
      {lines.map((line, index) => {
        const tone = diffLineTone(line.kind);
        const segments = segMap?.get(line);
        const target = lineCommentTarget(line, index);
        const lineComments = comments.filter((comment) => comment.key === target.key);
        return (
          <div key={index}>
            <div
              className="review-diff-line"
              style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 1, paddingBottom: 1, paddingLeft: 6, paddingRight: 12, background: tone.background, color: tone.color, whiteSpace: 'pre' }}
            >
              <button
                type="button"
                className="review-diff-comment-trigger"
                title={`Comment on line ${target.label}`}
                aria-label={`Comment on line ${target.label}`}
                onClick={() => onOpenComment(target)}
                style={{
                  width: 18,
                  height: 18,
                  border: 'none',
                  borderRadius: 4,
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontFamily: UI_FONT,
                  fontSize: 11,
                  fontWeight: 800,
                  lineHeight: '18px',
                  cursor: 'pointer',
                  flexShrink: 0,
                  padding: 0,
                  textAlign: 'center',
                }}
              >
                +
              </button>
              <span style={NUM_CELL}>{line.oldNumber ?? ''}</span>
              <span style={NUM_CELL}>{line.newNumber ?? ''}</span>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' }}>
                {segments ? <WordDiffText line={line} segments={segments} /> : (line.text || ' ')}
              </span>
            </div>
            {lineComments.map((comment) => <LocalCommentNote key={comment.id} comment={comment} />)}
            {activeComment?.key === target.key ? (
              <LocalCommentComposer
                label={target.label}
                value={commentText}
                onChange={onCommentTextChange}
                onCancel={onCancelComment}
                onSave={onSaveComment}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Pair deletions with additions into left/right rows for the split view. */
function sideRows(lines: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.kind !== 'del') {
      rows.push(line?.kind === 'add' ? { left: null, right: line } : { left: line ?? null, right: line ?? null });
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (lines[index]?.kind === 'del') { deletions.push(lines[index]!); index += 1; }
    while (lines[index]?.kind === 'add') { additions.push(lines[index]!); index += 1; }
    index -= 1;
    const count = Math.max(deletions.length, additions.length);
    for (let offset = 0; offset < count; offset += 1) {
      rows.push({ left: deletions[offset] ?? null, right: additions[offset] ?? null });
    }
  }
  return rows;
}

function SideDiff({ lines, wrap, segMap }: { lines: DiffLine[]; wrap: boolean; segMap: Map<DiffLine, WordSegment[]> | null }) {
  const rows = useMemo(() => sideRows(lines), [lines]);
  const textCell: CSSProperties = wrap
    ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingRight: 8 }
    : { whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8 };
  return (
    <div className="cortex-themed-scroll" style={{ background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)', overflowX: 'auto' }}>
      <div style={{ minWidth: wrap ? 0 : 680, fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.55 }}>
        {rows.map((row, index) => {
          const leftTone = diffLineTone(row.left?.kind ?? 'context');
          const rightTone = diffLineTone(row.right?.kind ?? 'context');
          const leftSegs = row.left ? segMap?.get(row.left) : undefined;
          const rightSegs = row.right ? segMap?.get(row.right) : undefined;
          return (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: '30px minmax(0, 1fr) 30px minmax(0, 1fr)' }}>
              <span style={{ ...NUM_CELL, width: 'auto', paddingRight: 6 }}>{row.left?.oldNumber ?? ''}</span>
              <span style={{ ...textCell, background: row.left ? leftTone.background : 'transparent', color: row.left ? leftTone.color : 'var(--t-text-faint)' }}>{leftSegs && row.left ? <WordDiffText line={row.left} segments={leftSegs} /> : (row.left?.text || ' ')}</span>
              <span style={{ ...NUM_CELL, width: 'auto', paddingRight: 6 }}>{row.right?.newNumber ?? ''}</span>
              <span style={{ ...textCell, background: row.right ? rightTone.background : 'transparent', color: row.right ? rightTone.color : 'var(--t-text-faint)' }}>{rightSegs && row.right ? <WordDiffText line={row.right} segments={rightSegs} /> : (row.right?.text || ' ')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffPatch({
  patch,
  mode,
  wrap,
  wordDiff,
  comments,
  activeComment,
  commentText,
  onOpenComment,
  onCommentTextChange,
  onCancelComment,
  onSaveComment,
}: {
  patch: string;
  mode: DiffMode;
  wrap: boolean;
  wordDiff: boolean;
  comments: LocalDiffComment[];
  activeComment: LocalCommentTarget | null;
  commentText: string;
  onOpenComment: (target: LocalCommentTarget) => void;
  onCommentTextChange: (value: string) => void;
  onCancelComment: () => void;
  onSaveComment: () => void;
}) {
  const lines = useMemo(() => splitUnifiedDiff(patch), [patch]);
  const segMap = useMemo(() => (wordDiff ? wordDiffSegments(lines) : null), [lines, wordDiff]);
  return mode === 'side'
    ? <SideDiff lines={lines} wrap={wrap} segMap={segMap} />
    : (
      <UnifiedDiff
        lines={lines}
        wrap={wrap}
        segMap={segMap}
        comments={comments}
        activeComment={activeComment}
        commentText={commentText}
        onOpenComment={onOpenComment}
        onCommentTextChange={onCommentTextChange}
        onCancelComment={onCancelComment}
        onSaveComment={onSaveComment}
      />
    );
}

function RowMessage({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div style={{ paddingTop: 8, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, fontFamily: UI_FONT, fontSize: 11, color: tone === 'error' ? 'var(--t-brand-red)' : 'var(--t-text-muted)', background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)' }}>
      {text}
    </div>
  );
}

function PanelMessage({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div style={{ paddingTop: 18, paddingRight: 16, paddingBottom: 18, paddingLeft: 16, fontFamily: UI_FONT, fontSize: 12, color: tone === 'error' ? 'var(--t-brand-red)' : 'var(--t-text-muted)' }}>
      {text}
    </div>
  );
}

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

function IconMore({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
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

function FilesDrawer({
  open,
  files,
  query,
  onQueryChange,
  selectedPath,
  onSelectFile,
  onClose,
}: {
  open: boolean;
  files: ReviewChangedFile[];
  query: string;
  onQueryChange: (value: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Review files"
      aria-hidden={!open}
      style={{
        position: 'absolute',
        top: 41,
        right: 0,
        bottom: 0,
        width: REVIEW_DRAWER_WIDTH,
        maxWidth: '72%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-bg)',
        boxShadow: open ? '-18px 0 42px rgba(15, 23, 42, 0.08)' : 'none',
        transform: open ? 'translateX(0)' : 'translateX(102%)',
        transition: 'transform 170ms cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: open ? 'auto' : 'none',
        zIndex: 30,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, paddingTop: 8, paddingRight: 10, paddingBottom: 7, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: UI_FONT, fontSize: 12, fontWeight: 700, color: 'var(--t-text)', lineHeight: '16px' }}>Files</div>
          <div style={{ fontFamily: UI_FONT, fontSize: 10.5, fontWeight: 600, color: 'var(--t-text-muted)', lineHeight: '14px' }}>{files.length} changed</div>
        </div>
        <button
          type="button"
          aria-label="Close files drawer"
          onClick={onClose}
          style={{
            width: 26,
            height: 26,
            border: 'none',
            borderRadius: 7,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            fontFamily: UI_FONT,
            fontSize: 17,
            lineHeight: '22px',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          ×
        </button>
      </div>
      <div style={{ paddingTop: 10, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, flexShrink: 0 }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            height: 34,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 10,
            border: '1px solid var(--t-input-border)',
            background: 'var(--t-input-bg)',
            color: 'var(--t-text-muted)',
          }}
        >
          <IconSearch size={13} />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Filter files..."
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--t-text)',
              fontFamily: UI_FONT,
              fontSize: 12,
              lineHeight: '16px',
              padding: 0,
            }}
          />
        </label>
      </div>
      <div className="cortex-scroll-fade-y cortex-themed-scroll cortex-inset-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 2, paddingRight: 6, paddingBottom: 12, paddingLeft: 6 }}>
        {files.length === 0 ? (
          <div style={{ paddingTop: 18, paddingRight: 10, paddingLeft: 10, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
            No files match.
          </div>
        ) : files.map((file) => {
          const { folder, name } = fileDisplayParts(file.path);
          const active = selectedPath === file.path;
          return (
            <button
              type="button"
              key={file.path}
              title={file.path}
              onClick={() => onSelectFile(file.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 42,
                paddingTop: 5,
                paddingRight: 8,
                paddingBottom: 5,
                paddingLeft: 8,
                border: active ? '1px solid var(--t-accent)' : '1px solid transparent',
                borderRadius: 9,
                background: active ? 'var(--t-hover)' : 'transparent',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: UI_FONT, fontSize: 12, fontWeight: 650, lineHeight: '16px', color: 'var(--t-text)' }}>{name}</span>
                {folder ? <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO_FONT, fontSize: 10.5, lineHeight: '14px', color: 'var(--t-text-muted)' }}>{folder}</span> : null}
              </span>
              <DiffStatBadge additions={file.additions ?? 0} deletions={file.deletions ?? 0} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export const ReviewPanel = memo(function ReviewPanel({ repoPath, registeredRepos = [], onRepoPathChange, selectedFile = null }: { repoPath?: string | null; registeredRepos?: RepoRegistryEntry[]; onRepoPathChange?: (repoPath: string) => void; selectedFile?: string | null }) {
  const changes = useWorkspaceChanges(repoPath);
  const [fileQuery, setFileQuery] = useState('');
  const [mode, setMode] = useState<DiffMode>('unified');
  const [wrap, setWrap] = useState(false);
  const [wordDiff, setWordDiff] = useState(false);
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [collapseSignal, setCollapseSignal] = useState<CollapseSignal>({ open: true, nonce: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [scope, setScope] = useState<ReviewScope>('all');
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const repoMenuRef = useRef<HTMLDivElement | null>(null);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const [focusSignal, setFocusSignal] = useState<{ path: string | null; nonce: number }>({ path: null, nonce: 0 });
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // Close the header menus on outside-click or Escape.
  useEffect(() => {
    if (!menuOpen && !scopeOpen && !repoMenuOpen && !filesDrawerOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) setMenuOpen(false);
      if (scopeRef.current && !scopeRef.current.contains(target)) setScopeOpen(false);
      if (repoMenuRef.current && !repoMenuRef.current.contains(target)) setRepoMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setScopeOpen(false);
        setRepoMenuOpen(false);
        setFilesDrawerOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, scopeOpen, repoMenuOpen, filesDrawerOpen]);

  const handleCollapseAll = () => {
    setCollapseSignal((signal) => ({ open: !signal.open, nonce: signal.nonce + 1 }));
    setMenuOpen(false);
  };
  const handleWordWrap = () => {
    setWrap((value) => !value);
    setMenuOpen(false);
  };
  const handleWordDiff = () => {
    setWordDiff((value) => !value);
    setMenuOpen(false);
  };
  const handleHideWhitespace = () => {
    setHideWhitespace((value) => !value);
    setMenuOpen(false);
  };
  const handleRefresh = () => {
    void changes.refresh();
    setMenuOpen(false);
  };
  const handleSelectScope = (next: ReviewScope) => {
    setScope(next);
    setScopeOpen(false);
  };
  const handleSelectRepo = (path: string) => {
    onRepoPathChange?.(path);
    setRepoMenuOpen(false);
  };
  const setRowRef = useCallback((path: string, node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(path, node);
    else rowRefs.current.delete(path);
  }, []);
  const jumpToFile = useCallback((path: string) => {
    setFocusSignal((signal) => ({ path, nonce: signal.nonce + 1 }));
    window.setTimeout(() => {
      rowRefs.current.get(path)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 40);
  }, []);
  const currentRepo = registeredRepos.find((repo) => repo.localPath === repoPath);
  const repoLabel = currentRepo?.name ?? (repoPath ? (repoPath.split('/').filter(Boolean).pop() ?? 'Repo') : 'Repo');

  const visible = useMemo(() => {
    let list = changes.files;
    if (scope === 'staged') list = list.filter((file) => file.staged);
    else if (scope === 'unstaged') list = list.filter((file) => file.unstaged);
    return list;
  }, [changes.files, scope]);
  const drawerQuery = fileQuery.trim().toLowerCase();
  const drawerFiles = useMemo(() => (
    drawerQuery ? visible.filter((file) => file.path.toLowerCase().includes(drawerQuery)) : visible
  ), [drawerQuery, visible]);
  const visibleStats = useMemo(
    () => visible.reduce(
      (acc, file) => ({
        additions: acc.additions + (file.additions ?? 0),
        deletions: acc.deletions + (file.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    ),
    [visible],
  );
  const hasFiles = changes.files.length > 0;
  const denseChangeset = visible.length > BIG_CHANGESET;

  useEffect(() => {
    if (!selectedFile) return;
    jumpToFile(selectedFile);
  }, [jumpToFile, selectedFile]);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--t-bg)', overflow: 'hidden' }}>
      {hasFiles ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, paddingTop: 6, paddingBottom: 6, paddingLeft: 14, paddingRight: 10, borderBottom: '1px solid var(--t-divider-subtle)', flexShrink: 0 }}>
          {registeredRepos.length > 1 ? (
            <div ref={repoMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setRepoMenuOpen((open) => !open)}
                title="Switch repository"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  height: 28,
                  maxWidth: 168,
                  paddingLeft: 9,
                  paddingRight: 7,
                  border: '1px solid var(--t-input-border)',
                  borderRadius: 8,
                  background: repoMenuOpen ? REVIEW_CONTROL_BG_ACTIVE : REVIEW_CONTROL_BG,
                  color: 'var(--t-text)',
                  fontFamily: UI_FONT,
                  fontSize: 12,
                  fontWeight: 650,
                  cursor: 'pointer',
                }}
                onMouseEnter={(event) => { if (!repoMenuOpen) event.currentTarget.style.background = REVIEW_CONTROL_BG_ACTIVE; }}
                onMouseLeave={(event) => { if (!repoMenuOpen) event.currentTarget.style.background = REVIEW_CONTROL_BG; }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{repoLabel}</span>
                <ChevronDown size={12} strokeWidth={2} />
              </button>
              {repoMenuOpen ? (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    top: 34,
                    left: 0,
                    minWidth: 180,
                    maxWidth: 300,
                    padding: 4,
                    borderRadius: 10,
                    background: REVIEW_POPOVER_BG,
                    border: '1px solid var(--t-input-border)',
                    boxShadow: REVIEW_POPOVER_SHADOW,
                    zIndex: 50,
                  }}
                >
                  {registeredRepos.map((repo) => (
                    <MenuItem key={repo.id} checked={repo.localPath === repoPath} onClick={() => handleSelectRepo(repo.localPath)}>
                      {repo.name}
                    </MenuItem>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div ref={scopeRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setScopeOpen((open) => !open)}
              title={SCOPE_LABELS[scope]}
              aria-label={`Review scope: ${SCOPE_LABELS[scope]}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0,
                width: 28,
                height: 28,
                padding: 0,
                border: '1px solid var(--t-input-border)',
                borderRadius: 8,
                background: scopeOpen ? REVIEW_CONTROL_BG_ACTIVE : REVIEW_CONTROL_BG,
                color: scopeOpen ? 'var(--t-text)' : 'var(--t-text-muted)',
                fontFamily: UI_FONT,
                fontSize: 12,
                fontWeight: 650,
                cursor: 'pointer',
              }}
              onMouseEnter={(event) => { if (!scopeOpen) event.currentTarget.style.background = REVIEW_CONTROL_BG_ACTIVE; }}
              onMouseLeave={(event) => { if (!scopeOpen) event.currentTarget.style.background = REVIEW_CONTROL_BG; }}
            >
              <IconScopeFilter size={14} />
            </button>
            {scopeOpen ? (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 34,
                  left: 0,
                  minWidth: 156,
                  padding: 4,
                  borderRadius: 10,
                  background: REVIEW_POPOVER_BG,
                  border: '1px solid var(--t-input-border)',
                  boxShadow: REVIEW_POPOVER_SHADOW,
                  zIndex: 50,
                }}
              >
                {SCOPE_ORDER.map((option) => (
                  <MenuItem key={option} checked={scope === option} onClick={() => handleSelectScope(option)}>
                    {SCOPE_LABELS[option]}
                  </MenuItem>
                ))}
              </div>
            ) : null}
          </div>
          <DiffStatBadge additions={visibleStats.additions} deletions={visibleStats.deletions} />
          <div style={{ flex: 1, minWidth: 8 }} />
          <O8ScratchChat
            repoPath={repoPath}
            selectedFile={selectedFile ?? null}
            surface="diff"
            placement="review-toolbar"
          />
          <ToolbarButton
            title={filesDrawerOpen ? 'Hide files' : 'Show files'}
            active={filesDrawerOpen}
            onClick={() => setFilesDrawerOpen((open) => !open)}
          >
            <IconFilesDrawer size={15} />
          </ToolbarButton>
          <ToolbarButton
            title={mode === 'unified' ? 'Switch to split diff' : 'Switch to unified diff'}
            active={mode === 'side'}
            onClick={() => setMode((current) => (current === 'unified' ? 'side' : 'unified'))}
          >
            {mode === 'unified' ? <IconSplit size={14} /> : <IconUnified size={14} />}
          </ToolbarButton>
          <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <ToolbarButton title="More" active={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <IconMore size={15} />
            </ToolbarButton>
            {menuOpen ? (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 34,
                  right: 0,
                  minWidth: 168,
                  padding: 4,
                  borderRadius: 10,
                  background: REVIEW_POPOVER_BG,
                  border: '1px solid var(--t-input-border)',
                  boxShadow: REVIEW_POPOVER_SHADOW,
                  zIndex: 50,
                }}
              >
                <MenuItem onClick={handleCollapseAll}>{collapseSignal.open ? 'Collapse all' : 'Expand all'}</MenuItem>
                <MenuItem onClick={handleWordWrap} checked={wrap}>Word wrap</MenuItem>
                <MenuItem onClick={handleWordDiff} checked={wordDiff}>Word diffs</MenuItem>
                <MenuItem onClick={handleHideWhitespace} checked={hideWhitespace}>Hide whitespace</MenuItem>
                <MenuItem onClick={handleRefresh}>Refresh</MenuItem>
              </div>
            ) : null}
          </div>
          <ReviewGitActions repoPath={repoPath} branch={changes.branch} repoSlug={changes.repoSlug} onChanged={changes.refresh} />
        </div>
      ) : null}
      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {!repoPath ? (
          <PanelMessage text="Select a repo to review changes." />
        ) : changes.loading && !hasFiles ? (
          <PanelMessage text="Loading changes…" />
        ) : changes.error ? (
          <PanelMessage text={changes.error} tone="error" />
        ) : !hasFiles ? (
          <PanelMessage text="Working tree clean — nothing to review." />
        ) : visible.length === 0 ? (
          <PanelMessage
            text={
              scope === 'staged'
                ? 'No staged changes.'
                : scope === 'unstaged'
                  ? 'No unstaged changes.'
                  : 'No files match.'
            }
          />
        ) : (
          visible.map((file) => (
            <ReviewFileRow
              key={file.path}
              file={file}
              repoPath={repoPath}
              mode={mode}
              wrap={wrap}
              wordDiff={wordDiff}
              hideWhitespace={hideWhitespace}
              initialOpen={!denseChangeset}
              collapseSignal={collapseSignal}
              focusSignal={focusSignal}
              selected={focusSignal.path === file.path}
              setRowRef={setRowRef}
            />
          ))
        )}
      </div>
      {hasFiles ? (
        <FilesDrawer
          open={filesDrawerOpen}
          files={drawerFiles}
          query={fileQuery}
          onQueryChange={setFileQuery}
          selectedPath={focusSignal.path}
          onSelectFile={jumpToFile}
          onClose={() => setFilesDrawerOpen(false)}
        />
      ) : null}
    </div>
  );
});
