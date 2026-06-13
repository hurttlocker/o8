'use client';

/**
 * Chat cards — a past orchestrator session as its OWN draggable glass box
 * (#1232). The right-side dock is reserved for the docked live
 * orchestrator; picking a session from history surfaces it here instead.
 * The dock glyph in the title bar promotes the card INTO the dock (adopts
 * the thread — the next message continues that conversation).
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { DockEntryView, DockTab } from './dock';
import { BrainConversation } from './brain-card';
import { CardComposer } from './card-composer';
import { canvasZoom, FONT, chatVocabularyRebind, glassChat, type DockEntry } from './ui';
import { useThreadOrchestrator, type CanvasThreadEvent } from './use-canvas-orchestrator';

export interface ChatCard {
  id: number;
  threadId: string;
  repoPath: string | null;
  repoName: string | null;
  title: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  entries: DockEntry[];
}

// Low floors so the card can shrink to a small near-square if the operator
// wants one (Q: "make it a square size"). Width floor keeps the
// Orchestrator | Cortex strip from wrapping; height floor is the body (chrome
// sits on top), so total ≈ MIN_H + ~63px chrome.
const CHAT_MIN_W = 200;
const CHAT_MIN_H = 140;

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
interface Geom { x: number; y: number; w: number; h: number; }

/** Invisible resize zones — all 8 angles, hidden handles (Q's bench
 *  reference). Edges are thin strips inset from the corners; corners are small
 *  squares that mostly extend OUTWARD so they don't swallow the title-bar
 *  buttons. The top strip stays a hair (10px) so the rest of the title bar
 *  still drags. */
const RESIZE_ZONES: Array<{ key: Edge; cursor: string; style: React.CSSProperties }> = [
  { key: 'n', cursor: 'ns-resize', style: { top: -5, left: 16, right: 16, height: 10 } },
  { key: 's', cursor: 'ns-resize', style: { bottom: -5, left: 16, right: 16, height: 10 } },
  { key: 'e', cursor: 'ew-resize', style: { top: 16, bottom: 16, right: -5, width: 10 } },
  { key: 'w', cursor: 'ew-resize', style: { top: 16, bottom: 16, left: -5, width: 10 } },
  { key: 'ne', cursor: 'nesw-resize', style: { top: -8, right: -8, width: 16, height: 16 } },
  { key: 'nw', cursor: 'nwse-resize', style: { top: -8, left: -8, width: 16, height: 16 } },
  { key: 'se', cursor: 'nwse-resize', style: { bottom: -8, right: -8, width: 16, height: 16 } },
  { key: 'sw', cursor: 'nesw-resize', style: { bottom: -8, left: -8, width: 16, height: 16 } },
];

/** New geometry for a resize drag. card.h is the BODY height (chrome sits on
 *  top), so a top/left grab repositions x/y while the opposite edge stays
 *  put — y += dy with h -= dy keeps the bottom fixed. */
function resizeGeom(edge: Edge, dx: number, dy: number, start: Geom): Geom {
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = start.w + dx;
  if (edge.includes('s')) h = start.h + dy;
  if (edge.includes('w')) { w = start.w - dx; x = start.x + dx; }
  if (edge.includes('n')) { h = start.h - dy; y = start.y + dy; }
  if (w < CHAT_MIN_W) { if (edge.includes('w')) x -= CHAT_MIN_W - w; w = CHAT_MIN_W; }
  if (h < CHAT_MIN_H) { if (edge.includes('n')) y -= CHAT_MIN_H - h; h = CHAT_MIN_H; }
  return { x, y, w, h };
}

