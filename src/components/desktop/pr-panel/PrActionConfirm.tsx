'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { prActionButton, prActionPopover } from './PrActionMenu';

export function PrActionConfirm({ title, children, label, disabled, busy, onConfirm, onCancel }: { title: string; children: ReactNode; label: string; disabled?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { root.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  return <div ref={root} role="dialog" aria-modal="false" aria-label={title} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key === 'Tab') { const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if ((event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1)) { event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus(); } }
  }} style={{ ...prActionPopover, top: 36, right: 0, width: 300, padding: 14, display: 'grid', gap: 12, fontSize: 12 }}>
    <strong style={{ fontWeight: 500 }}>{title}</strong>
    <div style={{ color: 'var(--t-text-muted)', lineHeight: 1.5 }}>{children}</div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" onClick={onCancel} style={prActionButton}>Cancel</button><button type="button" disabled={disabled || busy} onClick={onConfirm} style={{ ...prActionButton, background: 'var(--t-accent)', borderColor: 'var(--t-accent-border)', color: 'var(--t-success-contrast, #fff)', opacity: disabled || busy ? 0.45 : 1 }}>{busy ? 'Working…' : label}</button></div>
  </div>;
}
