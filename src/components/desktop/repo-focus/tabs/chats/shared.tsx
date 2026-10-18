'use client';

import { useState, type ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Folder as IconoirFolder } from 'iconoir-react';
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { ChevronDown, ChevronRight } from '../../../lucide-shims';
import { REPO_FOCUS_FONT } from '../../utils';
import { historyRuntime } from './helpers';
import type { ChatHistoryItem } from './types';

export function RuntimeHistoryIcon({ item, size = 12 }: { item: ChatHistoryItem; size?: number }) {
  switch (historyRuntime(item)) {
    case 'claude-code':
      return <ClaudeIcon size={size} />;
    case 'gemini':
      return <GeminiIcon size={size} />;
    case 'opencode':
      return <OpenCodeIcon size={size} />;
    default:
      return <CodexIcon size={size} />;
  }
}

export function SectionLabel({
  label,
  compact = false,
  count,
  countTone,
  collapsed,
  onToggle,
  action,
  controls,
  status,
}: {
  label: string;
  compact?: boolean;
  count?: number;
  countTone?: string;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Section-level affordance (#2154's Agents "Clear"). Rendered OUTSIDE the
   *  toggle button — a button inside a button is invalid markup. */
  action?: ReactNode;
  controls?: string;
  status?: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const reducedMotion = useReducedMotion();
  const commonStyle = {
    paddingTop: compact ? 10 : 12,
    paddingRight: 12,
    paddingBottom: compact ? 7 : 8,
    paddingLeft: 12,
    fontSize: 11.5,
    lineHeight: '16px',
    fontWeight: 500,
    letterSpacing: '-0.1px',
    color: 'var(--t-text-secondary)',
    fontFamily: REPO_FOCUS_FONT,
  };

  const toggle = onToggle ? (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-controls={!collapsed ? controls : undefined}
      onClick={onToggle}
      title={`${collapsed ? 'Show' : 'Hide'} ${label.toLowerCase()}`}
      style={{
        flex: 1,
        minWidth: 0,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        borderWidth: 0,
        background: 'transparent',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
        letterSpacing: 'inherit',
      }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span aria-hidden="true" data-section-chevron="" style={{
        display: 'flex', flexShrink: 0, width: 12, height: 12,
        opacity: hovered || focused ? 1 : 0,
        transition: reducedMotion ? 'none' : 'opacity 120ms ease-out',
      }}>
        {collapsed ? <ChevronRight size={12} strokeWidth={1.8} /> : <ChevronDown size={12} strokeWidth={1.8} />}
      </span>
    </button>
  ) : <span style={{ flex: 1, minWidth: 0 }}>{label}</span>;

  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)} onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      style={{ ...commonStyle, display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box' }}>
      {toggle}
      {status}
      {action ? <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{action}</div> : null}
      {typeof count === 'number' ? (
        <span
          aria-label={`${count} ${label.toLowerCase()}`}
          style={{
            fontSize: 10.5,
            lineHeight: '12px',
            letterSpacing: 0,
            color: countTone ?? 'var(--t-text-muted)',
            fontWeight: 300,
          }}
        >
          {count}
        </span>
      ) : null}
    </div>
  );
}

function RepoGroupLabel({
  label,
  trailing,
  noIcon = false,
  collapsed,
  onToggle,
  onCreate,
  createTitle,
}: {
  label: string;
  trailing?: React.ReactNode;
  noIcon?: boolean;
  /** Drawer state — only meaningful when onToggle is provided. */
  collapsed?: boolean;
  /** When set, the whole header toggles the repo drawer. */
  onToggle?: () => void;
  /** Hover-revealed [+] — spawn a new session scoped to this repo. */
  onCreate?: () => void;
  createTitle?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const reducedMotion = useReducedMotion();
  const toggleable = Boolean(onToggle);
  return (
    <div
      role={toggleable ? 'button' : undefined}
      tabIndex={toggleable ? 0 : undefined}
      aria-expanded={toggleable ? !collapsed : undefined}
      title={toggleable ? `${collapsed ? 'Show' : 'Hide'} ${label} sessions` : undefined}
      onClick={onToggle}
      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onToggle?.(); } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 22,
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 3,
        paddingLeft: 12,
        color: 'var(--t-text-secondary)',
        background: hovered && toggleable ? 'var(--t-hover)' : 'transparent',
        fontFamily: REPO_FOCUS_FONT,
        cursor: toggleable ? 'pointer' : undefined,
        userSelect: 'none',
      }}
    >
      {!noIcon ? <span
        aria-hidden
        style={{
          width: 11,
          height: 11,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--t-text-secondary)',
          flexShrink: 0,
        }}
      >
        <IconoirFolder width={11} height={11} color="currentColor" strokeWidth={1.6} />
      </span> : null}
      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11,
            lineHeight: '14px',
            fontWeight: 500,
            letterSpacing: '-0.1px',
          }}
        >
          {label}
        </span>
        {toggleable ? <span aria-hidden="true" data-section-chevron="" style={{
          display: 'flex', flexShrink: 0, width: 12, height: 12,
          opacity: hovered || focused ? 1 : 0,
          transition: reducedMotion ? 'none' : 'opacity 120ms ease-out',
        }}>
          {collapsed ? <ChevronRight size={12} strokeWidth={1.8} /> : <ChevronDown size={12} strokeWidth={1.8} />}
        </span> : null}
      </span>
      {onCreate ? (
        <button
          type="button"
          title={createTitle ?? `New session in ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onCreate();
          }}
          style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 0,
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            outline: 'none',
            color: 'var(--t-text-muted)',
            fontSize: 13,
            lineHeight: '13px',
            fontWeight: 400,
            opacity: hovered || focused ? 1 : 0,
            transition: reducedMotion ? 'none' : 'opacity 120ms ease-out',
            flexShrink: 0,
          }}
        >
          +
        </button>
      ) : null}
      {trailing ? (
        // The trailing slot (group-by picker) must not toggle the drawer.
        <span onClick={(event) => event.stopPropagation()} style={{ display: 'inline-flex', flexShrink: 0 }}>
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

export { RepoGroupLabel };
