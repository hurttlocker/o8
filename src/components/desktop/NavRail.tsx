'use client';

/**
 * NavRail — Slim fixed-width left navigation rail.
 *
 * Compact icon-only rail with Phosphor duotone icons in neomorphic containers.
 * Fixed at 44px — no hover-expand.
 */

import { useState, useEffect, useRef, cloneElement, isValidElement, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@/lib/tauri/bridge';
import {
  UsersThree,
  Terminal,
  GearSix,
  Brain,
  ChartBar,
  Bell,
  Lightbulb,
  Plugs,
  ShieldCheck,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

// ── Types ──

export type NavSection =
  | 'agents'
  | 'approvals'
  | 'terminal'
  | 'memory'
  | 'analytics'
  | 'settings';

interface NavRailProps {
  activeSection: NavSection;
  onSectionChange: (section: NavSection) => void;
  alertCount?: number;
  approvalCount?: number;
  onAlertClick?: () => void;
  alertTray?: ReactElement<{ desktopAnchorEl?: HTMLElement | null }> | null;
  thoughtsOpen?: boolean;
  onThoughtsToggle?: () => void;
  onPortPreview?: (port: number, url: string, repo?: string) => void;
}

interface NavItem {
  id: NavSection;
  label: string;
  icon: PhosphorIcon;
}

// ── Constants ──

const RAIL_WIDTH = 44;

const NAV_ITEMS: NavItem[] = [
  { id: 'agents', label: 'Agents', icon: UsersThree },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'analytics', label: 'Analytics', icon: ChartBar },
];

const BRAND_MARK_BLUE = '#2563eb';

// ── Neomorphic icon container styles ──
// Tauri uses macOS vibrancy so semi-transparent white works beautifully.
// Browser has no vibrancy — dark backgrounds need dark neo containers.

const NEO_LIGHT = {
  inactive: {
    background: 'rgba(255, 255, 255, 0.55)',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
  },
  active: {
    background: 'rgba(255, 255, 255, 0.95)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
  },
  hover: {
    background: 'rgba(255, 255, 255, 0.8)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
  },
};

const NEO_DARK = {
  inactive: {
    background: 'rgba(255, 255, 255, 0.08)',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
  },
  active: {
    background: 'rgba(255, 255, 255, 0.16)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
  },
  hover: {
    background: 'rgba(255, 255, 255, 0.12)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
  },
};

function getNeoPreset(useTauri: boolean) {
  return useTauri ? NEO_LIGHT : NEO_DARK;
}

function neoIconStyle(active: boolean, useTauri = true): React.CSSProperties {
  const neo = getNeoPreset(useTauri);
  const preset = active ? neo.active : neo.inactive;
  return {
    width: 32,
    height: 32,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: preset.background,
    boxShadow: preset.boxShadow,
    transition: 'box-shadow 150ms ease, background 150ms ease',
  };
}

function applyNeoHover(el: HTMLElement, active: boolean, useTauri = true) {
  if (!active) {
    const neo = getNeoPreset(useTauri);
    el.style.background = neo.hover.background;
    el.style.boxShadow = neo.hover.boxShadow;
  }
}

function resetNeoHover(el: HTMLElement, active: boolean, useTauri = true) {
  if (!active) {
    const neo = getNeoPreset(useTauri);
    el.style.background = neo.inactive.background;
    el.style.boxShadow = neo.inactive.boxShadow;
  }
}

// ── Logo ──

function CortexLogo() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2px 0',
    }}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <circle cx="7" cy="12" r="4.25" stroke={BRAND_MARK_BLUE} strokeWidth="2.25" />
        <circle cx="16.5" cy="8" r="3.25" stroke={BRAND_MARK_BLUE} strokeWidth="2.25" />
        <circle cx="16.5" cy="16" r="3.25" stroke={BRAND_MARK_BLUE} strokeWidth="2.25" />
      </svg>
    </div>
  );
}

// ── Nav Item Button ──

