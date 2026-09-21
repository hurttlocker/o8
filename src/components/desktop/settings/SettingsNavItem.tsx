'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@/lib/tauri/bridge';
import { RAMS_ACCENT, TabButton, type SettingsTab } from './shared';
import { renderedSettingsSections, settingsSectionPreview } from './settings-sections';

export function SettingsNavItem({ tab, label, icon, active, openTab, onOpen, onNavigate }: {
  tab: SettingsTab;
  label: string;
  icon: ReactNode;
  active: boolean;
  openTab: SettingsTab | null;
  onOpen: (tab: SettingsTab | null) => void;
  onNavigate: (tab: SettingsTab, section?: string) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusMenu = useRef(false);
  const [portalHost, setPortalHost] = useState<Element | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [sections, setSections] = useState(() => settingsSectionPreview(tab, isTauri()));
  const id = useId();
  const open = openTab === tab;
  const preview = settingsSectionPreview(tab, isTauri());

  function clearTimer() { if (timer.current) clearTimeout(timer.current); }
  function show(focus = false) {
    clearTimer();
    const content = document.querySelector('[data-settings-content]');
    const rendered = active && content ? renderedSettingsSections(content) : [];
    const next = rendered.length ? rendered : preview;
    if (!next.length) return;
    setPortalHost(wrapper.current!.closest('[data-settings-shell]') ?? document.body);
    const rect = wrapper.current!.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 24);
    setPosition({ left: Math.max(12, Math.min(rect.right + 6, window.innerWidth - width - 12)), top: Math.max(12, Math.min(rect.top, window.innerHeight - Math.min(380, next.length * 36 + 48) - 12)) });
    setSections(next);
    focusMenu.current = focus;
    onOpen(tab);
    if (open && focus) panel.current?.querySelector('button')?.focus();
  }
  function closeSoon() {
    clearTimer();
    if (!open) return;
    timer.current = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement)) onOpen(null);
    }, 160);
  }

  useEffect(() => { if (!open) clearTimer(); return () => clearTimer(); }, [open]);
  useEffect(() => {
    if (!open) return;
    if (focusMenu.current) { panel.current?.querySelector('button')?.focus(); focusMenu.current = false; }
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) onOpen(null);
    };
    const reposition = (event: Event) => { if (!panel.current?.contains(event.target as Node)) onOpen(null); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onOpen(null);
      trigger.current?.focus();
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, onOpen]);

  return (
    <div
      ref={wrapper}
      style={{ display: 'grid', gridTemplateColumns: preview.length ? 'minmax(0, 1fr) 24px' : 'minmax(0, 1fr)', alignItems: 'center' }}
      onMouseEnter={() => { clearTimer(); timer.current = setTimeout(() => show(), 180); }}
      onMouseLeave={closeSoon}
      onFocus={(event) => { if (!wrapper.current?.contains(event.relatedTarget as Node) && !panel.current?.contains(event.relatedTarget as Node)) show(); }}
      onBlur={(event) => { if (!wrapper.current?.contains(event.relatedTarget as Node) && !panel.current?.contains(event.relatedTarget as Node)) { clearTimer(); onOpen(null); } }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); onOpen(null); trigger.current?.focus(); }
        if (event.key === 'ArrowRight' && !panel.current?.contains(event.target as Node)) { event.preventDefault(); show(true); }
      }}
    >
      <TabButton label={label} icon={icon} active={active} onClick={() => { clearTimer(); onOpen(null); onNavigate(tab); }} />
      {preview.length ? (
        <button ref={trigger} type="button" aria-label={`${label} sections`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => show(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 32, padding: 0, border: 0, borderRadius: 6, background: open ? 'var(--t-hover)' : 'transparent', color: active ? RAMS_ACCENT : 'var(--t-text-secondary)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>
      ) : null}
      {open && portalHost && createPortal(
        <div ref={panel} id={id} data-o8-settings-portal data-o8-settings-escape-scope role="dialog" aria-label={`${label} sections`} onMouseEnter={clearTimer} onMouseLeave={closeSoon} style={{ position: 'fixed', ...position, zIndex: 10000, width: 260, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(380px, calc(100vh - 24px))', overflowY: 'auto', padding: 8, boxSizing: 'border-box', borderRadius: 12, border: '1px solid var(--t-panel-border)', background: 'var(--t-bg)', boxShadow: '0 8px 28px rgba(0, 0, 0, 0.14)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
          <div style={{ padding: 8, fontSize: 12, fontWeight: 600 }}>{label} sections</div>
          {sections.map((section) => (
            <button key={section} type="button" onClick={() => { onOpen(null); onNavigate(tab, section); }} style={{ display: 'block', width: '100%', textAlign: 'left', paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, border: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text)', fontSize: 12.5, fontWeight: 300 }} onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}>{section}</button>
          ))}
        </div>, portalHost,
      )}
    </div>
  );
}
