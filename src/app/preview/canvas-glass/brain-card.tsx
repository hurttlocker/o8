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

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { CHROME, FONT, scrollFadeY } from './ui';
import { Citations, InlineMarkdown, SourcesLine } from './response-blocks';
import { CardComposer } from './card-composer';
import { GlassCardShell } from './card-shell';
import { useScrollBlurFade } from './use-scroll-blur-fade';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';

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
  alert?: string;
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
  useScrollBlurFade(scrollRef);
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
      const response = await fetchWithLongLivedBudget('/api/cortex/ask', {
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
          } else if (frame.event === 'alert' && typeof frame.payload.message === 'string') {
            patch({ alert: frame.payload.message });
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
          ...scrollFadeY,
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
          <span style={{ fontSize: CHROME.bodySize, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, lineHeight: 1.6 }}>
            Ask the Engineering Brain about {repoTail ?? 'this repo'} — instant cited answers from directives, sessions, and PRs.
          </span>
        ) : null}
        {messages.map((message) => (
          <div key={message.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: message.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {message.role === 'user' ? (
              // Soft pill — the same UserMessage shape the orchestrator tab runs.
              <span style={{ maxWidth: '82%', fontSize: CHROME.bodySize, fontWeight: 300, lineHeight: 1.5, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, background: 'var(--cnv-tint)', borderRadius: 15, paddingTop: 8, paddingBottom: 8, paddingLeft: 13, paddingRight: 13 }}>
                {message.content}
              </span>
            ) : (
              // Cortex turn — Read N sources → answer (inline md) → titled citations,
              // 100% the agent-card bench Cortex block.
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '94%' }}>
                {message.sources ? (
                  <SourcesLine count={message.sources.count} pending={message.pending && !message.content} />
                ) : message.pending && !message.content ? (
                  <span style={{ fontSize: CHROME.captionSize, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>Thinking…</span>
                ) : null}
                {message.alert ? (
                  <span role="alert" style={{ fontSize: CHROME.captionSize, fontWeight: 350, lineHeight: 1.45, color: 'var(--cnv-warning, #b45309)', fontFamily: FONT }}>
                    {message.alert}
                  </span>
                ) : null}
                {message.content ? (
                  <span style={{ fontSize: CHROME.bodySize, fontWeight: 300, lineHeight: 1.65, color: 'var(--cnv-ink)', fontFamily: FONT, whiteSpace: 'pre-wrap' }}>
                    {/* Strip the Brain's inline [CITATION:rowId] markers — the
                        titled Sources pills below carry them; raw markers in the
                        prose read as a bug. */}
                    <InlineMarkdown text={message.content.replace(/\s*\[CITATION:[^\]]*\]/g, '')} />
                  </span>
                ) : null}
                {!message.pending && message.citations?.length ? (
                  <Citations
                    sources={message.citations.slice(0, 6).map((citation) => ({ kind: citation.kind, title: citation.title ?? citation.kind ?? 'source' }))}
                    cited={Math.min(message.citations.length, 6)}
                    considered={message.sources?.count ?? message.citations.length}
                  />
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Composer — shared soft pill (field-sizing + Input Anticipation), no
          top divider, matching the orchestrator tab. */}
      <div style={{ paddingTop: 2, paddingBottom: 14, paddingLeft: 14, paddingRight: 14, flexShrink: 0 }}>
        <CardComposer
          value={draft}
          onChange={setDraft}
          busy={asking}
          placeholder={asking ? 'Answering…' : `Ask the Brain about ${repoTail ?? 'this repo'}`}
          onSubmit={() => { void ask(); }}
        />
      </div>
    </div>
  );
}

export const BrainGlassCard = memo(function BrainGlassCard({
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
  const repoTail = card.repoPath ? card.repoPath.split('/').filter(Boolean).pop() ?? null : null;

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={BRAIN_MIN_W}
      minH={BRAIN_MIN_H}
      title="Brain"
      badge={repoTail ?? undefined}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
    >
      {/* Conversation core. */}
      <div style={{ height: card.h, display: 'flex', flexDirection: 'column' }}>
        <BrainConversation repoPath={card.repoPath} initialQuestion={card.initialQuestion} />
      </div>
    </GlassCardShell>
  );
});
