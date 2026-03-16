'use client';

/**
 * NavRail — Slim left navigation rail, adapted from MisterADA PlaygroundGlassNav.
 *
 * Hover-expand from 56px → 200px with framer-motion spring.
 * Icon-only collapsed, icon+label expanded.
 * Glass frosted background matching the Cortex IDE design system.
 */

import { useState, createContext, useContext, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Box,
  Users,
  Terminal,
  Settings,
  Brain,
  BarChart3,
  Bell,
  Search,
  Zap,
  type LucideIcon,
} from 'lucide-react';

// ── Types ──

export type NavSection =
  | 'agents'
  | 'intent'
  | 'terminal'
  | 'memory'
  | 'analytics'
  | 'settings';

interface NavRailProps {
  activeSection: NavSection;
  onSectionChange: (section: NavSection) => void;
  alertCount?: number;
  onAlertClick?: () => void;
  onSearchClick?: () => void;
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
  { id: 'intent', label: 'Intent', icon: Zap },
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
          color: '#111827',
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
        background: active ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
        color: active ? '#111827' : '#6b7280',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 150ms ease, color 150ms ease',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        minHeight: 44,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'rgba(0, 0, 0, 0.03)';
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
}: {
  icon: LucideIcon;
  label: string;
  expanded: boolean;
  onClick?: () => void;
  badge?: number;
}) {
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
        background: 'transparent',
        color: '#6b7280',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 150ms ease',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        minHeight: 44,
        position: 'relative',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.03)'; }}
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
            background: '#ef4444',
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

// ── Main Component ──

export function NavRail({
  activeSection,
  onSectionChange,
  alertCount = 0,
  onAlertClick,
  onSearchClick,
}: NavRailProps) {
  const [expanded, setExpanded] = useState(false);

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
        background: 'rgba(245, 247, 251, 0.82)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        borderRight: '1px solid rgba(0, 0, 0, 0.06)',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* Top — Logo + Nav Items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* Logo */}
        <div style={{ padding: '4px 12px 12px', marginBottom: 4 }}>
          <CortexLogo expanded={expanded} />
        </div>

        {/* Search */}
        <UtilButton
          icon={Search}
          label="Search"
          expanded={expanded}
          onClick={onSearchClick}
        />

        {/* Separator */}
        <div style={{
          height: 1,
          background: 'rgba(0, 0, 0, 0.06)',
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

      {/* Bottom — Alerts + Settings */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <UtilButton
          icon={Bell}
          label="Alerts"
          expanded={expanded}
          onClick={onAlertClick}
          badge={alertCount}
        />
        <UtilButton
          icon={Settings}
          label="Settings"
          expanded={expanded}
          onClick={() => onSectionChange('settings')}
        />
      </div>
    </motion.nav>
  );
}
