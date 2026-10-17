'use client';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { HoverPipCard } from '../HoverPipCard';
import { BrainGlyph } from './BrainGlyph';
import { BrainConversation } from './BrainConversation';
import { useBrainConversation } from './useBrainConversation';

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function BrainPipButton({ repoPath, conversationKey, active = true }: { repoPath?: string | null; conversationKey?: string | null; active?: boolean }) {
  const auth = useO8Auth();
  return <ScopedBrainPip key={JSON.stringify([auth.user?.id, repoPath, conversationKey])} repoPath={repoPath} active={active} />;
}

function ScopedBrainPip({ repoPath, active }: { repoPath?: string | null; active: boolean }) {
  const client = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const id = useId(); const eventName = `o8:brain-pip:${id}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const chat = useBrainConversation(`composer-brain:${id}`, repoPath, JSON.stringify({ repoPath }), 'workspace context');
  useEffect(() => {
    if (!open) return;
    const button = trigger.current;
    if (!button) return;
    const observer = new ResizeObserver(() => {
      if (!button.getClientRects().length) window.dispatchEvent(new CustomEvent(eventName, { detail: { open: false } }));
    });
    observer.observe(button);
    return () => observer.disconnect();
  }, [eventName, open]);
  return <>
    <button ref={trigger} type="button" aria-label="Open Brain" title={repoPath ? 'Think it through with Brain' : 'Select a repository to open Brain'}
      disabled={!repoPath} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `brain-pip-${id}` : undefined}
      onClick={() => window.dispatchEvent(new CustomEvent(eventName, { detail: { toggle: true } }))}
      onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={event => { event.currentTarget.style.background = open ? 'var(--t-hover)' : 'transparent'; }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 30, height: 28, padding: 0, border: 0, borderRadius: 8, background: open ? 'var(--t-hover)' : 'transparent', color: open ? 'var(--t-accent)' : 'var(--t-text-muted)', cursor: repoPath ? 'pointer' : 'default', opacity: repoPath ? 1 : 0.5 }}><BrainGlyph /></button>
    {client ? createPortal(<HoverPipCard active={active} available={Boolean(repoPath)} eventName={eventName}
      storageKey="o8:brain-pip" title="Brain" titleTooltip={repoPath ?? undefined} contextKey={JSON.stringify([repoPath, active])} headerContent={<span title={repoPath ?? undefined} style={{ color: 'var(--t-text-faint)', fontSize: 9.5, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repoPath?.split('/').filter(Boolean).at(-1)}</span>}
      id={`brain-pip-${id}`} role="dialog" onVisibilityChange={setOpen}>
      {({ shape, close }) => <BrainConversation chat={chat} draft={draft} setDraft={setDraft} height={shape.frameHeight} close={close} trigger={trigger} />}
    </HoverPipCard>, document.body) : null}
  </>;
}
