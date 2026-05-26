'use client';

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

function IconInbox({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
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

// Codex-style header tabs — the active tab expands to an icon + label pill;
// the rest stay icon-only so the row fits the panel width. No dividers.
const O8_TABS: O8TabDef[] = [
  { id: 'workspace', label: 'Workspace', icon: (c) => <IconWorkspace size={15} color={c} /> },
  { id: 'activity', label: 'Activity', icon: (c) => <IconActivity size={15} color={c} /> },
  { id: 'inbox', label: 'Inbox', icon: (c) => <IconInbox size={15} color={c} /> },
  // Iconoir PageEdit — operator-locked for the o8.md spec tab. Document
  // with a pencil reads as "the spec the agent is annotating."
  { id: 'spec', label: 'o8.md', icon: (c) => <PageEdit width={15} height={15} color={c} strokeWidth={2} /> },
];

function O8TabPill({
  def,
  active,
  onClick,
}: {
  def: O8TabDef;
  active: boolean;
  onClick: () => void;
}) {
  const color = active ? O8_ICON_ACTIVE : O8_ICON_INACTIVE;
  return (
    <button
      type="button"
      role="tab"
      onClick={onClick}
      title={def.label}
      aria-label={def.label}
      aria-selected={active}
      data-no-drag
      style={{
        // Matched to HeaderIconPill — 26 tall, 7px radius, flat hover.
        // Active = filled bg (panel chrome surface for the selected tab),
        // inactive = transparent → var(--t-hover) on hover.
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: active ? 6 : 0,
        height: 26,
        minWidth: 26,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: active ? 9 : 7,
        paddingRight: active ? 11 : 7,
        border: 'none',
        borderRadius: 7,
        background: active ? 'var(--t-input-bg)' : 'transparent',
        color,
        cursor: 'pointer',
        flexShrink: 0,
        marginTop: -3,
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(event) => {
        if (!active) {
          event.currentTarget.style.background = 'var(--t-hover)';
        }
      }}
      onMouseLeave={(event) => {
        if (!active) {
          event.currentTarget.style.background = 'transparent';
        }
      }}
    >
      {def.icon(color)}
      {active ? (
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            fontFamily: 'var(--font-sans-system)',
            whiteSpace: 'nowrap',
          }}
        >
          {def.label}
        </span>
      ) : null}
    </button>
  );
}

export function O8HeaderTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: O8Tab;
  onTabChange: (tab: O8Tab) => void;
}) {
  const visualActiveTab = activeTab === 'prs' ? 'activity' : activeTab;

  return (
    <div
      role="tablist"
      aria-label="O8 panel tabs"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        height: 32,
        flexShrink: 0,
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      {O8_TABS.map((def) => (
        <O8TabPill
          key={def.id}
          def={def}
          active={visualActiveTab === def.id}
          onClick={() => onTabChange(def.id)}
        />
      ))}
    </div>
  );
}
