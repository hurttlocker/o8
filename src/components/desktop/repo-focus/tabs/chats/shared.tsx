'use client';

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
  collapsed,
  onToggle,
}: {
  label: string;
  compact?: boolean;
  count?: number;
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
              color: 'var(--t-text-faint)',
              fontWeight: 500,
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
            color: 'var(--t-text-faint)',
            fontWeight: 500,
          }}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function RepoGroupLabel({ label, trailing, noIcon = false }: { label: string; trailing?: React.ReactNode; noIcon?: boolean }) {
  return (
    <div
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
        {noIcon ? null : <IconoirFolder width={11} height={11} color="currentColor" strokeWidth={1.6} />}
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
      {trailing}
    </div>
  );
}

export { RepoGroupLabel };