export function ChatGlassCard({
  card,
  liveEntries,
  sendDefaults,
  onLiveEvent,
  onUserSend,
  onMove,
  onResize,
  onFocus,
  onDock,
  onClose,
}: {
  card: ChatCard;
  /** The card's live convo lane (page state) — falls back to the history
   *  snapshot the card spawned with. */
  liveEntries: DockEntry[] | null;
  sendDefaults: { model?: string; thinkingEffort?: string };
  onLiveEvent: (lane: string, event: CanvasThreadEvent) => void;
  onUserSend: (card: ChatCard, text: string, sent: boolean) => void;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  /** Promote this conversation into the orchestrator dock (live line). */
  onDock: (card: ChatCard) => void;
  onClose: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; edge: Edge; startX: number; startY: number; start: Geom } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  // Dock + close ride as hover-revealed ghost icons so the bench header (grab
  // pill + tabs) stays clean.
  const [hovered, setHovered] = useState(false);
  // Every orchestrator carries its Cortex side — default Orchestrator, one
  // click to the Brain. Same split the dock runs.
  const [activeTab, setActiveTab] = useState<'orchestrator' | 'cortex'>('orchestrator');
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The card IS conversable — its own live line to this exact thread.
  // Docking stays the durability move; talking works right here.
  const line = useThreadOrchestrator(card.repoPath, card.threadId, (event) => {
    onLiveEvent(`thread:${card.threadId}`, event);
  });
  const busy = line.status === 'busy';

  const entries = liveEntries ?? card.entries;

  // New entries keep the latest turn in view.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, busy]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    const sent = line.send(text, sendDefaults);
    onUserSend(card, text, sent);
    if (sent) setDraft('');
  };

  const onResizeDown = (edge: Edge) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
    resizeRef.current = { pointerId: event.pointerId, edge, startX: event.clientX, startY: event.clientY, start: { x: card.x, y: card.y, w: card.w, h: card.h } };
    setResizing(true);
  };
  const onResizeMove = (event: React.PointerEvent) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const zoom = canvasZoom();
    const next = resizeGeom(resize.edge, (event.clientX - resize.startX) / zoom, (event.clientY - resize.startY) / zoom, resize.start);
    onResize(card.id, next.w, next.h);
    if (next.x !== resize.start.x || next.y !== resize.start.y) onMove(card.id, next.x, next.y);
  };
  const onResizeUp = () => { resizeRef.current = null; setResizing(false); };

  // The orchestrator tab wears the chat's NAME instead of the generic
  // "Orchestrator" (Q: save space + identify the card — the name is the only
  // session label now that the title bar is gone). Truncated so it never
  // overflows the strip; falls back to "Orchestrator" for an untitled lane.
  const nameTab = (() => {
    const t = (card.title || '').trim();
    if (!t) return 'Orchestrator';
    return t.length > 20 ? `${t.slice(0, 19).trimEnd()}…` : t;
  })();

  return (
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.86, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      onPointerDownCapture={() => onFocus(card.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        left: card.x,
        top: card.y,
        width: card.w,
        zIndex: card.z,
      }}
    >
      <SmoothCorners
        corners={{ radius: 22 }}
        shadowStrategy="box-shadow"
        style={{
          display: 'flex',
          flexDirection: 'column',
          ...glassChat(dragging || resizing),
          ...chatVocabularyRebind(),
          // Locked bench treatment: borderless + a lighter shadow (Q: "shadow
          // may be a bit too deep, it can be lesser"). Overrides glassChat's
          // border + deeper shadow for THIS card only — the canvas-wide glass()
          // helper is untouched.
          border: 'none',
          boxShadow: '0 14px 42px rgba(0, 0, 0, 0.24)',
        }}
      >
        {/* Header — grab pill + split tabs, 100% the agent-card bench (Q: match
            the test page). The whole header drags; the pill is the affordance.
            Busy shows via the composer + transcript, not a header dot. */}
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
            flexDirection: 'column',
            alignItems: 'stretch',
            paddingTop: 9,
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 8 }}>
            <span aria-hidden style={{ width: 34, height: 4, borderRadius: 3, background: 'var(--cnv-ink-muted)', opacity: 0.35 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', paddingLeft: 20, paddingRight: 20, paddingBottom: 13 }}>
            <DockTab label={nameTab} active={activeTab === 'orchestrator'} onClick={() => setActiveTab('orchestrator')} />
            <DockTab label="Cortex" active={activeTab === 'cortex'} onClick={() => setActiveTab('cortex')} />
          </div>
        </div>

        {/* Dock + close — hover-revealed ghost icons, top-right corner, so the
            bench header stays clean. pointer-events off when hidden so they
            never swallow the corner resize zone. */}
        <div
          style={{
            position: 'absolute',
            top: 7,
            right: 9,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            transition: 'opacity 160ms ease',
            zIndex: 7,
          }}
        >
          <button
            type="button"
            aria-label="Dock this conversation"
            title="Dock this conversation"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onDock(card)}
            style={{ borderWidth: 0, background: 'transparent', padding: 3, color: 'var(--cnv-ink-muted)', cursor: 'pointer', display: 'inline-flex' }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            <svg style={{ width: 12, height: 12, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M15 3v18" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Close conversation"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{ borderWidth: 0, background: 'transparent', padding: 2, paddingLeft: 6, paddingRight: 6, fontSize: 11, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        </div>

        {activeTab === 'cortex' ? (
          <div style={{ height: card.h, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <BrainConversation repoPath={card.repoPath} locked={dragging || resizing} />
          </div>
        ) : (
          <div style={{ height: card.h, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* Transcript — same entry vocabulary the dock renders. */}
            <div
              ref={scrollRef}
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                paddingTop: 2,
                paddingLeft: 22,
                paddingRight: 22,
                paddingBottom: 18,
                scrollbarWidth: 'none',
                position: 'relative',
              } as React.CSSProperties}
            >
              {entries.map((entry) => (
                <DockEntryView key={entry.id} entry={entry} />
              ))}
              {entries.length === 0 ? (
                <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.6, fontFamily: FONT }}>
                  Nothing in this session yet.
                </span>
              ) : null}
            </div>

            {/* In-card composer — talk to this orchestrator right here. Shared
                with the dock: borderless, field-sizing + Input Anticipation. */}
            <div style={{ paddingTop: 2, paddingBottom: 14, paddingLeft: 14, paddingRight: 14, flexShrink: 0 }}>
              <CardComposer
                value={draft}
                onChange={setDraft}
                busy={busy}
                model="Opus 4.8"
                placeholder={busy ? 'Working — interrupt from the dock' : `Reply to ${card.title.length > 26 ? `${card.title.slice(0, 26)}…` : card.title}`}
                onSubmit={submit}
              />
            </div>
          </div>
        )}

      </SmoothCorners>

      {/* Invisible resize handles — all 8 angles, hidden (Q's bench reference).
          Siblings of SmoothCorners so the slight outward overhang isn't clipped
          by the smooth-corner mask. */}
      {RESIZE_ZONES.map((zone) => (
        <div
          key={zone.key}
          role="presentation"
          onPointerDown={onResizeDown(zone.key)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          style={{ position: 'absolute', cursor: zone.cursor, touchAction: 'none', zIndex: zone.key.length === 2 ? 6 : 5, ...zone.style }}
        />
      ))}
    </motion.div>
  );
}
