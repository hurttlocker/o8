'use client';

/**
 * Brain on the canvas (#1232). `BrainConversation` is the chrome-agnostic
 * core — ask a question about the scoped repo, watch retrieval ("Reading N
 * sources…") then the streamed answer with titled citation pills (the same
 * titled-sources contract every Brain surface renders). It inherits whatever
 * --cnv-* vars its host provides, so it drops into the floating Brain card OR
 * the orchestrator dock's Brain tab unchanged.
 *
 * `BrainGlassCard` wraps it in the draggable/resizable canvas card chrome.
 * Conversation is ephemeral like the ScratchChat popover's — the card's
 * geometry persists, the transcript doesn't.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { canvasZoom, FONT, glassChat, chatVocabularyRebind } from './ui';

export interface BrainCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  repoPath: string | null;
  /** One-shot question injected by the canvas intent bus — asked on mount,
   *  never persisted. A new value on an existing card asks again. */
  initialQuestion?: string;
}

export const BRAIN_MIN_W = 300;
export const BRAIN_MIN_H = 320;

interface BrainCitation {
  kind?: string;
  rowId?: string;
  title?: string;
}

interface BrainMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
  sources?: { count: number; top: Array<{ kind: string; title: string }> };
  citations?: BrainCitation[];
}

/** SSE frames arrive as `event: name` + `data: {…}` blocks split on \n\n. */
function parseFrame(block: string): { event: string; payload: Record<string, unknown> } | null {
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) eventName = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (!dataLines.length) return null;
  try {
    return { event: eventName, payload: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * The Brain Q&A core — transcript + composer, no card chrome. Fills its
 * parent (flex column); the host owns the height and the glass vars.
 */
export function BrainConversation({
  repoPath,
  initialQuestion,
  locked,
}: {
  repoPath: string | null;
  initialQuestion?: string;
  /** Host is mid drag/resize — suppress transcript pointer events. */
  locked?: boolean;
}) {
  const [messages, setMessages] = useState<BrainMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const idRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const repoTail = repoPath ? repoPath.split('/').filter(Boolean).pop() ?? null : null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Leaving the host mid-answer cancels the stream.
  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? draft).trim();
    if (!question || asking) return;
    const userId = idRef.current;
    idRef.current += 1;
    const assistantId = idRef.current;
    idRef.current += 1;
    setMessages((previous) => [
      ...previous,
      { id: userId, role: 'user', content: question },
      { id: assistantId, role: 'assistant', content: '', pending: true },
    ]);
    setDraft('');
    setAsking(true);

    const patch = (update: Partial<BrainMessage>) => {
      setMessages((previous) => previous.map((message) => (
        message.id === assistantId ? { ...message, ...update } : message
      )));
    };

    // Whole-ask ceiling — a hung backend never leaves a silent bubble.
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch('/api/cortex/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, repoPath: repoPath ?? undefined }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Brain ask failed (${response.status}).`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let answer = '';
      const citations: BrainCitation[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const frame = parseFrame(block);
          if (!frame) continue;
          if (frame.event === 'token' && typeof frame.payload.text === 'string') {
            answer += frame.payload.text;
            patch({ content: answer });
          } else if (frame.event === 'sources') {
            patch({
              sources: {
                count: typeof frame.payload.count === 'number' ? frame.payload.count : 0,
                top: Array.isArray(frame.payload.top) ? (frame.payload.top as Array<{ kind: string; title: string }>) : [],
              },
            });
          } else if (frame.event === 'citation') {
            citations.push(frame.payload as BrainCitation);
          } else if (frame.event === 'error' && typeof frame.payload.message === 'string') {
            throw new Error(frame.payload.message);
          }
        }
      }
      patch({ pending: false, citations: citations.length ? citations : undefined, content: answer || 'No answer came back.' });
    } catch (error) {
      const message = (error as { name?: string })?.name === 'AbortError'
        ? 'The Brain took too long — try again.'
        : error instanceof Error ? error.message : 'Brain ask failed.';
      patch({ pending: false, content: message });
    } finally {
      clearTimeout(timeoutId);
      if (abortRef.current === controller) abortRef.current = null;
      setAsking(false);
    }
  }, [asking, repoPath, draft]);

  // A question injected by the canvas intent bus asks itself — once per value,
  // so re-renders never re-fire it but a fresh intent on an open host does.
  const lastInjectedRef = useRef<string | null>(null);
  useEffect(() => {
    const question = initialQuestion?.trim();
    if (!question || lastInjectedRef.current === question) return;
    lastInjectedRef.current = question;
    void ask(question);
  }, [ask, initialQuestion]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      {/* Transcript. */}
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
          paddingBottom: 12,
          paddingLeft: 14,
          paddingRight: 14,
          scrollbarWidth: 'none',
          ...(locked ? { pointerEvents: 'none' } : {}),
        } as React.CSSProperties}
      >
        {messages.length === 0 ? (
          <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, lineHeight: 1.6 }}>
            Ask the Engineering Brain about {repoTail ?? 'this repo'} — instant cited answers from directives, sessions, and PRs.
          </span>
        ) : null}
        {messages.map((message) => (
          <div key={message.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: message.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {message.role === 'user' ? (
              <span style={{ maxWidth: '88%', fontSize: 11.5, fontWeight: 300, lineHeight: 1.55, color: 'var(--cnv-ink)', fontFamily: FONT, background: 'var(--cnv-tint)', borderRadius: 11, paddingTop: 6, paddingBottom: 6, paddingLeft: 10, paddingRight: 10 }}>
                {message.content}
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '94%' }}>
                {message.pending && !message.content ? (
                  <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
                    {message.sources ? `Reading ${message.sources.count} sources…` : 'Thinking…'}
                  </span>
                ) : null}
                {message.content ? (
                  <span style={{ fontSize: 11.5, fontWeight: 300, lineHeight: 1.6, color: 'var(--cnv-ink)', fontFamily: FONT, whiteSpace: 'pre-wrap' }}>
                    {message.content}
                  </span>
                ) : null}
                {!message.pending && message.citations?.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {message.citations.slice(0, 6).map((citation, index) => (
                      <span
                        key={`${message.id}-${index}`}
                        title={citation.title ?? citation.rowId}
                        style={{ fontSize: 9, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, border: '1px solid var(--cnv-edge)', borderRadius: 7, paddingTop: 2, paddingBottom: 2, paddingLeft: 7, paddingRight: 7, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {citation.title ?? `${citation.kind ?? 'source'}`}
                      </span>
                    ))}
                    {message.sources ? (
                      <span style={{ fontSize: 9, fontWeight: 260, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingTop: 3 }}>
                        {`${Math.min(message.citations.length, 6)} cited · ${message.sources.count} considered`}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Composer. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, borderTop: '1px solid var(--cnv-edge)' }}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
          placeholder={asking ? 'Answering…' : `Ask the Brain about ${repoTail ?? 'this repo'}`}
          aria-label="Ask the Brain"
          disabled={asking}
          style={{
            flex: 1,
            borderWidth: 0,
            outline: 'none',
            background: 'var(--cnv-tint)',
            borderRadius: 9,
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 10,
            paddingRight: 10,
            color: 'var(--cnv-ink)',
            fontSize: 11,
            fontWeight: 300,
            fontFamily: FONT,
            opacity: asking ? 0.6 : 1,
          }}
        />
      </div>
    </div>
  );
}

export function BrainGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
}: {
  card: BrainCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  const repoTail = card.repoPath ? card.repoPath.split('/').filter(Boolean).pop() ?? null : null;

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
        corners={{ radius: 14 }}
        shadowStrategy="box-shadow"
        style={{ display: 'flex', flexDirection: 'column', ...glassChat(dragging || resizing), ...chatVocabularyRebind() }}
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
            paddingTop: 7,
            paddingBottom: 7,
            paddingLeft: 12,
            paddingRight: 8,
            borderBottom: '1px solid var(--cnv-edge)',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          <svg style={{ width: 11, height: 11, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 7.4l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9-2.9-1.1 2.9-1.1z" />
          </svg>
          <span style={{ flex: 1, fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Brain
            {repoTail ? <span style={{ color: 'var(--cnv-ink-muted)', fontWeight: 260 }}>{`  ·  ${repoTail}`}</span> : null}
          </span>
          <button
            type="button"
            aria-label="Close Brain"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{
              borderWidth: 0,
              background: 'transparent',
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 8,
              paddingRight: 8,
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

        {/* Conversation core. */}
        <div style={{ height: card.h, display: 'flex', flexDirection: 'column' }}>
          <BrainConversation repoPath={card.repoPath} initialQuestion={card.initialQuestion} locked={dragging || resizing} />
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
              Math.max(BRAIN_MIN_W, resize.originW + (event.clientX - resize.startX) / canvasZoom()),
              Math.max(BRAIN_MIN_H, resize.originH + (event.clientY - resize.startY) / canvasZoom()),
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
