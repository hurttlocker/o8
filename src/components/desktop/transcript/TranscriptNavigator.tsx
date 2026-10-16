'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { TranscriptPeek } from './TranscriptPeek';

export function TranscriptNavigator({ entries, scrollRef }: {
  entries: MobileTranscriptEntry[]; scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const prompts = useMemo(() => entries.flatMap((entry, index) => {
    if (entry.role !== 'user') return [];
    let answer = '';
    for (let i = index + 1; i < entries.length && entries[i].role !== 'user'; i += 1) {
      if (entries[i].role === 'assistant' && entries[i].text.trim()) answer = entries[i].text;
    }
    return [{ id: entry.id, title: entry.text.trim() || 'Attached files', answer }];
  }), [entries]);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState('');
  const [hovered, setHovered] = useState(-1);
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setVisible(host.clientWidth >= 600 && host.scrollHeight > host.clientHeight + 120 && prompts.length >= 4);
        const ids = new Set(prompts.map(prompt => prompt.id));
        const top = host.getBoundingClientRect().top + 80;
        let current = prompts[0]?.id ?? '';
        for (const element of host.querySelectorAll<HTMLElement>('[data-o8-message-id]')) {
          const id = element.dataset.o8MessageId ?? '';
          if (ids.has(id) && element.getBoundingClientRect().top <= top) current = id;
        }
        setActive(current);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (host.firstElementChild) observer.observe(host.firstElementChild);
    host.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); host.removeEventListener('scroll', measure); };
  }, [prompts, scrollRef]);
  if (!visible) return null;
  return <nav aria-label="Conversation prompts" onMouseLeave={() => setHovered(-1)} style={{
    position: 'absolute', left: 2, top: 24, bottom: 30, width: 24, zIndex: 4,
    display: 'flex', flexDirection: 'column', justifyContent: 'safe center', overflowY: 'auto', scrollbarWidth: 'none',
  }}>
    {prompts.map((prompt, index) => <TranscriptPeek key={prompt.id} width={340} placement="right" preview={() => <>
      <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{prompt.title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 8, color: 'var(--t-text-secondary)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{prompt.answer || 'No response yet'}</div>
    </>}>
      <button type="button" aria-label={`Jump to prompt ${index + 1}: ${prompt.title.slice(0, 100)}`}
        aria-current={active === prompt.id ? 'step' : undefined} onMouseEnter={() => setHovered(index)}
        onClick={() => {
          const host = scrollRef.current;
          const target = [...host?.querySelectorAll<HTMLElement>('[data-o8-message-id]') ?? []].find(element => element.dataset.o8MessageId === prompt.id);
          if (!host || !target) return;
          const zoom = host.getBoundingClientRect().height / host.offsetHeight || 1;
          host.scrollTo({ top: host.scrollTop + (target.getBoundingClientRect().top - host.getBoundingClientRect().top) / zoom - 18,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', width: 24, height: Math.max(5, Math.min(18, 500 / prompts.length)),
          border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }}>
        <span style={{ display: 'block', height: 2, borderRadius: 2,
          width: hovered >= 0 ? Math.max(6, 23 - Math.abs(index - hovered) * 5) : active === prompt.id ? 16 : 7,
          background: active === prompt.id || hovered === index ? 'var(--t-text)' : 'var(--t-text-faint)', opacity: active === prompt.id || hovered === index ? 1 : 0.45 }} />
      </button>
    </TranscriptPeek>)}
  </nav>;
}
