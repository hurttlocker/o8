'use client';

/**
 * NavRail — Slim fixed-width left navigation rail.
 *
 * Compact icon-only rail with Phosphor duotone icons in neomorphic containers.
 * Fixed at 44px — no hover-expand.
 */

import { useState, useEffect, cloneElement, isValidElement, type ReactElement } from 'react';
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

const NEO_INACTIVE = {
  background: 'rgba(255, 255, 255, 0.55)',
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
};
const NEO_ACTIVE = {
  background: 'rgba(255, 255, 255, 0.95)',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
};
const NEO_HOVER = {
  background: 'rgba(255, 255, 255, 0.8)',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
};

function neoIconStyle(active: boolean): React.CSSProperties {
  const preset = active ? NEO_ACTIVE : NEO_INACTIVE;
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

function applyNeoHover(el: HTMLElement, active: boolean) {
  if (!active) {
    el.style.background = NEO_HOVER.background;
    el.style.boxShadow = NEO_HOVER.boxShadow;
  }
}

function resetNeoHover(el: HTMLElement, active: boolean) {
  if (!active) {
    el.style.background = NEO_INACTIVE.background;
    el.style.boxShadow = NEO_INACTIVE.boxShadow;
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
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
  badge?: number;
  onPrefetch?: () => void;
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
        if (neo) applyNeoHover(neo, active);
        onPrefetch?.();
      }}
      onMouseLeave={(e) => {
        const neo = e.currentTarget.querySelector('[data-neo]') as HTMLElement;
        if (neo) resetNeoHover(neo, active);
      }}
    >
      <div data-neo="" style={neoIconStyle(active)}>
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
}: {
  icon: PhosphorIcon;
  label: string;
  onClick?: () => void;
  badge?: number;
  active?: boolean;
  tint?: string;
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
        if (neo) applyNeoHover(neo, !!active);
      }}
      onMouseLeave={(e) => {
        const neo = e.currentTarget.querySelector('[data-neo]') as HTMLElement;
        if (neo) resetNeoHover(neo, !!active);
      }}
    >
      <div data-neo="" style={neoIconStyle(!!active)}>
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

// ── Ports Footer (collapsed-only) ──

function PortsFooter({ onPortPreview }: { onPortPreview?: (port: number, url: string, repo?: string) => void }) {
  const [groups, setGroups] = useState<PortGroup[]>([]);
  const [total, setTotal] = useState(0);

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

  if (total === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
          title={groups.flatMap(g => g.ports.map(p => `${g.repo}: ${p}`)).join('\n')}
          onClick={() => {
            if (groups.length > 0 && groups[0].ports.length > 0) {
              const port = groups[0].ports[0];
              const url = `http://localhost:${port}`;
              onPortPreview ? onPortPreview(port, url, groups[0].repo) : window.open(url, '_blank');
            }
          }}
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
        background: 'var(--t-chrome-nav)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
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
        />
        <div ref={setAlertAnchorEl} style={{ position: 'relative', width: '100%' }}>
          <UtilButton
            icon={Bell}
            label="Alerts"
            onClick={onAlertClick}
            badge={alertCount}
          />
          {alertTrayNode}
        </div>
        <UtilButton
          icon={GearSix}
          label="Settings"
          onClick={() => onSectionChange('settings')}
          tint="#ef4444"
        />
      </div>
    </nav>
  );
}
