'use client';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from 'framer-motion';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { FloatingSurface } from '../FloatingSurface';
import { BrainGlyph } from './BrainGlyph';
import { BrainDockMark } from './BrainDockMark';
import { BrainConversation } from './BrainConversation';
import { useBrainConversation } from './useBrainConversation';
import { brainDockLayout } from './brain-dock-layout';
import { OPEN_COMPOSER_BRAIN_EVENT, type ComposerBrainRequest } from './brain-events';

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function BrainPipButton({ repoPath, conversationKey, preferredRuntime, active = true }: { repoPath?: string | null; conversationKey?: string | null; preferredRuntime?: string; active?: boolean }) {
  const auth = useO8Auth();
  return <ScopedBrainPip key={JSON.stringify([auth.user?.id, repoPath, conversationKey])} repoPath={repoPath} active={active} preferredRuntime={preferredRuntime} />;
}

function ScopedBrainPip({ repoPath, active, preferredRuntime }: { repoPath?: string | null; active: boolean; preferredRuntime?: string }) {
  const client = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const reduceMotion = useReducedMotion();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState('');
  const [layout, setLayout] = useState<ReturnType<typeof brainDockLayout> | null>(null);
  const chat = useBrainConversation(`composer-brain:${id}`, repoPath, context || JSON.stringify({ repoPath }), 'workspace context', preferredRuntime);
  const close = useCallback(() => { setOpen(false); setHovered(false); setKeyboardFocus(false); }, []);
  const show = useCallback(() => {
    const button = trigger.current; const anchor = button?.closest<HTMLElement>('[data-brain-composer-anchor]') ?? button?.parentElement;
    if (anchor) setLayout(brainDockLayout(anchor.getBoundingClientRect(), window.innerWidth));
    setOpen(true);
  }, []);
  useEffect(() => {
    if (!open || !active) return;
    const button = trigger.current;
    const anchor = button?.closest<HTMLElement>('[data-brain-composer-anchor]') ?? button?.parentElement;
    if (!anchor) return;
    let frame = 0;
    const measure = () => {
      if (!button?.getClientRects().length) { close(); return; }
      const next = brainDockLayout(anchor.getBoundingClientRect(), window.innerWidth);
      setLayout(previous => previous && Object.keys(next).every(key => next[key as keyof typeof next] === previous[key as keyof typeof next]) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    schedule();
    const observer = new ResizeObserver(schedule); observer.observe(anchor);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); };
  }, [open, active, close]);
  useEffect(() => {
    const receive = (event: Event) => {
      const request = (event as CustomEvent<ComposerBrainRequest>).detail;
      if (!active || !repoPath || request?.repoPath !== repoPath) return;
      if (request.prompt) setDraft(previous => [previous.trim(), request.prompt].filter(Boolean).join('\n\n'));
      setContext(request.context ?? ''); show();
    };
    window.addEventListener(OPEN_COMPOSER_BRAIN_EVENT, receive);
    return () => window.removeEventListener(OPEN_COMPOSER_BRAIN_EVENT, receive);
  }, [active, repoPath, show]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!active || !repoPath || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'e' || !trigger.current?.getClientRects().length) return;
      event.preventDefault(); if (open) close(); else show();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active, repoPath, open, close, show]);
  // Deactivation hides the PiP immediately; reactivation starts minimized.
  useEffect(() => {
    if (active) return;
    const frame = requestAnimationFrame(close);
    return () => cancelAnimationFrame(frame);
  }, [active, close]);
  const visible = active && open;
  const revealed = visible || hovered || keyboardFocus;
  return <>
    <button ref={trigger} data-brain-dock-tab="" type="button" aria-label="Open Brain" title={repoPath ? 'Think it through with Brain' : 'Select a repository to open Brain'}
      disabled={!repoPath} aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? `brain-pip-${id}` : undefined}
      onClick={() => { if (visible) close(); else show(); }} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocus={event => setKeyboardFocus(event.currentTarget.matches(':focus-visible'))} onBlur={() => setKeyboardFocus(false)}
      style={{ position: 'absolute', top: -13, right: 14, zIndex: 4, width: 44, height: 26, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 8, background: 'transparent', color: visible ? 'var(--t-accent)' : revealed ? 'var(--t-text-muted)' : 'var(--t-text-faint)', cursor: repoPath ? 'pointer' : 'default', opacity: repoPath ? 1 : 0.5 }}>
      <BrainDockMark revealed={revealed} instant={Boolean(reduceMotion) || keyboardFocus} />
    </button>
    {client && visible && layout ? createPortal(<div id={`brain-pip-${id}`} data-hover-pip="" data-brain-composer-pip="" role="dialog" aria-modal={false} aria-label="Brain preview"
      style={{ position: 'fixed', ...layout, zIndex: 190, display: 'flex', flexDirection: 'column', transformOrigin: 'bottom right', fontFamily: 'var(--font-sans-system)' }}>
      <FloatingSurface overlay contentStyle={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, paddingLeft: 14, paddingRight: 6 }}>
          <BrainGlyph size={13} /><span style={{ fontSize: 11, fontWeight: 300 }}>Brain</span><span title={repoPath ?? undefined} style={{ color: 'var(--t-text-faint)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{repoPath?.split('/').filter(Boolean).at(-1)}</span>
          <button type="button" aria-label="Minimize Brain" onClick={close} style={{ width: 26, height: 26, border: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg></button>
        </div>
        <BrainConversation chat={chat} draft={draft} setDraft={setDraft} height={layout.height - 32} close={close} trigger={trigger} />
      </FloatingSurface>
    </div>, document.body) : null}
  </>;
}