function NavButton({
  item,
  active,
  onClick,
  badge,
  onPrefetch,
  useTauri = true,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
  badge?: number;
  onPrefetch?: () => void;
  useTauri?: boolean;
}) {
  const IconComponent = item.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        padding: '4px 0',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        const neo = e.currentTarget.querySelector('[data-neo]') as HTMLElement;
        if (neo) applyNeoHover(neo, active, useTauri);
        onPrefetch?.();
      }}
      onMouseLeave={(e) => {
        const neo = e.currentTarget.querySelector('[data-neo]') as HTMLElement;
        if (neo) resetNeoHover(neo, active, useTauri);
      }}
    >
      <div data-neo="" style={neoIconStyle(active, useTauri)}>
        <IconComponent
          size={18}
          weight={active ? 'duotone' : 'regular'}
          color={active ? 'var(--t-text)' : 'var(--t-text-secondary)'}
        />
      </div>
      {badge != null && badge > 0 ? (
        <div style={{
          position: 'absolute',
          top: 2,
          right: 2,
          width: 14,
          height: 14,
          borderRadius: 7,
          background: '#ef4444',
          color: '#fff',
          fontSize: 8,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
        }}>
          {badge > 9 ? '9+' : badge}
        </div>
      ) : null}
    </button>
  );
}

// ── Utility Button (bottom) ──

function UtilButton({
  icon: IconComponent,
  label,
  onClick,
  badge,
  active,
  tint,
  useTauri = true,
}: {
  icon: PhosphorIcon;
  label: string;
  onClick?: () => void;
  badge?: number;
  active?: boolean;
  tint?: string;
  useTauri?: boolean;
}) {
  const activeColor = tint ?? BRAND_MARK_BLUE;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        padding: '4px 0',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        const neo = e.currentTarget.querySelector('[data-neo]') as HTMLElement;
        if (neo) applyNeoHover(neo, !!active, useTauri);
      }}
      onMouseLeave={(e) => {
        const neo = e.currentTarget.querySelector('[data-neo]') as HTMLElement;
        if (neo) resetNeoHover(neo, !!active, useTauri);
      }}
    >
      <div data-neo="" style={neoIconStyle(!!active, useTauri)}>
        <IconComponent
          size={18}
          weight={active ? 'duotone' : 'regular'}
          color={active ? activeColor : (tint ?? 'var(--t-text-secondary)')}
        />
      </div>
      {badge && badge > 0 ? (
        <div style={{
          position: 'absolute',
          top: 2,
          right: 2,
          width: 14,
          height: 14,
          borderRadius: 7,
          background: BRAND_MARK_BLUE,
          color: '#fff',
          fontSize: 8,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
        }}>
          {badge > 9 ? '9+' : badge}
        </div>
      ) : null}
    </button>
  );
}

// ── Port Types ──

interface PortGroup {
  repo: string;
  repoPath: string;
  ports: number[];
}

// ── Well-known port labels ──

const WELL_KNOWN_PORTS: Record<number, string> = {
  3000: 'Dev server',
  3001: 'Dev server',
  3002: 'WebSocket',
  8080: 'Dev server',
  18789: 'Gateway',
  18790: 'Gateway',
  18791: 'Gateway',
};

function portLabel(port: number): string {
  return WELL_KNOWN_PORTS[port] ?? `Port ${port}`;
}

function buildPortTooltip(groups: PortGroup[], total: number): string {
  const header = `${total} active port${total === 1 ? '' : 's'}`;
  const lines = groups.flatMap(g =>
    g.ports.map(p => `${portLabel(p)}: ${p}`),
  );
  return [header, ...lines].join('\n');
}

// ── Ports Footer (collapsed-only) ──

