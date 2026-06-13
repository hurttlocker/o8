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
import { canvasZoom, FONT, TONE_DOT, chatVocabularyRebind, glassChat, type DockEntry } from './ui';
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

const CHAT_MIN_W = 300;
const CHAT_MIN_H = 240;

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
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
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
        {/* Title bar — drag handle, dock-it, close. */}
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
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          {busy ? (
            <span aria-hidden className="o8-orbit" style={{ width: 10, height: 10, color: TONE_DOT.working, flexShrink: 0 }} />
          ) : (
            <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: line.status === 'ready' ? TONE_DOT.working : TONE_DOT.idle, flexShrink: 0 }} />
          )}
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
            <span style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {card.title}
            </span>
            {card.repoName ? (
              <span style={{ fontSize: 9, fontWeight: 260, color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>{card.repoName}</span>
            ) : null}
          </span>
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
            style={{
              borderWidth: 0,
              background: 'transparent',
              padding: 2,
              paddingLeft: 6,
              paddingRight: 6,
              fontSize: 11,
              color: 'var(--cnv-ink-muted)',
              cursor: 'pointer',
              fontFamily: FONT,
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        </div>

        {/* Split tabs — same strip the dock runs; Orchestrator default, one
            click to the Brain. No separate brain icon: Cortex rides here.
            Borderless (Q's reference) — no underline, no divider. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, paddingLeft: 16, paddingRight: 16, paddingTop: 9, flexShrink: 0 }}>
          <DockTab label="Orchestrator" active={activeTab === 'orchestrator'} onClick={() => setActiveTab('orchestrator')} />
          <DockTab label="Cortex" active={activeTab === 'cortex'} onClick={() => setActiveTab('cortex')} />
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
                gap: 10,
                paddingTop: 12,
                paddingLeft: 14,
                paddingRight: 14,
                paddingBottom: 12,
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

            {/* In-card composer — talk to this orchestrator right here.
                Borderless (Q's reference) — no top divider. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingTop: 7, paddingBottom: 9, paddingLeft: 12, paddingRight: 12 }}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                onPointerDown={(event) => event.stopPropagation()}
                placeholder={busy ? 'Working — interrupt from the dock' : `Reply to ${card.title.length > 26 ? `${card.title.slice(0, 26)}…` : card.title}`}
                aria-label={`Message ${card.title}`}
                spellCheck={false}
                disabled={busy}
                style={{
                  flex: 1,
                  borderWidth: 0,
                  outline: 'none',
                  background: 'var(--cnv-tint)',
                  borderRadius: 9,
                  paddingTop: 5,
                  paddingBottom: 5,
                  paddingLeft: 9,
                  paddingRight: 9,
                  color: 'var(--cnv-ink)',
                  fontSize: 11,
                  fontWeight: 300,
                  letterSpacing: '-0.05px',
                  fontFamily: FONT,
                  opacity: busy ? 0.55 : 1,
                }}
              />
            </div>
          </div>
        )}

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
              Math.max(CHAT_MIN_W, resize.originW + (event.clientX - resize.startX) / canvasZoom()),
              Math.max(CHAT_MIN_H, resize.originH + (event.clientY - resize.startY) / canvasZoom()),
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
            zIndex: 2,
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
