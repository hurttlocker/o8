'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ControlSlider, Delivery } from 'iconoir-react';
import { FloatingSurface } from '../FloatingSurface';
import { RailActionButton } from './RailActionButton';

export function RailMoreMenu({ buttonStyle, selected, onProjects, onCustomize }: {
  buttonStyle: CSSProperties;
  selected: 'projects' | 'customize' | null;
  onProjects: () => void;
  onCustomize: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    if (!menuRef.current?.contains(document.activeElement)) menuRef.current?.querySelector('button')?.focus();
    const outside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const reposition = () => setAnchor(triggerRef.current?.getBoundingClientRect() ?? null);
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', reposition);
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('resize', reposition); };
  }, [open]);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  return <>
    <RailActionButton ref={triggerRef} type="button" aria-label="More navigation" tooltipLabel="Projects and Customize" aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined} aria-current={selected ? 'page' : undefined}
      onClick={() => { setAnchor(triggerRef.current?.getBoundingClientRect() ?? null); setOpen(!open); }}
      style={{ ...buttonStyle, flexShrink: 0, background: open || selected ? 'var(--t-hover)' : 'transparent' }}>
      <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
    </RailActionButton>
    {open && anchor ? createPortal(<FloatingSurface ref={menuRef} id={id} role="menu" aria-label="More destinations" contentStyle={{ padding: 8 }}
      onKeyDown={event => {
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
          : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
        if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') close();
      }}
      style={{ position: 'fixed', left: Math.max(12, Math.min(anchor.right + 10, window.innerWidth - 198)),
        top: Math.max(12, Math.min(anchor.top, window.innerHeight - 100)), width: 186, zIndex: 210 }}>
      {[{ id: 'projects', label: 'Projects', icon: <Delivery width={16} height={16} strokeWidth={1.7} />, onClick: onProjects },
        { id: 'customize', label: 'Customize', icon: <ControlSlider width={16} height={16} strokeWidth={1.7} />, onClick: onCustomize }].map(item =>
        <button key={item.id} type="button" role="menuitem" aria-label={item.label}
          aria-current={selected === item.id ? 'page' : undefined} onClick={() => { close(); item.onClick(); }}
          onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}
          onFocus={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
          onBlur={event => { event.currentTarget.style.background = 'transparent'; }}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 36, paddingTop: 6,
            paddingRight: 10, paddingBottom: 6, paddingLeft: 10, borderWidth: 0, borderRadius: 6,
            color: 'inherit', background: 'transparent', font: 'inherit', fontSize: 12, fontWeight: 300, cursor: 'pointer', textAlign: 'left' }}>
          {item.icon}{item.label}
        </button>)}
    </FloatingSurface>, document.body) : null}
  </>;
}
