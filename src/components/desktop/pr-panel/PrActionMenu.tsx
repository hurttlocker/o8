'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface PrMenuItem { label: string; onSelect?: () => void; disabled?: boolean; danger?: boolean; divider?: boolean }

export function PrActionMenu({ label, children, items, disabled, primary }: { label: string; children: ReactNode; items: PrMenuItem[]; disabled?: boolean; primary?: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => { if (open) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div ref={root} style={{ position: 'relative', minWidth: 0 }}>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); } }} style={{ ...prActionButton, background: primary ? 'var(--t-accent)' : 'var(--t-hover)', borderColor: primary ? 'var(--t-accent-border)' : 'var(--t-border)', color: primary ? 'var(--t-success-contrast, #fff)' : 'var(--t-text)', opacity: disabled ? 0.45 : 1 }}>
      {children}
    </button>
    {open ? <div ref={menu} id={id} role="menu" aria-label={label} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') { close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }} style={{ ...prActionPopover, right: 0, top: 37, width: 236, padding: 5 }}>
      {items.map((item, index) => item.divider ? <div role="separator" key={index} style={{ height: 1, marginTop: 5, marginRight: 6, marginBottom: 5, marginLeft: 6, background: 'var(--t-divider-subtle)' }} /> : <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { close(true); item.onSelect?.(); }} onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }} style={{ display: 'flex', width: '100%', textAlign: 'left', minHeight: 32, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10, border: 0, borderRadius: 6, fontFamily: 'inherit', fontSize: 12, color: item.danger ? 'var(--t-danger)' : 'var(--t-text)', background: 'transparent', cursor: item.disabled ? 'default' : 'pointer', opacity: item.disabled ? 0.45 : 1 }}>{item.label}</button>)}
    </div> : null}
  </div>;
}

export const prActionButton: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 30, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-hover)', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer' };
export const prActionPopover: CSSProperties = { position: 'absolute', zIndex: 15, maxWidth: 'calc(100vw - 32px)', border: '1px solid var(--t-border)', borderRadius: 12, background: 'var(--t-popover-surface)', backdropFilter: 'blur(22px) saturate(1.2)', WebkitBackdropFilter: 'blur(22px) saturate(1.2)', color: 'var(--t-text)', boxShadow: 'var(--t-panel-shadow)' };
