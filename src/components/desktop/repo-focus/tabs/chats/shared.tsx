'use client';

import { useState } from 'react';
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
}: {
  label: string;
  compact?: boolean;
  count?: number;
  countTone?: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const commonStyle = {
    paddingTop: compact ? 7 : 10,
    paddingRight: 12,
    paddingBottom: compact ? 4 : 5,
    paddingLeft: 12,
    fontSize: 10,
    lineHeight: '14px',
    fontWeight: 300,
    letterSpacing: '-0.1px',
    color: 'var(--t-text-faint)',
    fontFamily: REPO_FOCUS_FONT,
  };

  if (!onToggle) {
    return (
      <div style={{ ...commonStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
        {typeof count === 'number' ? (
          <span
            aria-label={`${count} ${label.toLowerCase()}`}
            style={{
              fontSize: compact ? 9 : 9.5,
              lineHeight: '12px',
              letterSpacing: 0,
              color: countTone ?? 'var(--t-text-faint)',
              fontWeight: 300,
            }}
          >
            {count}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      title={`${collapsed ? 'Show' : 'Hide'} ${label.toLowerCase()}`}
      style={{
        ...commonStyle,
        width: '100%',
        borderWidth: 0,
        background: 'transparent',
        cursor: 'pointer',
        outline: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        textAlign: 'left',
      }}
    >
      {collapsed ? <ChevronRight size={11} strokeWidth={2} /> : <ChevronDown size={11} strokeWidth={2} />}
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {typeof count === 'number' ? (
        <span
          aria-label={`${count} ${label.toLowerCase()}`}
          style={{
            fontSize: compact ? 9 : 9.5,
            lineHeight: '12px',
            letterSpacing: 0,
            color: countTone ?? 'var(--t-text-faint)',
            fontWeight: 300,
          }}
        >
          {count}
        </span>
      ) : null}
    </button>
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
  /** When set, the whole header toggles the repo drawer (Cursor pattern). */
  onToggle?: () => void;
  /** Hover-revealed [+] — spawn a new session scoped to this repo. */
  onCreate?: () => void;
  createTitle?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const toggleable = Boolean(onToggle);
  // Leading 11px slot keeps its exact geometry (OCD rule: icons stay where
  // they are). At rest the folder reads as identity; the chevron only takes
  // the slot when the drawer is collapsed (state must read at a glance) or
  // while hovering a toggleable header (affordance).
  const leadingGlyph = noIcon
    ? null
    : toggleable && collapsed
      ? <ChevronRight size={11} strokeWidth={2} />
      : toggleable && hovered
        ? <ChevronDown size={11} strokeWidth={2} />
        : <IconoirFolder width={11} height={11} color="currentColor" strokeWidth={1.6} />;
  return (
    <div
      role={toggleable ? 'button' : undefined}
      aria-expanded={toggleable ? !collapsed : undefined}
      title={toggleable ? `${collapsed ? 'Show' : 'Hide'} ${label} sessions` : undefined}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 22,
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 3,
        paddingLeft: 12,
        color: 'var(--t-text-faint)',
        fontFamily: REPO_FOCUS_FONT,
        cursor: toggleable ? 'pointer' : undefined,
        userSelect: 'none',
      }}
    >
      {/* Folder glyph (or empty spacer for non-repo groups like
          Conversations) — Antigravity-style repo-prefix. Sized to match
          the 11px chevron in adjacent SectionLabel headers (Spawned
          agents, Archived) so labels start at the same x position. */}
      <span
        aria-hidden
        style={{
          width: 11,
          height: 11,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--t-text-faint)',
          flexShrink: 0,
        }}
      >
        {leadingGlyph}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 10,
          lineHeight: '14px',
          fontWeight: 300,
          letterSpacing: '-0.1px',
        }}
      >
        {label}
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
            opacity: hovered ? 1 : 0,
            transition: 'opacity 120ms ease',
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
