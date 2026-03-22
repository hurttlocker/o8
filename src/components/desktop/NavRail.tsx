'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions -- nav rail keeps dormant playground affordances during migration */

/**
 * NavRail — Slim left navigation rail, adapted from MisterADA PlaygroundGlassNav.
 *
 * Hover-expand from 56px → 200px with framer-motion spring.
 * Icon-only collapsed, icon+label expanded.
 * Glass frosted background matching the Cortex IDE design system.
 */

import { useState, useEffect, createContext, useContext, useCallback, cloneElement, isValidElement, type ReactNode, type ReactElement } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Box,
  Users,
  Terminal,
  Settings,
  Brain,
  BarChart3,
  Bell,
  Lightbulb,
  Cable,
  type LucideIcon,
} from 'lucide-react';

// ── Types ──

export type NavSection =
  | 'agents'
  | 'terminal'
  | 'memory'
  | 'analytics'
  | 'settings';

interface NavRailProps {
  activeSection: NavSection;
  onSectionChange: (section: NavSection) => void;
  alertCount?: number;
  onAlertClick?: () => void;
  alertTray?: ReactElement<{ desktopAnchorEl?: HTMLElement | null }> | null;
  thoughtsOpen?: boolean;
  onThoughtsToggle?: () => void;
  onPortPreview?: (port: number, url: string, repo?: string) => void;
}

interface NavItem {
  id: NavSection;
  label: string;
  icon: LucideIcon;
}

// ── Constants ──

const COLLAPSED_WIDTH = 56;
const EXPANDED_WIDTH = 200;

const NAV_ITEMS: NavItem[] = [
  { id: 'agents', label: 'Agents', icon: Users },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
];

const SPRING = { type: 'spring' as const, stiffness: 400, damping: 30 };

// ── Logo ──

function CortexLogo({ expanded }: { expanded: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '4px 0',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
    }}>
      {/* Cortex brain logo */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icons/icon-192x192.png"
        alt="Cortex"
        width={28}
        height={28}
        style={{ flexShrink: 0, borderRadius: 6 }}
      />
      <motion.span
        initial={false}
        animate={{
          opacity: expanded ? 1 : 0,
          display: expanded ? 'inline-block' : 'none',
        }}
        transition={{ duration: 0.15 }}
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: 'var(--t-text)',
          letterSpacing: '-0.02em',
        }}
      >
        CORTEX
      </motion.span>
    </div>
  );
}

// ── Nav Item Button ──

function NavButton({
  item,
  active,
  expanded,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '10px 12px',
        borderRadius: 12,
        border: 'none',
        background: active ? 'var(--t-panel-active)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 150ms ease, color 150ms ease',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        minHeight: 44,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--t-hover)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <Icon
        size={20}
        strokeWidth={active ? 2.2 : 1.8}
        style={{ flexShrink: 0 }}
      />
      <motion.span
        initial={false}
        animate={{
          opacity: expanded ? 1 : 0,
          display: expanded ? 'inline-block' : 'none',
        }}
        transition={{ duration: 0.12 }}
        style={{
          fontSize: 13,
          fontWeight: active ? 600 : 500,
          letterSpacing: '-0.01em',
        }}
      >
        {item.label}
      </motion.span>
    </button>
  );
}

// ── Utility Button (bottom) ──

function UtilButton({
  icon: Icon,
  label,
  expanded,
  onClick,
  badge,
  active,
  tint,
}: {
  icon: LucideIcon;
  label: string;
  expanded: boolean;
  onClick?: () => void;
  badge?: number;
  active?: boolean;
  tint?: string;
}) {
  const activeColor = tint ?? '#2563eb';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '10px 12px',
        borderRadius: 12,
        border: 'none',
        background: active ? (tint ? `${tint}14` : 'rgba(37, 99, 235, 0.08)') : 'transparent',
        color: active ? activeColor : (tint ?? 'var(--t-text-secondary)'),
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 150ms ease',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        minHeight: 44,
        position: 'relative',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <Icon size={20} strokeWidth={1.8} />
        {badge && badge > 0 ? (
          <div style={{
            position: 'absolute',
            top: -4,
            right: -6,
            width: 16,
            height: 16,
            borderRadius: 8,
            background: '#2563eb',
            color: '#fff',
            fontSize: 9,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
          }}>
            {badge > 9 ? '9+' : badge}
          </div>
        ) : null}
      </div>
      <motion.span
        initial={false}
        animate={{
          opacity: expanded ? 1 : 0,
          display: expanded ? 'inline-block' : 'none',
        }}
        transition={{ duration: 0.12 }}
        style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.01em' }}
      >
        {label}
      </motion.span>
    </button>
  );
}

// ── Port Types ──

interface PortGroup {
  repo: string;
  repoPath: string;
  ports: number[];
}

// ── Ports Footer ──

