'use client';

/**
 * FileGlassCard — open ANY file on the machine as a canvas object (#1232).
 *
 * View, edit, ⌘S to save. Backed by /api/panel/file-io (absolute paths,
 * loopback-gated, mtime conflict detection). Content state lives INSIDE
 * the card so keystrokes never re-render the page; the page only tracks
 * geometry. Same glass treatment as the terminal: transparent editor over
 * the card tint + the shared veil dial.
 *
 * Chrome is the shared GlassCardShell (centered grab pill, no title-bar
 * lines, Lisse corners, 8-edge resize). The Read/Edit toggle + Save (⌘S)
 * ride the shell's hover actions slot; the editor + save/load logic stay
 * in the body.
 *
 * v1 is a mono textarea — the CodeMirror upgrade (syntax, o8.md blend,
 * agent-surfaced files) rides the regular-UI issue.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CanvasMarkdown } from './dock';
import { CHROME, FONT, TERM_MIN_H, TERM_MIN_W } from './ui';
import { GlassCardShell, ShellAction } from './card-shell';
import { useCanvasRenderProbe } from './perf/render-probe';
import { dispatchWorktreeChanged } from './worktree-diff';

// NOTE: component (+ types) exports only — runtime const exports here would
// break the Fast Refresh boundary and remount live cards on every edit.

export interface FileCard {
  id: number;
  path: string;
  name: string;
  repoPath?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const EDITOR_FONT_SIZE = CHROME.bodySize;
const GUTTER_FONT_SIZE = 11;
const EDITOR_PAD_Y = 10;

function lineCount(text: string): number {
  return Math.max(1, text.split('\n').length);
}

function lineHeightPx(isMarkdown: boolean): number {
  return EDITOR_FONT_SIZE * (isMarkdown ? 1.65 : 1.5);
}

function gutterWidth(count: number): number {
  const digits = Math.max(2, Math.min(4, String(count).length));
  return 18 + digits * 7;
}

function indentSelection(value: string, start: number, end: number): { value: string; start: number; end: number } {
  if (start === end) {
    return {
      value: `${value.slice(0, start)}  ${value.slice(end)}`,
      start: start + 2,
      end: start + 2,
    };
  }
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const selectionEnd = value[end - 1] === '\n' ? end - 1 : end;
  const lineEnd = value.indexOf('\n', selectionEnd);
  const blockEnd = lineEnd === -1 ? value.length : lineEnd;
  const before = value.slice(0, lineStart);
  const block = value.slice(lineStart, blockEnd);
  const after = value.slice(blockEnd);
  const lineAdds = block.split('\n').length * 2;
  return {
    value: `${before}${block.split('\n').map((line) => `  ${line}`).join('\n')}${after}`,
    start: start + 2,
    end: end + lineAdds,
  };
}

function outdentSelection(value: string, start: number, end: number): { value: string; start: number; end: number } {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const selectionEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const lineEnd = value.indexOf('\n', selectionEnd);
  const blockEnd = lineEnd === -1 ? value.length : lineEnd;
  const before = value.slice(0, lineStart);
  const block = value.slice(lineStart, blockEnd);
  const after = value.slice(blockEnd);
  let removedBeforeStart = 0;
  let removedBeforeEnd = 0;
  let offset = lineStart;
  const nextBlock = block
    .split('\n')
    .map((line) => {
      const remove = line.startsWith('  ') ? 2 : line.startsWith(' ') ? 1 : 0;
      if (remove > 0 && offset < start) removedBeforeStart += Math.min(remove, start - offset);
      if (remove > 0 && offset < end) removedBeforeEnd += Math.min(remove, end - offset);
      offset += line.length + 1;
      return remove > 0 ? line.slice(remove) : line;
    })
    .join('\n');
  return {
    value: `${before}${nextBlock}${after}`,
    start: Math.max(lineStart, start - removedBeforeStart),
    end: Math.max(lineStart, end - removedBeforeEnd),
  };
}

export const FileGlassCard = memo(function FileGlassCard({
  card,
  termVeil,
  onMove,
  onResize,
  onFocus,
  onClose,
}: {
  card: FileCard;
  /** Shared interior veil dial — one legibility knob across card kinds. */
  termVeil: number;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
}) {
  useCanvasRenderProbe('file', card.id);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const mtimeRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const editGutterRef = useRef<HTMLDivElement | null>(null);

  // Markdown (o8.md, READMEs, notes) opens RENDERED and word-wrapped;
  // everything else opens straight into the mono editor.
  const isMarkdown = /\.(md|markdown)$/i.test(card.name);
  const [mode, setMode] = useState<'preview' | 'edit'>(isMarkdown ? 'preview' : 'edit');

  const dirty = status === 'ready' && content !== savedContent;
  const lines = lineCount(content);
  const editorLineHeight = lineHeightPx(isMarkdown);
  const gutterW = gutterWidth(lines);

  const syncEditGutter = useCallback(() => {
    if (editGutterRef.current && editorRef.current) {
      editGutterRef.current.scrollTop = editorRef.current.scrollTop;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/panel/file-io?path=${encodeURIComponent(card.path)}`)
      .then(async (response) => {
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok || typeof data?.content !== 'string') {
          setError(typeof data?.error === 'string' ? data.error : 'Could not read file');
          setStatus('error');
          return;
        }
        mtimeRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
        setContent(data.content);
        setSavedContent(data.content);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setError('Could not reach the file API');
        setStatus('error');
      });
    return () => {
      cancelled = true;
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [card.path]);

  useEffect(() => {
    syncEditGutter();
  }, [content, syncEditGutter]);

  const save = useCallback(async () => {
    if (saving || status !== 'ready') return;
    setSaving(true);
    try {
      const response = await fetch('/api/panel/file-io', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: card.path,
          content,
          expectedMtimeMs: mtimeRef.current ?? undefined,
          // A visible conflict means the operator chose to overwrite.
          force: conflict,
        }),
      });
      const data = await response.json();
      if (response.status === 409) {
        setConflict(true);
        return;
      }
      if (!response.ok || !data?.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Save failed');
        setStatus('error');
        return;
      }
      mtimeRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : mtimeRef.current;
      setSavedContent(content);
      setConflict(false);
      if (card.repoPath) dispatchWorktreeChanged(card.repoPath);
    } catch {
      setConflict(false);
      setError('Could not reach the file API');
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }, [card.path, card.repoPath, conflict, content, saving, status]);

  const applyEditorValue = useCallback((next: string, selectionStart?: number, selectionEnd?: number) => {
    setContent(next);
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
        editor.setSelectionRange(selectionStart, selectionEnd);
      }
      syncEditGutter();
    });
  }, [syncEditGutter]);

  const handleEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const editor = event.currentTarget;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (event.shiftKey) {
      const next = outdentSelection(content, start, end);
      applyEditorValue(next.value, next.start, next.end);
      return;
    }
    const next = indentSelection(content, start, end);
    applyEditorValue(next.value, next.start, next.end);
  }, [applyEditorValue, content, save]);

  const requestClose = () => {
    if (!dirty || confirmClose) {
      onClose(card.id);
      return;
    }
    setConfirmClose(true);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmClose(false), 2600);
  };

  const shortPath = card.path.replace(/^\/Users\/[^/]+/, '~');
  // Badge carries the quiet state line: the close-confirm prompt wins, then a
  // disk-conflict warning, then a dirty marker, else the path tail.
  const badgeText = confirmClose
    ? 'Unsaved — close again to discard'
    : conflict
      ? 'Changed on disk — Save overwrites'
      : dirty
        ? `${shortPath}  ·  edited`
        : shortPath;
  const badge = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {dirty ? (
        <span
          aria-label="Unsaved changes"
          style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--t-brand-orange)', flexShrink: 0, transition: 'opacity 140ms ease' }}
        />
      ) : null}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{badgeText}</span>
    </span>
  );

  // Hover actions — Read/Edit toggle (markdown) + Save (⌘S). Body controls
  // stay in the body.
  const actions = (
    <>
      {isMarkdown && status === 'ready' ? (
        <span
          onPointerDown={(event) => event.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 999, border: '1px solid var(--cnv-edge)', overflow: 'hidden', flexShrink: 0 }}
        >
          {(['preview', 'edit'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              style={{
                borderWidth: 0,
                background: mode === option ? 'rgba(255,255,255,0.12)' : 'transparent',
                paddingTop: 2,
                paddingBottom: 2,
                paddingLeft: 9,
                paddingRight: 9,
                fontSize: 9.5,
                fontWeight: mode === option ? 500 : 300,
                color: mode === option ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                cursor: 'pointer',
                fontFamily: FONT,
              }}
            >
              {option === 'preview' ? 'Read' : 'Edit'}
            </button>
          ))}
        </span>
      ) : null}
      {status === 'ready' ? (
        <ShellAction label={saving ? 'Saving…' : 'Save (⌘S)'} onClick={() => { void save(); }}>
          <svg width={13} height={13} viewBox="0 0 24 24" aria-hidden style={{ opacity: saving ? 0.5 : dirty ? 1 : 0.42 }}>
            <path
              d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z M17 21v-8H7v8 M7 3v5h8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ShellAction>
      ) : null}
    </>
  );

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={TERM_MIN_W}
      minH={TERM_MIN_H}
      title={card.name}
      badge={badge}
      actions={actions}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={() => requestClose()}
    >
      {/* The editor — transparent mono over the glass + shared veil. */}
      <div style={{ height: card.h, position: 'relative' }}>
        <div aria-hidden style={{ position: 'absolute', inset: 0, background: `rgba(7, 9, 13, ${termVeil.toFixed(2)})` }} />
        {status === 'ready' && mode === 'preview' ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              overflowY: 'auto',
              paddingTop: 14,
              paddingLeft: 18,
              paddingRight: 16,
              paddingBottom: 16,
              scrollbarWidth: 'none',
            } as React.CSSProperties}
          >
            <CanvasMarkdown text={content} />
          </div>
        ) : status === 'ready' ? (
          <>
            <div
              ref={editGutterRef}
              aria-hidden
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: gutterW,
                overflow: 'hidden',
                paddingTop: EDITOR_PAD_Y,
                paddingLeft: 8,
                paddingRight: 8,
                color: 'var(--cnv-ink-muted-tier, var(--cnv-ink-muted))',
                opacity: 0.58,
                fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
                fontSize: GUTTER_FONT_SIZE,
                lineHeight: `${editorLineHeight}px`,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
                userSelect: 'none',
                borderRight: '1px solid var(--cnv-edge)',
                pointerEvents: 'none',
              }}
            >
              {Array.from({ length: lines }, (_, index) => (
                <div key={index + 1} style={{ height: editorLineHeight }}>{index + 1}</div>
              ))}
            </div>
            <textarea
              ref={editorRef}
              value={content}
              onChange={(event) => applyEditorValue(event.target.value)}
              onScroll={syncEditGutter}
              onInput={syncEditGutter}
              onKeyDown={handleEditorKeyDown}
              spellCheck={false}
              aria-label={`Edit ${card.name}`}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                borderWidth: 0,
                outline: 'none',
                resize: 'none',
                background: 'transparent',
                color: 'var(--cnv-ink)',
                caretColor: '#f59e0b',
                fontSize: EDITOR_FONT_SIZE,
                lineHeight: `${editorLineHeight}px`,
                fontFamily: isMarkdown ? FONT : 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
                paddingTop: EDITOR_PAD_Y,
                paddingLeft: gutterW + 14,
                paddingRight: 16,
                paddingBottom: EDITOR_PAD_Y,
                // Auto word-wrap EVERY file (code included) so long lines scroll
                // vertically on the canvas instead of running off the right edge —
                // pre-wrap keeps indentation, break-word handles long unbroken
                // tokens. (Operator call 2026-06-14.)
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                overflowX: 'hidden',
                overflowY: 'auto',
              }}
            />
          </>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 20, paddingRight: 20 }}>
            {status === 'loading' ? (
              <motion.span
                aria-hidden
                animate={{ rotate: 360 }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
                style={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid transparent', borderTopColor: 'var(--cnv-ink)', borderRightColor: 'var(--cnv-edge)' }}
              />
            ) : (
              <span style={{ fontSize: CHROME.bodySize, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, textAlign: 'center', lineHeight: 1.6 }}>
                {error}
              </span>
            )}
          </div>
        )}
      </div>
    </GlassCardShell>
  );
});
