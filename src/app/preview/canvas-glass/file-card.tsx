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
 * v1 is a mono textarea — the CodeMirror upgrade (syntax, o8.md blend,
 * agent-surfaced files) rides the regular-UI issue.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { FONT, TERM_MIN_H, TERM_MIN_W, TONE_DOT, glass } from './ui';

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
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const mtimeRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.86, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      onPointerDownCapture={() => onFocus(card.id)}
      style={{
        position: 'absolute',
        left: card.x,
        top: card.y,
        width: card.w,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 14,
        overflow: 'hidden',
        zIndex: card.z,
        ...glass(true),
      }}
    >
      {/* Title bar — drag handle, dirty dot, save, close. */}
      <div
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          onMove(card.id, Math.max(4, drag.originX + event.clientX - drag.startX), Math.max(40, drag.originY + event.clientY - drag.startY));
        }}
        onPointerUp={() => { dragRef.current = null; setDragging(false); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 12,
          paddingRight: 8,
          borderBottom: '1px solid var(--cnv-edge)',
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: status === 'error' ? '#ef4444' : dirty ? TONE_DOT.waiting : TONE_DOT.idle,
          }}
        />
        <span style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, whiteSpace: 'nowrap' }}>
            {confirmClose ? 'Unsaved — close again to discard' : card.name}
          </span>
          {confirmClose ? null : (
            <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortPath}
            </span>
          )}
        </span>
        {conflict ? (
          <span style={{ fontSize: 9.5, fontWeight: 300, color: TONE_DOT.waiting, fontFamily: FONT, flexShrink: 0 }}>
            Changed on disk — Save overwrites
          </span>
        ) : null}
        {dirty || saving ? (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => { void save(); }}
            disabled={saving}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--cnv-edge)',
              background: 'transparent',
              borderRadius: 999,
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 10,
              paddingRight: 10,
              fontSize: 10,
              fontWeight: 400,
              color: 'var(--cnv-ink)',
              cursor: saving ? 'default' : 'pointer',
              fontFamily: FONT,
              flexShrink: 0,
              opacity: saving ? 0.6 : 1,
            }}
            onMouseEnter={(event) => { if (!saving) event.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close file"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={requestClose}
          style={{
            borderWidth: 0,
            background: 'transparent',
            padding: 2,
            paddingLeft: 8,
            paddingRight: 8,
            fontSize: 11,
            color: confirmClose ? TONE_DOT.waiting : 'var(--cnv-ink-muted)',
            cursor: 'pointer',
            fontFamily: FONT,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = confirmClose ? TONE_DOT.waiting : 'var(--cnv-ink-muted)'; }}
        >
          ✕
        </button>
      </div>

      {/* The editor — transparent mono over the glass + shared veil. */}
      <div style={{ height: card.h, position: 'relative' }}>
        <div aria-hidden style={{ position: 'absolute', inset: 0, background: `rgba(7, 9, 13, ${termVeil.toFixed(2)})` }} />
        {status === 'ready' ? (
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
              lineHeight: 1.5,
              fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
              paddingTop: 10,
              paddingLeft: 12,
              paddingRight: 10,
              paddingBottom: 10,
              whiteSpace: 'pre',
              overflowWrap: 'normal',
              overflow: 'auto',
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

        {/* Corner resize grip — same vocabulary as the terminal card. */}
        <div
          role="presentation"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
            resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originW: card.w, originH: card.h };
            setResizing(true);
          }}
          onPointerMove={(event) => {
            const resize = resizeRef.current;
            if (!resize || resize.pointerId !== event.pointerId) return;
            onResize(
              card.id,
              Math.max(TERM_MIN_W, resize.originW + event.clientX - resize.startX),
              Math.max(TERM_MIN_H, resize.originH + event.clientY - resize.startY),
            );
          }}
          onPointerUp={() => { resizeRef.current = null; setResizing(false); }}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 18,
            height: 18,
            cursor: 'nwse-resize',
            touchAction: 'none',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'flex-end',
            paddingRight: 4,
            paddingBottom: 4,
            opacity: resizing ? 1 : 0.55,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(event) => { if (!resizeRef.current) event.currentTarget.style.opacity = '0.55'; }}
        >
          <svg width={9} height={9} viewBox="0 0 9 9" aria-hidden>
            <path d="M8 1 1 8M8 5 5 8" stroke="var(--cnv-ink-muted)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          </svg>
        </div>
      </div>
    </motion.div>
  );
}
