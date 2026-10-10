'use client';

import { FloatingSurface } from '../FloatingSurface';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { canonicalPanelTab, type O8Tab } from './types';
import { PANEL_TOOLS, type PanelToolDefinition } from './panel-tools';

const O8_ICON_ACTIVE = 'var(--t-text)';
const O8_ICON_INACTIVE = 'var(--t-text-muted)';

/**
 * O8HeaderTabs — ONE current-state pill + a dropdown drawer (Cursor browser
 * borrow, Q ruling 2026-07-12): the panel shows one state at a time, so the
 * header shows only that state's icon + label and opens a small drawer to
 * switch. The old four-pill row filled the top strip and crowded the browser
 * chrome; this frees the header for the surface's own controls.
 */
export function O8HeaderTabs({
  activeTab,
  onTabChange,
  ariaLabelPrefix = 'Panel view',
  opener = false,
  more = false,
  onNewPage,
}: {
  activeTab: O8Tab;
  onTabChange: (tab: O8Tab) => void;
  ariaLabelPrefix?: string;
  opener?: boolean;
  more?: boolean;
  onNewPage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // prs + compare are contextual surfaces without their own drawer row — show
  // Activity as current while they're active so the trigger never looks empty.
  const visualActiveTab = activeTab === 'prs' || activeTab === 'compare' ? 'activity' : canonicalPanelTab(activeTab);
  const activeDef = PANEL_TOOLS.find((def) => def.id === visualActiveTab) ?? PANEL_TOOLS[0];

  // Portal-fixed drawer under the trigger (the top strip clips absolute
  // children) — same pattern as the composer chip popovers.
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth ?? 340;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
    const menuHeight = menuRef.current?.offsetHeight ?? 240;
    const below = rect.bottom + 6;
    const top = below + menuHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, rect.top - menuHeight - 6);
    setCoords({ top, left });
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (anchorRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { setOpen(false); triggerRef.current?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={anchorRef} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, ['WebkitAppRegion' as string]: 'no-drag' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}
        title={opener ? more ? 'More panel views' : 'Open a panel' : 'Switch panel view'}
        aria-label={opener ? more ? 'More panel views' : 'Open a panel' : `${ariaLabelPrefix}: ${activeDef.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-no-drag
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          width: opener ? 28 : undefined,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: opener ? 0 : 9,
          paddingRight: opener ? 0 : 8,
          justifyContent: 'center',
          border: 'none',
          borderRadius: 7,
          background: open ? 'var(--t-input-bg)' : 'transparent',
          color: O8_ICON_ACTIVE,
          cursor: 'pointer',
          flexShrink: 0,
          marginTop: opener ? 0 : -3,
          transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          WebkitTapHighlightColor: 'transparent',
          ['WebkitAppRegion' as string]: 'no-drag',
        }}
        onMouseEnter={(event) => { if (!open) event.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(event) => { if (!open) event.currentTarget.style.background = open ? 'var(--t-input-bg)' : 'transparent'; }}
      >
        {opener ? more ? <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg> : <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg> : <>
        {/* Browser keeps its brand-orange globe when selected (Q ruling
            2026-07-12) — same accent the TitleBar globe button carries. */}
        <span style={{ color: activeDef.id === 'browser' ? 'var(--t-brand-orange)' : O8_ICON_ACTIVE }}>{activeDef.icon({ size: 15 })}</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
            fontFamily: 'var(--font-sans-system)',
            whiteSpace: 'nowrap',
          }}
        >
          {activeDef.label}
        </span>
        <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ opacity: 0.6, flexShrink: 0 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
        </>}
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <FloatingSurface
          ref={menuRef}
          role="menu"
          aria-label="Panel views"
          onKeyDown={onMenuKeyDown}
          contentStyle={{ paddingTop: 4, paddingBottom: 4, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', scrollbarWidth: 'none' }}
          style={{
            position: 'fixed',
            top: coords?.top ?? 0,
            left: coords?.left ?? 0,
            opacity: coords ? 1 : 0,
            width: 340,
            maxWidth: 'calc(100vw - 16px)',
            zIndex: 1200,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {onNewPage ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => { onNewPage(); setOpen(false); triggerRef.current?.focus(); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', border: 0, background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 12.5, paddingTop: 7, paddingRight: 11, paddingBottom: 7, paddingLeft: 11, cursor: 'pointer', textAlign: 'left' }}>{PANEL_TOOLS[1].icon({ size: 15 })}New browser page</button> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {['Tools', 'More'].map((name) => (
              <div key={name} style={{ minWidth: 0 }}>
                {(name === 'Tools' ? ['Tools'] : ['More', 'Diagnostics']).map((section) => (
                <div key={section}>
                <div style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)', paddingTop: 5, paddingBottom: 3, paddingLeft: 11, paddingRight: 11 }}>{section}</div>
                {PANEL_TOOLS.filter((tool) => tool.group === section).map((def) => (
                  <O8DrawerItem
                    key={def.id}
                    def={def}
                    selected={def.id === visualActiveTab}
                    onClick={() => {
                      onTabChange(def.id);
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                  />
                ))}
                </div>))}
              </div>
            ))}
          </div>
        </FloatingSurface>,
        document.body,
      ) : null}
    </div>
  );
}

function O8DrawerItem({
  def,
  selected,
  onClick,
}: {
  def: PanelToolDefinition;
  selected: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const color = selected || hovered ? O8_ICON_ACTIVE : O8_ICON_INACTIVE;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        gap: 9,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 11,
        paddingRight: 11,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color,
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 12.5,
        fontWeight: 300,
        letterSpacing: '-0.005em',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{def.icon({ size: 15 })}</span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}>{def.label}</span>
      {selected ? (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </button>
  );
}
