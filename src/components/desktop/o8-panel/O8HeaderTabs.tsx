'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PageEdit } from 'iconoir-react';
import type { O8Tab } from './types';

// ── Inline SVG icons (Tauri webview doesn't reliably render React icon components) ──

function IconWorkspace({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
      <path d="M8 13h8" />
      <path d="M12 9v8" />
    </svg>
  );
}

function IconFiles({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconActivity({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

// Gauge — the Resources tab (per-session CPU/RAM Activity Monitor).
function IconGauge({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <path d="M4 15a8 8 0 0 1 16 0" />
      <path d="M12 15l4-4" />
      <circle cx="12" cy="15" r="1" />
    </svg>
  );
}

// Crosshair — "aim your agents here". The v1 wedge; a prominent main tab.
function IconTargets({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.9" strokeLinecap="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

// Icon colors track the palette text color (dark on paper, light on graphite).
const O8_ICON_ACTIVE = 'var(--t-text)';
const O8_ICON_INACTIVE = 'var(--t-text-muted)';

interface O8TabDef {
  id: O8Tab;
  label: string;
  icon: (color: string) => React.ReactNode;
}

function IconGlobe({ size = 15, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

// The state drawer's entries — one panel state at a time; Browser sits under
// Activity (Q ruling 2026-07-12: browser lives in the drawer, its page tabs
// live in the header rail).
const O8_TABS: O8TabDef[] = [
  { id: 'workspace', label: 'Workspace', icon: (c) => <IconWorkspace size={15} color={c} /> },
  { id: 'activity', label: 'Activity', icon: (c) => <IconActivity size={15} color={c} /> },
  { id: 'resources', label: 'Resources', icon: (c) => <IconGauge size={15} color={c} /> },
  { id: 'browser', label: 'Browser', icon: (c) => <IconGlobe size={15} color={c} /> },
  { id: 'targets', label: 'Targeting', icon: (c) => <IconTargets size={15} color={c} /> },
  // Iconoir PageEdit — operator-locked for the o8.md spec tab. Document
  // with a pencil reads as "the spec the agent is annotating."
  { id: 'spec', label: 'o8.md', icon: (c) => <PageEdit width={15} height={15} color={c} strokeWidth={2} /> },
];

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
}: {
  activeTab: O8Tab;
  onTabChange: (tab: O8Tab) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // prs + compare are contextual surfaces without their own drawer row — show
  // Activity as current while they're active so the trigger never looks empty.
  const visualActiveTab = activeTab === 'prs' || activeTab === 'compare' ? 'activity' : activeTab;
  const activeDef = O8_TABS.find((def) => def.id === visualActiveTab) ?? O8_TABS[0];

  // Portal-fixed drawer under the trigger (the top strip clips absolute
  // children) — same pattern as the composer chip popovers.
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth ?? 172;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
    setCoords({ top: rect.bottom + 6, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (anchorRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={anchorRef} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, ['WebkitAppRegion' as string]: 'no-drag' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Switch panel view"
        aria-label={`Panel view: ${activeDef.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-no-drag
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 9,
          paddingRight: 8,
          border: 'none',
          borderRadius: 7,
          background: open ? 'var(--t-input-bg)' : 'transparent',
          color: O8_ICON_ACTIVE,
          cursor: 'pointer',
          flexShrink: 0,
          marginTop: -3,
          transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          WebkitTapHighlightColor: 'transparent',
          ['WebkitAppRegion' as string]: 'no-drag',
        }}
        onMouseEnter={(event) => { if (!open) event.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(event) => { if (!open) event.currentTarget.style.background = open ? 'var(--t-input-bg)' : 'transparent'; }}
      >
        {/* Browser keeps its brand-orange globe when selected (Q ruling
            2026-07-12) — same accent the TitleBar globe button carries. */}
        {activeDef.icon(activeDef.id === 'browser' ? 'var(--t-brand-orange, #FF5A1F)' : O8_ICON_ACTIVE)}
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
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Panel views"
          style={{
            position: 'fixed',
            top: coords?.top ?? 0,
            left: coords?.left ?? 0,
            opacity: coords ? 1 : 0,
            minWidth: 172,
            background: 'var(--t-panel-solid, var(--t-panel))',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider, var(--t-divider-subtle))',
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(15, 23, 42, 0.22)',
            paddingTop: 4,
            paddingBottom: 4,
            zIndex: 1200,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {O8_TABS.map((def) => {
            const selected = def.id === visualActiveTab;
            return (
              <O8DrawerItem
                key={def.id}
                def={def}
                selected={selected}
                onClick={() => {
                  onTabChange(def.id);
                  setOpen(false);
                }}
              />
            );
          })}
        </div>,
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
  def: O8TabDef;
  selected: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const color = selected || hovered ? O8_ICON_ACTIVE : O8_ICON_INACTIVE;
  return (
    <button
      type="button"
      role="menuitem"
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
        fontWeight: 400,
        letterSpacing: '-0.005em',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{def.icon(color)}</span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}>{def.label}</span>
      {selected ? (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </button>
  );
}
