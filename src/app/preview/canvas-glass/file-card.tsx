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

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CanvasMarkdown } from './dock';
import { FONT, TERM_MIN_H, TERM_MIN_W } from './ui';
import { GlassCardShell, ShellAction } from './card-shell';

// NOTE: component (+ types) exports only — runtime const exports here would
// break the Fast Refresh boundary and remount live cards on every edit.

export interface FileCard {
  id: number;
  path: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export function FileGlassCard({
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const mtimeRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Markdown (o8.md, READMEs, notes) opens RENDERED and word-wrapped;
  // everything else opens straight into the mono editor.
  const isMarkdown = /\.(md|markdown)$/i.test(card.name);
  const [mode, setMode] = useState<'preview' | 'edit'>(isMarkdown ? 'preview' : 'edit');

  const dirty = status === 'ready' && content !== savedContent;

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
    } catch {
      setConflict(false);
      setError('Could not reach the file API');
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }, [card.path, conflict, content, saving, status]);

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
  const badge = confirmClose
    ? 'Unsaved — close again to discard'
    : conflict
      ? 'Changed on disk — Save overwrites'
      : dirty
        ? `${shortPath}  ·  edited`
        : shortPath;

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
      {dirty || saving ? (
        <ShellAction label={saving ? 'Saving…' : 'Save (⌘S)'} onClick={() => { void save(); }}>
          <svg width={13} height={13} viewBox="0 0 24 24" aria-hidden style={{ opacity: saving ? 0.5 : 1 }}>
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
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                void save();
              }
            }}
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
              fontSize: 11.5,
              lineHeight: isMarkdown ? 1.65 : 1.5,
              fontFamily: isMarkdown ? FONT : 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
              paddingTop: 10,
              paddingLeft: 16,
              paddingRight: 16,
              paddingBottom: 10,
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
              <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, textAlign: 'center', lineHeight: 1.6 }}>
                {error}
              </span>
            )}
          </div>
        )}
      </div>
    </GlassCardShell>
  );
}
