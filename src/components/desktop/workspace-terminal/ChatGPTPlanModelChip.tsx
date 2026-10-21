'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { FloatingSurface } from '../FloatingSurface';
import { ComposerPopover } from '../thoughts/chat-panel/ComposerPopover';
import type { PlanStatus } from '@/lib/chatgpt-plan/types';

export function ChatGPTPlanModelChip({ models, modelId, busy, active, onChange, onOpenConnection }: {
  models: PlanStatus['models'];
  modelId: string;
  busy: boolean;
  active: boolean;
  onChange: (id: string) => void;
  onOpenConnection: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const model = models.find(value => value.id === modelId);
  const close = () => { setOpen(false); anchorRef.current?.focus(); };

  return <>
    <button ref={anchorRef} type="button" aria-label="ChatGPT plan model" value={modelId} aria-haspopup="menu" aria-expanded={open}
      disabled={busy || models.length === 0} onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}
      title="Uses your ChatGPT plan limits. This conversation clears when you close the pane or change accounts."
      style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: '100%', gap: 6, height: 32, paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 8, borderWidth: 0, borderRadius: 8, background: open ? 'var(--t-hover)' : 'transparent', color: 'var(--t-text-secondary)', cursor: busy ? 'default' : 'pointer', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300 }}>
      <Image src="/logos/codex.webp" alt="" width={14} height={14} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{model?.label ?? 'ChatGPT'}</span>
      <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" style={{ flexShrink: 0 }}><path d="m5 8 5 5 5-5" /></svg>
    </button>
    <ComposerPopover anchorRef={anchorRef} align="start" open={open && active && !busy} onClose={close}
      onOpenReady={() => (menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus()}>
      <FloatingSurface ref={menuRef} role="menu" aria-label="ChatGPT models" style={{ width: 'min(292px, calc(100vw - 24px))', borderRadius: 16 }}
        contentStyle={{ paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8 }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); close(); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []);
          const current = options.indexOf(document.activeElement as HTMLButtonElement);
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options[index]?.focus();
        }}>
        <div style={{ paddingTop: 4, paddingRight: 8, paddingBottom: 8, paddingLeft: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>ChatGPT · Your plan</div>
        <div style={{ maxHeight: 'min(280px, 45vh)', overflowY: 'auto', scrollbarWidth: 'none' }}>
          {models.map(value => <button key={value.id} type="button" role="menuitemradio" aria-checked={value.id === modelId}
            onClick={() => { onChange(value.id); close(); }}
            style={{ display: 'flex', alignItems: 'center', width: '100%', minHeight: 36, gap: 8, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, borderWidth: 0, borderRadius: 8, background: value.id === modelId ? 'var(--t-hover)' : 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 13, fontWeight: 300, textAlign: 'left', cursor: 'pointer' }}>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{value.label}</span>
            {value.id === modelId ? <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--t-accent)" strokeWidth="1.5" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg> : null}
          </button>)}
        </div>
        <div style={{ height: 1, marginTop: 6, marginBottom: 6, background: 'var(--t-divider-subtle)' }} />
        <button type="button" role="menuitem" onClick={() => { close(); onOpenConnection(); }}
          style={{ width: '100%', minHeight: 32, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, borderWidth: 0, borderRadius: 8, background: 'transparent', color: 'var(--t-text-secondary)', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 300 }}>Manage connection</button>
      </FloatingSurface>
    </ComposerPopover>
  </>;
}