function PortsFooter({ onPortPreview }: { onPortPreview?: (port: number, url: string, repo?: string) => void }) {
  const [groups, setGroups] = useState<PortGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [hovered, setHovered] = useState(false);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const badgeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function fetchPorts() {
      fetch('/api/panel/ports')
        .then(r => r.json())
        .then(data => {
          setGroups(data.groups ?? []);
          setTotal(data.total ?? 0);
        })
        .catch(() => {});
    }
    fetchPorts();
    const id = setInterval(fetchPorts, 10_000);
    return () => clearInterval(id);
  }, []);

  const showPopover = () => {
    if (hideTimeout.current) { clearTimeout(hideTimeout.current); hideTimeout.current = null; }
    setHovered(true);
  };
  const scheduleHide = () => {
    hideTimeout.current = setTimeout(() => setHovered(false), 200);
  };

  if (total === 0) return null;

  const ariaLabel = `${total} active port${total === 1 ? '' : 's'}`;
  const allPorts = groups.flatMap(g => g.ports.map(p => ({ port: p, repo: g.repo })));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, position: 'relative' }}>
      <div style={{
        height: 1,
        width: 24,
        background: 'var(--t-divider-subtle)',
        margin: '4px auto',
      }} />
      <div style={{
        display: 'flex', justifyContent: 'center', padding: '2px 0',
      }}>
        <div
          ref={badgeRef}
          aria-label={ariaLabel}
          onMouseEnter={showPopover}
          onMouseLeave={scheduleHide}
          style={{
            width: 22, height: 22, borderRadius: 6,
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, color: '#16a34a',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            cursor: 'pointer',
          }}
        >
          {total}
        </div>
      </div>

      {/* Ports hover popover — portalled to body to escape transform context */}
      {hovered && createPortal(
        <div
          onMouseEnter={showPopover}
          onMouseLeave={scheduleHide}
          style={{
            position: 'fixed',
            bottom: Math.max(8, window.innerHeight - (badgeRef.current?.getBoundingClientRect().top ?? 0) - 8),
            left: 64,
            minWidth: 180,
            padding: 6,
            borderRadius: 10,
            background: '#1e2028',
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            zIndex: 9999,
          }}
        >
          <div style={{
            paddingTop: 4,
            paddingRight: 8,
            paddingBottom: 6,
            paddingLeft: 8,
            fontSize: 11,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.5)',
            letterSpacing: '-0.01em',
          }}>
            {total} active port{total === 1 ? '' : 's'}
          </div>
          {allPorts.map(({ port, repo }) => (
            <button
              key={port}
              type="button"
              onClick={() => {
                setHovered(false);
                const url = `http://localhost:${port}`;
                onPortPreview ? onPortPreview(port, url, repo) : window.open(url, '_blank');
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                paddingTop: 6,
                paddingRight: 8,
                paddingBottom: 6,
                paddingLeft: 8,
                border: 'none',
                borderRadius: 6,
                background: 'transparent',
                color: '#e2e8f0',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: 3,
                background: '#22c55e',
                flexShrink: 0,
              }} />
              <span style={{ flex: 1 }}>{portLabel(port)}</span>
              <span style={{
                fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}>
                :{port}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── Main Component ──

export function NavRail({
  activeSection,
  onSectionChange,
  alertCount = 0,
  approvalCount = 0,
  onAlertClick,
  alertTray,
  thoughtsOpen,
  onThoughtsToggle,
  onPortPreview,
}: NavRailProps) {
  const [inTauri, setInTauri] = useState(false);
  useEffect(() => { setInTauri(isTauri()); }, []);
  const [alertAnchorEl, setAlertAnchorEl] = useState<HTMLDivElement | null>(null);
  const alertTrayNode = alertTray && isValidElement(alertTray)
    ? cloneElement(alertTray, { desktopAnchorEl: alertAnchorEl })
    : alertTray;

  return (
    <nav
      aria-label="Main navigation"
      style={{
        width: RAIL_WIDTH,
        height: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '12px 4px',
        background: inTauri ? 'transparent' : 'var(--t-chrome-nav)',
        backdropFilter: inTauri ? 'none' : 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: inTauri ? 'none' : 'blur(20px) saturate(1.4)',
        position: 'relative',
        zIndex: 40,
        overflowX: 'visible',
        overflowY: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* Top — Logo + Nav Items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
        {/* Logo */}
        <div style={{ paddingTop: 2, paddingBottom: 8 }}>
          <CortexLogo />
        </div>

        {/* Separator */}
        <div style={{
          height: 1,
          width: 24,
          background: 'var(--t-divider-subtle)',
          marginBottom: 6,
        }} />

        {/* Main nav */}
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={activeSection === item.id}
            onClick={() => onSectionChange(item.id)}
            badge={item.id === 'approvals' ? approvalCount : undefined}
            useTauri={inTauri}
            onPrefetch={
              item.id === 'settings' ? () => { import('@/components/desktop/SettingsPage'); }
              : item.id === 'analytics' ? () => { import('@/components/desktop/AnalyticsPage'); }
              : undefined
            }
          />
        ))}
      </div>

      {/* Bottom — Ports + Thoughts + Alerts + Settings */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center', position: 'relative' }}>
        <PortsFooter onPortPreview={onPortPreview} />

        <UtilButton
          icon={Lightbulb}
          label="Thoughts"
          onClick={onThoughtsToggle}
          active={thoughtsOpen}
          useTauri={inTauri}
        />
        <div ref={setAlertAnchorEl} style={{ position: 'relative', width: '100%' }}>
          <UtilButton
            icon={Bell}
            label="Alerts"
            onClick={onAlertClick}
            badge={alertCount}
            useTauri={inTauri}
          />
          {alertTrayNode}
        </div>
        <UtilButton
          icon={GearSix}
          label="Settings"
          onClick={() => onSectionChange('settings')}
          tint="#ef4444"
          useTauri={inTauri}
        />
      </div>
    </nav>
  );
}