function PortsFooter({ expanded, onPortPreview }: { expanded: boolean; onPortPreview?: (port: number, url: string, repo?: string) => void }) {
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
      {/* Separator */}
      <div style={{
        height: 1,
        background: 'var(--t-divider)',
        margin: '4px 12px',
      }} />

      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}>
        <Cable size={14} strokeWidth={1.8} style={{ color: '#22c55e', flexShrink: 0 }} />
        <motion.span
          initial={false}
          animate={{ opacity: expanded ? 1 : 0, display: expanded ? 'inline-block' : 'none' }}
          transition={{ duration: 0.12 }}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--t-text-secondary)',
            letterSpacing: '-0.01em',
          }}
        >
          Ports
        </motion.span>
        <motion.span
          initial={false}
          animate={{ opacity: expanded ? 1 : 0, display: expanded ? 'inline-block' : 'none' }}
          transition={{ duration: 0.12 }}
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#22c55e',
            marginLeft: 'auto',
          }}
        >
          {total}
        </motion.span>
      </div>

      {/* Port groups */}
      {expanded ? (
        /* Expanded: full port pills grouped by repo */
        groups.map((group) => (
          <div key={group.repo} style={{ padding: '0 12px', overflow: 'hidden' }}>
            <div style={{
              fontSize: 9, fontWeight: 600, color: 'var(--t-text-faint)',
              textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2,
            }}>
              {group.repo}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {group.ports.map((port) => (
                <button
                  key={port}
                  type="button"
                  onClick={() => {
                    const url = `http://localhost:${port}`;
                    onPortPreview ? onPortPreview(port, url, group.repo) : window.open(url, '_blank');
                  }}
                  title={`Preview localhost:${port}`}
                  style={{
                    padding: '2px 6px', borderRadius: 4,
                    border: '1px solid rgba(34,197,94,0.15)',
                    background: 'rgba(34,197,94,0.06)',
                    color: '#16a34a', fontSize: 10, fontWeight: 600,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    cursor: 'pointer', transition: 'background 120ms ease',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(34,197,94,0.12)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(34,197,94,0.06)'; }}
                >
                  {port}
                </button>
              ))}
            </div>
          </div>
        ))
      ) : (
        /* Collapsed: single green count badge */
        <div style={{
          display: 'flex', justifyContent: 'center', padding: '2px 0',
        }}>
          <div
            title={groups.flatMap(g => g.ports.map(p => `${g.repo}: ${p}`)).join('\n')}
            style={{
              width: 22, height: 22, borderRadius: 6,
              background: 'rgba(34,197,94,0.1)',
              border: '1px solid rgba(34,197,94,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700, color: '#16a34a',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            {total}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ──

export function NavRail({
  activeSection,
  onSectionChange,
  alertCount = 0,
  onAlertClick,
  alertTray,
  thoughtsOpen,
  onThoughtsToggle,
  onPortPreview,
}: NavRailProps) {
  const [expanded, setExpanded] = useState(false);
  const [alertAnchorEl, setAlertAnchorEl] = useState<HTMLDivElement | null>(null);
  const alertTrayNode = alertTray && isValidElement(alertTray)
    ? cloneElement(alertTray, { desktopAnchorEl: alertAnchorEl })
    : alertTray;

  return (
    <motion.nav
      initial={false}
      animate={{ width: expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH }}
      transition={SPRING}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      aria-label="Main navigation"
      style={{
        height: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '16px 8px',
        background: 'var(--t-chrome-nav)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        borderRight: '1px solid var(--t-divider)',
        position: 'relative',
        zIndex: 40,
        overflowX: 'visible',
        overflowY: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* Top — Logo + Nav Items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* Logo */}
        <div style={{ padding: '4px 12px 12px', marginBottom: 4 }}>
          <CortexLogo expanded={expanded} />
        </div>

        {/* Separator */}
        <div style={{
          height: 1,
          background: 'var(--t-divider)',
          margin: '4px 12px',
        }} />

        {/* Main nav */}
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={activeSection === item.id}
            expanded={expanded}
            onClick={() => onSectionChange(item.id)}
          />
        ))}
      </div>

      {/* Bottom — Ports + Thoughts + Alerts + Settings */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, position: 'relative' }}>
        {/* Ports footer — pinned above utils */}
        <PortsFooter expanded={expanded} onPortPreview={onPortPreview} />

        <UtilButton
          icon={Lightbulb}
          label="Thoughts"
          expanded={expanded}
          onClick={onThoughtsToggle}
          active={thoughtsOpen}
        />
        <div ref={setAlertAnchorEl} style={{ position: 'relative' }}>
          <UtilButton
            icon={Bell}
            label="Alerts"
            expanded={expanded}
            onClick={onAlertClick}
            badge={alertCount}
          />
          {alertTrayNode}
        </div>
        <UtilButton
          icon={Settings}
          label="Settings"
          expanded={expanded}
          onClick={() => onSectionChange('settings')}
          tint="#ef4444"
        />
      </div>
    </motion.nav>
  );
}
