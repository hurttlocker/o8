'use client';

/**
 * Diff cards — the governance moat as a canvas object (#1232). A lane's
 * review diff in glass: the same continuous-diff read as the default
 * Review surface, with Approve & merge / Request changes living right
 * on the card. Data: GET /api/lanes/<id>/diff; merge: POST
 * /api/orchestrator/merge (the identical path approve_and_merge uses).
 */

import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { canvasZoom, FONT, TONE_DOT, glass } from './ui';

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
export const DIFF_MIN_W = 380;
export const DIFF_MIN_H = 260;

export interface DiffCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  laneId: string;
  packetId: string | null;
  title: string;
  branch: string | null;
  stat: string;
  diff: string;
  truncated: boolean;
}

type MergeState =
  | { kind: 'idle' }
  | { kind: 'merging' }
  | { kind: 'merged' }
  | { kind: 'blocked'; note: string };

/** One diff line — the default-side read, in glass tones. */
function diffLineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return { color: 'var(--cnv-ink)', fontWeight: 500, marginTop: line.startsWith('diff --git') ? 10 : 0 };
  }
  if (line.startsWith('@@')) return { color: '#d4a04c', opacity: 0.85 };
  if (line.startsWith('+')) return { color: '#6ee7a0', background: 'rgba(34,197,94,0.08)' };
  if (line.startsWith('-')) return { color: '#f8a5a5', background: 'rgba(239,68,68,0.07)' };
  return { color: 'var(--cnv-ink-muted)' };
}

export function DiffGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
  onRequestChanges,
}: {
  card: DiffCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Hands the operator's words back to the composer, prefilled. */
  onRequestChanges: (card: DiffCard) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [merge, setMerge] = useState<MergeState>({ kind: 'idle' });

  const approve = async () => {
    if (merge.kind === 'merging' || merge.kind === 'merged') return;
    if (!card.packetId) {
      setMerge({ kind: 'blocked', note: 'No packet on this lane — merge it from the default side.' });
      return;
    }
    setMerge({ kind: 'merging' });
    try {
      const response = await fetch('/api/orchestrator/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId: card.packetId }),
      });
      const data = await response.json().catch(() => null) as { merged?: boolean; blockers?: Array<{ note?: string; reason?: string } | string>; error?: string; note?: string } | null;
      if (response.ok && data?.merged) {
        setMerge({ kind: 'merged' });
        return;
      }
      const blockers = Array.isArray(data?.blockers)
        ? data.blockers.map((blocker) => typeof blocker === 'string' ? blocker : blocker?.note ?? blocker?.reason ?? '').filter(Boolean).join(' · ')
        : '';
      setMerge({ kind: 'blocked', note: blockers || data?.error || data?.note || `Merge gate said no (${response.status}).` });
    } catch {
      setMerge({ kind: 'blocked', note: 'Merge request failed — is the lane still alive?' });
    }
  };

  return (
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.86, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      onPointerDownCapture={() => onFocus(card.id)}
      style={{ position: 'absolute', left: card.x, top: card.y, width: card.w, zIndex: card.z }}
    >
      <SmoothCorners
        corners={{ radius: 14 }}
        shadowStrategy="box-shadow"
        style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', ...glass(true) }}
      >
        {/* Title bar — drag handle. */}
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
            onMove(card.id, Math.max(4, drag.originX + (event.clientX - drag.startX) / canvasZoom()), Math.max(40, drag.originY + (event.clientY - drag.startY) / canvasZoom()));
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
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: merge.kind === 'merged' ? '#8b5cf6' : TONE_DOT.waiting, flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 11.5, fontWeight: 500, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.title}
          </span>
          {card.branch ? (
            <span style={{ fontSize: 9, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
              {card.branch}
            </span>
          ) : null}
          <button
            type="button"
            aria-label="Close diff"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{ borderWidth: 0, background: 'transparent', padding: 2, paddingLeft: 8, paddingRight: 6, fontSize: 11, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        </div>

        {/* Stat strip. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 5, paddingBottom: 5, paddingLeft: 12, paddingRight: 12, borderBottom: '1px solid var(--cnv-edge)' }}>
          <span style={{ flex: 1, fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.stat.split('\n').pop()?.trim() || 'No changes'}
            {card.truncated ? '  ·  truncated' : ''}
          </span>
        </div>

        {/* The diff — one continuous read, glass tones. */}
        <div style={{ height: card.h, overflowY: 'auto', overflowX: 'auto', paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, scrollbarWidth: 'thin' } as React.CSSProperties}>
          {card.diff.trim() === '' ? (
            <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
              Clean worktree — nothing to review on this lane.
            </span>
          ) : (
            card.diff.split('\n').map((line, index) => (
              <div key={index} style={{ fontFamily: MONO, fontSize: 10, lineHeight: 1.55, whiteSpace: 'pre', paddingLeft: 4, paddingRight: 4, borderRadius: 3, ...diffLineStyle(line) }}>
                {line || ' '}
              </div>
            ))
          )}
        </div>

        {/* Governance row — approve or push back, right here. A worktree
            diff is YOUR uncommitted work, not a lane — no merge actions. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, borderTop: '1px solid var(--cnv-edge)' }}>
          {card.laneId.startsWith('worktree:') ? (
            <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
              Your uncommitted changes — commit from a terminal or the dashboard.
            </span>
          ) : merge.kind === 'merged' ? (
            <span style={{ fontSize: 10.5, fontWeight: 400, color: '#a78bfa', fontFamily: FONT }}>Merged — the lane is on main.</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { void approve(); }}
                disabled={merge.kind === 'merging'}
                style={{
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--cnv-ink-muted)',
                  background: 'rgba(255,255,255,0.1)',
                  borderRadius: 999,
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 13,
                  paddingRight: 13,
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: 'var(--cnv-ink)',
                  cursor: merge.kind === 'merging' ? 'default' : 'pointer',
                  fontFamily: FONT,
                  opacity: merge.kind === 'merging' ? 0.6 : 1,
                }}
              >
                {merge.kind === 'merging' ? 'Merging…' : 'Approve & merge'}
              </button>
              <button
                type="button"
                onClick={() => onRequestChanges(card)}
                style={{
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--cnv-edge)',
                  background: 'transparent',
                  borderRadius: 999,
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 13,
                  paddingRight: 13,
                  fontSize: 10.5,
                  fontWeight: 300,
                  color: 'var(--cnv-ink-muted)',
                  cursor: 'pointer',
                  fontFamily: FONT,
                }}
                onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
              >
                Request changes
              </button>
            </>
          )}
          {merge.kind === 'blocked' ? (
            <span style={{ flex: 1, fontSize: 9.5, fontWeight: 300, color: '#f8a5a5', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={merge.note}>
              {merge.note}
            </span>
          ) : null}
        </div>

        {/* Corner resize grip. */}
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
              Math.max(DIFF_MIN_W, resize.originW + (event.clientX - resize.startX) / canvasZoom()),
              Math.max(DIFF_MIN_H, resize.originH + (event.clientY - resize.startY) / canvasZoom()),
            );
          }}
          onPointerUp={() => { resizeRef.current = null; setResizing(false); }}
          style={{
            position: 'absolute',
            right: 2,
            bottom: 2,
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
      </SmoothCorners>
    </motion.div>
  );
}
