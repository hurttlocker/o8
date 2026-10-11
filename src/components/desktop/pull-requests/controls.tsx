'use client';

import { useId, useRef, useState, type CSSProperties, type ReactNode, type KeyboardEvent } from 'react';
import { ComposerPopover } from '../thoughts/chat-panel/ComposerPopover';
import { FloatingSurface } from '../FloatingSurface';
import { Check, ChevronDown, SlidersHorizontal, X } from '../lucide-shims';

export const PR_CONTROL: CSSProperties = {
  height: 36, minHeight: 36, boxSizing: 'border-box', border: '1px solid var(--t-border)', borderRadius: 10,
  background: 'var(--t-input-bg)', color: 'var(--t-text)', font: 'inherit', fontSize: 13,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, paddingTop: 0, paddingRight: 11, paddingBottom: 0, paddingLeft: 11, flexShrink: 0,
};
const popup: CSSProperties = {
  borderRadius: 14, minWidth: 200, fontFamily: 'var(--font-sans-system)',
};

function useMenuVisibility(active: boolean) {
  const [visibility, setVisibility] = useState({ active, open: false });
  if (visibility.active !== active) setVisibility({ active, open: false });
  return { open: visibility.active === active && visibility.open, setOpen: (open: boolean) => setVisibility({ active, open }) };
}

export function PullRequestPicker<T extends string>({ label, value, options, onChange, icon, disabled, active = true, style }: {
  label: string; value: T; options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void; icon?: ReactNode; disabled?: boolean; active?: boolean; style?: CSSProperties;
}) {
  const { open, setOpen } = useMenuVisibility(active);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const chosen = options.find((option) => option.value === value);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={active && open} aria-controls={active && open ? id : undefined} disabled={disabled} onClick={() => setOpen(!open)} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
    }} style={{ ...PR_CONTROL, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, ...style }}>
      {icon}<span>{chosen?.label}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    <ComposerPopover anchorRef={trigger} open={active && open && !disabled} onClose={() => setOpen(false)} onOpenReady={() => menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()}>
      <FloatingSurface ref={menu} id={id} role="menu" aria-label={label} data-pr-menu="true" onKeyDown={keyDown} style={popup} contentStyle={{ padding: 6 }}>
        {options.map((option) => <button key={option.value} type="button" role="menuitemradio" aria-checked={option.value === value} onClick={() => { onChange(option.value); close(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 36, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, border: 0, borderRadius: 8, background: option.value === value ? 'var(--t-hover)' : 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer', textAlign: 'left' }}>
          {option.icon}<span style={{ flex: 1 }}>{option.label}</span>{option.value === value ? <Check size={14} aria-hidden="true" /> : null}
        </button>)}
      </FloatingSurface>
    </ComposerPopover>
  </>;
}

export interface PullRequestFiltersValue { author: string; label: string; base: string; draft: string; checks: string }
export const EMPTY_PR_FILTERS: PullRequestFiltersValue = { author: '', label: '', base: '', draft: '', checks: '' };

export function PullRequestFilters({ value, onChange, authors, labels, bases, active }: {
  value: PullRequestFiltersValue; onChange: (value: PullRequestFiltersValue) => void;
  authors: string[]; labels: string[]; bases: string[]; active: boolean;
}) {
  const { open, setOpen } = useMenuVisibility(active);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const count = Object.values(value).filter(Boolean).length;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const fields = [
    { key: 'author' as const, label: 'Author', options: authors.map((author) => [author, author]) },
    { key: 'label' as const, label: 'Label', options: labels.map((label) => [label, label]) },
    { key: 'base' as const, label: 'Base branch', options: bases.map((base) => [base, base]) },
    { key: 'draft' as const, label: 'Readiness', options: [['ready', 'Ready for review'], ['draft', 'Draft']] },
    { key: 'checks' as const, label: 'Checks', options: [['success', 'Passing'], ['failure', 'Failing'], ['pending', 'Pending'], ['unknown', 'Not available']] },
  ];
  return <>
    <button ref={trigger} type="button" aria-label="Filter pull requests" aria-haspopup="dialog" aria-expanded={active && open} aria-controls={active && open ? id : undefined} onClick={() => setOpen(!open)} style={{ ...PR_CONTROL, cursor: 'pointer', borderColor: count ? 'var(--t-accent)' : 'var(--t-border)' }}><SlidersHorizontal size={15} aria-hidden="true" /><span>Filters</span>{count ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--t-accent)' }}>{count}</span> : null}</button>
    <ComposerPopover anchorRef={trigger} open={active && open} onClose={() => setOpen(false)} onOpenReady={() => panel.current?.querySelector('select')?.focus()}>
      <FloatingSurface ref={panel} id={id} role="dialog" aria-label="Pull request filters" data-pr-menu="true" style={{ ...popup, width: 280 }} contentStyle={{ maxHeight: 'min(520px, 80vh)', overflowY: 'auto', scrollbarWidth: 'none', padding: 14 }} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key !== 'Tab') return;
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('select, button') ?? []);
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}><span style={{ fontSize: 14, fontWeight: 600 }}>Filters</span><button type="button" aria-label="Close filters" onClick={close} style={{ ...PR_CONTROL, width: 32, height: 32, minHeight: 32, padding: 0, border: 0 }}><X size={14} /></button></div>
        {fields.map((field) => <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12, fontSize: 12, color: 'var(--t-text-secondary)' }}>{field.label}
          <select aria-label={field.label} value={value[field.key]} onChange={(event) => onChange({ ...value, [field.key]: event.target.value })} style={{ ...PR_CONTROL, width: '100%', justifyContent: 'flex-start' }}><option value="">Any</option>{field.options.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        </label>)}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}><button type="button" onClick={() => onChange(EMPTY_PR_FILTERS)} style={{ ...PR_CONTROL, cursor: 'pointer' }}>Reset filters</button><button type="button" onClick={close} style={{ ...PR_CONTROL, cursor: 'pointer' }}>Done</button></div>
      </FloatingSurface>
    </ComposerPopover>
  </>;
}
