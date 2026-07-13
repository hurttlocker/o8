'use client';

/**
 * PanelHeaderStrip — header strip for the right (O8 / Review) panel column.
 * Hosts the O8 tab bar plus the browser and right-panel-morph controls.
 * Part of epic #1089.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { O8HeaderTabs } from '../o8-panel/O8HeaderTabs';
import type { O8Tab } from '../o8-panel/types';
import { ApprovalInboxBadge } from '../title-bar/ApprovalInboxBadge';
import { RightPanelMorphButton } from '../title-bar/RightPanelMorphButton';

/**
 * The header-rail universal opener (Q ruling 2026-07-12: "when you click
 * plus you should be able to open those things in the header row") — one [+]
 * next to the page tabs that opens a new browser page OR any right-panel
 * utility surface. Utility picks route through onO8TabChange (the panel's
 * auto-add effect handles strip membership); "New page" dispatches to the
 * browser pane, which owns tab state.
 */
const OPENER_ITEMS: Array<{ id: O8Tab | 'new-page'; label: string; icon: React.ReactNode }> = [
  {
    id: 'new-page',
    label: 'New page',
    icon: (
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  {
    id: 'files',
    label: 'Files',
    icon: (
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    ),
  },
  {
    id: 'side-chat',
    label: 'Side chat',
    icon: (
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'review',
    label: 'Review',
    icon: (
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="m9 14 2 2 4-4" />
      </svg>
    ),
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: (
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
];

function HeaderOpener({ onPick }: { onPick: (id: O8Tab | 'new-page') => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth ?? 156;
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
    <div ref={anchorRef} data-no-drag style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, ['WebkitAppRegion' as string]: 'no-drag' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Open…"
        aria-label="Open a page or panel surface"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, border: 'none', borderRadius: 6,
          background: open ? 'var(--t-input-bg)' : 'transparent',
          color: 'var(--t-text-muted)', cursor: 'pointer', padding: 0,
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = open ? 'var(--t-input-bg)' : 'transparent'; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block' }}>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Open"
          style={{
            position: 'fixed',
            top: coords?.top ?? 0,
            left: coords?.left ?? 0,
            opacity: coords ? 1 : 0,
            minWidth: 156,
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
          {OPENER_ITEMS.map((item, index) => (
            <div key={item.id} style={{ display: 'contents' }}>
              {index === 1 ? (
                <div aria-hidden style={{ height: 1, background: 'var(--t-divider-subtle)', marginTop: 4, marginBottom: 4, marginLeft: 8, marginRight: 8 }} />
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => { onPick(item.id); setOpen(false); }}
                onMouseEnter={() => setHoveredId(item.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  display: 'flex', alignItems: 'center', width: '100%', gap: 9,
                  paddingTop: 6, paddingBottom: 6, paddingLeft: 11, paddingRight: 11,
                  borderWidth: 0,
                  background: hoveredId === item.id ? 'var(--t-hover)' : 'transparent',
                  color: hoveredId === item.id ? 'var(--t-text)' : 'var(--t-text-secondary)',
                  cursor: 'pointer', textAlign: 'left',
                  fontSize: 12.5, fontWeight: 400, letterSpacing: '-0.005em', fontFamily: 'inherit',
                }}
              >
                <span style={{ display: 'inline-flex', flexShrink: 0 }}>{item.icon}</span>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}>{item.label}</span>
              </button>
            </div>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

interface PanelHeaderStripProps {
  o8PanelVisible?: boolean;
  workspacePanelVisible?: boolean;
  onToggleO8Panel?: () => void;
  o8ActiveTab?: O8Tab;
  onO8TabChange?: (tab: O8Tab) => void;
  approvalCount?: number;
  onOpenInbox?: () => void;
  /** Portal target for the browser's page tabs + URL well (Cursor header
   *  borrow, Q 2026-07-12): the browser's whole top chrome renders HERE in
   *  the strip's flex center, walled off from the state drawer by a hairline
   *  divider. The standalone globe button is retired — the drawer's Browser
   *  entry (orange globe when active) is the surface's one handle. */
  browserTabsSlotRef?: (node: HTMLElement | null) => void;
  showBrowserTabs?: boolean;
}

export function PanelHeaderStrip({
  o8PanelVisible = false,
  workspacePanelVisible = false,
  onToggleO8Panel,
  o8ActiveTab = 'workspace',
  onO8TabChange,
  approvalCount = 0,
  onOpenInbox,
  browserTabsSlotRef,
  showBrowserTabs = false,
}: PanelHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      left={
        onO8TabChange ? (
          <O8HeaderTabs activeTab={o8ActiveTab} onTabChange={onO8TabChange} />
        ) : null
      }
      center={
        showBrowserTabs && browserTabsSlotRef ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1, marginLeft: 4 }}>
            {/* The wall — separates the state drawer from the browser chrome. */}
            <div aria-hidden style={{ width: 1, height: 16, background: 'var(--t-divider)', flexShrink: 0, marginTop: -3 }} />
            <div
              ref={browserTabsSlotRef}
              data-no-drag
              style={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flexShrink: 1, overflow: 'hidden', marginTop: -3, ['WebkitAppRegion' as string]: 'no-drag' }}
            />
            {/* The universal opener — new page or any utility surface. */}
            <div style={{ marginTop: -3 }}>
              <HeaderOpener
                onPick={(id) => {
                  if (id === 'new-page') {
                    onO8TabChange?.('browser');
                    window.dispatchEvent(new CustomEvent('o8:browser-new-page'));
                    return;
                  }
                  onO8TabChange?.(id);
                }}
              />
            </div>
          </div>
        ) : null
      }
      right={
        <>
          {onOpenInbox ? (
            <ApprovalInboxBadge count={approvalCount} onClick={onOpenInbox} />
          ) : null}
          <RightPanelMorphButton
            workspacePanelVisible={workspacePanelVisible}
            o8PanelVisible={o8PanelVisible}
            onToggleO8Panel={onToggleO8Panel}
          />
        </>
      }
    />
  );
}
