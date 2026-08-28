'use client';

/**
 * Chat cards — a past orchestrator session as its OWN draggable glass box
 * (#1232). The right-side dock is reserved for the docked live
 * orchestrator; picking a session from history surfaces it here instead.
 * The dock glyph in the title bar promotes the card INTO the dock (adopts
 * the thread — the next message continues that conversation).
 */

import { memo, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { DockEntryView, DockTab } from './dock';
import { BrainConversation } from './brain-card';
import { CardComposer } from './card-composer';
import { canvasZoom, CHROME, chromeFloorScale, FONT, chatVocabularyRebind, glassChat, scrollFadeY, type DockEntry } from './ui';
import { dragBounds, resistAxis, settleInBounds } from './canvas-drag';
import { CornerResize } from './corner-resize';
import { useThreadOrchestrator, type CanvasThreadEvent } from './use-canvas-orchestrator';
import { useSendBuffer, UndoSendPill, QueuedSends, SEND_UNDO_GRACE_MS } from './use-send-buffer';
import { useScrollBlurFade } from './use-scroll-blur-fade';

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
/** Header chrome above the body (grab pill + tabs) — added to card.h so the
 *  bottom drag boundary clears the composer by the card's TRUE height. */
const CHAT_CHROME_H = 63;

export const ChatGlassCard = memo(function ChatGlassCard({
  card,
  liveEntries,
  sendDefaults,
  onLiveEvent,
  onUserSend,
  onTruncate,
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
  /** Appends the user entry + returns the undo-truncation boundary for it. */
  onUserSend: (card: ChatCard, text: string, sent: boolean) => number;
  /** Erase this card's transcript back to a boundary (undo-send). */
  onTruncate: (lane: string, fromEntryId: number) => void;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  /** Promote this conversation into the orchestrator dock (live line). */
  onDock: (card: ChatCard) => void;
  onClose: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; lastX: number; lastY: number } | null>(null);
  const settleRef = useRef<{ stop: () => void } | null>(null);
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
  useScrollBlurFade(scrollRef);

  // The card IS conversable — its own live line to this exact thread.
  // Docking stays the durability move; talking works right here.
  const line = useThreadOrchestrator(card.repoPath, card.threadId, (event) => {
    onLiveEvent(`thread:${card.threadId}`, event);
  });
  const busy = line.status === 'busy';

  // Same mistake-proofing as the dock + bottom composer: queue-when-busy + an
  // undo-send grace window. Text-only here (chat cards don't attach images).
  const cardBuffer = useSendBuffer({
    busy,
    interrupt: line.interrupt,
    dispatch: (text) => {
      const sent = line.send(text, sendDefaults);
      const fromEntryId = onUserSend(card, text, sent);
      return sent ? { lane: `thread:${card.threadId}`, fromEntryId } : null;
    },
    restore: (text) => setDraft(text),
    truncate: onTruncate,
  });

  const entries = liveEntries ?? card.entries;

  // New entries keep the latest turn in view.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, busy]);

  const submit = () => {
    // Queues if the card is mid-turn; arms undo if it goes out now.
    if (cardBuffer.send(draft)) setDraft('');
  };

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
      data-glass-surface
      data-card-id={card.id}
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
            settleRef.current?.stop();
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
            dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y, lastX: card.x, lastY: card.y };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const bounds = dragBounds(card.w, card.h + CHAT_CHROME_H);
            const zoom = canvasZoom();
            const x = resistAxis(drag.originX + (event.clientX - drag.startX) / zoom, bounds.minX, bounds.maxX);
            const y = resistAxis(drag.originY + (event.clientY - drag.startY) / zoom, bounds.minY, bounds.maxY);
            drag.lastX = x;
            drag.lastY = y;
            onMove(card.id, x, y);
          }}
          onPointerUp={() => {
            const drag = dragRef.current;
            if (drag) {
              settleRef.current = settleInBounds(drag.lastX, drag.lastY, dragBounds(card.w, card.h + CHAT_CHROME_H), (x, y) => onMove(card.id, x, y));
            }
            dragRef.current = null;
            setDragging(false);
          }}
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
          <div role="tablist" aria-label="Orchestrator panel views" style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 20, paddingRight: 12, paddingBottom: 13, minWidth: 0 }}>
            <DockTab label={nameTab} active={activeTab === 'orchestrator'} onClick={() => setActiveTab('orchestrator')} size={CHROME.titleSize} truncate />
            <DockTab label="Cortex" active={activeTab === 'cortex'} onClick={() => setActiveTab('cortex')} size={CHROME.titleSize} />
            {/* Reserved lane — pushes the actions to the right edge and lets the
                title tab truncate (not the actions) as the card narrows. */}
            <div aria-hidden style={{ flex: 1, minWidth: 12 }} />
            {/* Dock + close — hover-revealed, INLINE at the row's right end. The
                old version was absolute top-right and collided with the right
                tab + the NE resize zone; reserving a lane here fixes both, with
                no reflow on hover. Floors with the canvas (#1259). */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                flexShrink: 0,
                opacity: hovered ? 1 : 0,
                pointerEvents: hovered ? 'auto' : 'none',
                transition: 'opacity 160ms ease',
                ...chromeFloorScale('center right'),
              }}
            >
              <button
                type="button"
                aria-label="Dock this conversation"
                title="Dock this conversation"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onDock(card)}
                style={{ borderWidth: 0, background: 'transparent', padding: 4, color: 'var(--cnv-ink-muted)', cursor: 'pointer', display: 'inline-flex' }}
                onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
              >
                <svg style={{ width: CHROME.iconSize, height: CHROME.iconSize, flexShrink: 0, pointerEvents: 'none' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M15 3v18" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Close conversation"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onClose(card.id)}
                style={{ borderWidth: 0, background: 'transparent', padding: 3, paddingLeft: 6, paddingRight: 6, fontSize: CHROME.closeSize, lineHeight: 1, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT }}
                onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
              >
                <span aria-hidden style={{ pointerEvents: 'none' }}>✕</span>
              </button>
            </div>
          </div>
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
                ...scrollFadeY,
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
                <span style={{ fontSize: CHROME.bodySize, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.6, fontFamily: FONT }}>
                  Nothing in this session yet.
                </span>
              ) : null}
            </div>

            {/* In-card composer — talk to this orchestrator right here. Shared
                with the dock: borderless, field-sizing + Input Anticipation.
                Sending while busy QUEUES; a just-sent message is take-back-able
                via the undo pill. */}
            <div style={{ paddingTop: 2, paddingBottom: 14, paddingLeft: 14, paddingRight: 14, flexShrink: 0 }}>
              <QueuedSends items={cardBuffer.queued} onCancel={cardBuffer.cancelQueued} />
              <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: cardBuffer.undoArmed ? 6 : 0 }}>
                <AnimatePresence>
                  {cardBuffer.undoArmed ? <UndoSendPill key="undo" onUndo={cardBuffer.stopOrUndo} graceMs={SEND_UNDO_GRACE_MS} /> : null}
                </AnimatePresence>
              </div>
              <CardComposer
                value={draft}
                onChange={setDraft}
                busy={false}
                model="Opus 4.8"
                placeholder={busy ? `Queue a follow-up to ${card.title.length > 22 ? `${card.title.slice(0, 22)}…` : card.title}…` : `Reply to ${card.title.length > 26 ? `${card.title.slice(0, 26)}…` : card.title}`}
                onSubmit={submit}
              />
            </div>
          </div>
        )}

      </SmoothCorners>

      {/* Unified corner-arc resize — reveals only at the hovered corner, hidden
          in grid mode; free 2-axis from any corner/edge. */}
      <CornerResize card={card} minW={CHAT_MIN_W} minH={CHAT_MIN_H} onMove={onMove} onResize={onResize} onResizingChange={setResizing} />
    </motion.div>
  );
});
