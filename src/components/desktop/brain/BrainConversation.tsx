'use client';
import { useEffect, useRef, type RefObject } from 'react';
import { MarkdownRender, proseWithoutBrainCitationMarkers } from '../o8-panel/markdown-render';
import { BrainGlyph } from './BrainGlyph';
import type { useBrainConversation } from './useBrainConversation';

export function BrainConversation({ chat, draft, setDraft, height, close, trigger }: {
  chat: ReturnType<typeof useBrainConversation>; draft: string; setDraft: (value: string) => void;
  height: number; close: () => void; trigger: RefObject<HTMLButtonElement | null>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const card = input.current?.closest('[data-hover-pip]');
    const launcher = trigger.current;
    input.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !card?.contains(document.activeElement)) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (document.activeElement === document.body || card?.contains(document.activeElement)) launcher?.focus({ preventScroll: true });
    };
  }, [close, trigger]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [chat.messages]);
  const routeLabel = chat.route ? chat.route.runtime ? `${chat.route.runtime === 'codex' ? 'Codex' : 'Claude'} · ${chat.route.model}` : 'o8 managed' : 'Connected runtime when available';
  return <div style={{ height, minHeight: 0, display: 'flex', flexDirection: 'column', color: 'var(--t-text)' }}>
    <div ref={log} role="log" aria-label="Brain conversation" aria-live="polite" style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', overscrollBehavior: 'contain', paddingTop: 14, paddingRight: 16, paddingBottom: 14, paddingLeft: 16 }}>
      {!chat.messages.length ? <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingTop: 12 }}>
        <span style={{ color: 'var(--t-text-muted)', paddingTop: 2 }}><BrainGlyph size={23} /></span>
        <div><div style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Let’s think it through.</div>
          <p style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-muted)', marginTop: 6, marginBottom: 0 }}>Ask about this repo, plan a next step, or talk through a decision.</p></div>
      </div> : chat.messages.map(message => <div key={message.id} style={{ marginBottom: 12, fontSize: 12.5, fontWeight: 300, lineHeight: 1.5 }}>
        <div style={{ color: 'var(--t-text-faint)', fontSize: 9.5, marginBottom: 4 }}>{message.role === 'user' ? 'You' : 'Brain'}</div>
        {message.role === 'user' ? <span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span> : message.text ? <MarkdownRender content={proseWithoutBrainCitationMarkers(message.text)} /> : <span role="status" style={{ color: 'var(--t-text-muted)' }}>{message.reading ? `Reading ${message.reading} sources…` : 'Thinking it through…'}</span>}
        {message.sources?.length ? <div aria-label="Answer sources" style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>{message.sources.map((source, index) => <span key={index} title={source.excerpt} style={{ borderRadius: 6, background: 'var(--t-hover)', paddingTop: 3, paddingRight: 6, paddingBottom: 3, paddingLeft: 6, fontSize: 10, color: 'var(--t-text-muted)' }}>{source.title || source.rowId || 'Source'}</span>)}</div> : null}
      </div>)}
      {chat.error ? <p role="alert" style={{ color: 'var(--t-text-secondary)', fontSize: 12 }}>{chat.error}</p> : null}
    </div>
    <form onSubmit={event => { event.preventDefault(); if (!draft.trim() || chat.busy) return; void chat.ask(draft); setDraft(''); }}
      style={{ flexShrink: 0, borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 8, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, borderRadius: 12, background: 'var(--t-input-bg)', paddingTop: 8, paddingRight: 6, paddingBottom: 6, paddingLeft: 10 }}>
        <textarea ref={input} rows={2} aria-label="Message Brain" placeholder="Ask Brain…" value={draft} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          style={{ flex: 1, minWidth: 0, resize: 'none', border: 0, outline: 'none', background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontWeight: 300, fontSize: 12.5, lineHeight: 1.45, scrollbarWidth: 'none' }} />
        <button type="submit" aria-label="Send to Brain" disabled={!draft.trim() || chat.busy} style={{ width: 28, height: 28, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: '50%', background: draft.trim() && !chat.busy ? 'var(--t-accent)' : 'var(--t-hover)', color: draft.trim() && !chat.busy ? 'var(--t-success-contrast)' : 'var(--t-text-faint)', cursor: draft.trim() && !chat.busy ? 'pointer' : 'default' }}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 22, paddingTop: 5, paddingLeft: 4, paddingRight: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 300 }}>
        <span title="Uses your connected runtime first, with managed Brain as the fallback">{routeLabel}</span><span style={{ flex: 1 }} />
        {chat.messages.length ? <button type="button" onClick={chat.clear} style={{ border: 0, background: 'transparent', color: 'var(--t-text-faint)', font: 'inherit', cursor: 'pointer' }}>Clear conversation</button> : null}
      </div>
    </form>
  </div>;
}
