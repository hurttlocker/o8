'use client';

/**
 * PacketTabStrip — horizontal tab strip rendered at the top of an
 * expanded packet card (#888/#893). Four tabs:
 *
 *   Agents •  / Context / Changes N / Files
 *
 *   - Notification dot (•) on Agents when verifier flagged or a
 *     sub-agent finished and awaits review.
 *   - Count badge on Changes = files modified.
 *   - Issues-style aesthetic: uppercase, no shadow, one orange accent
 *     for the active tab.
 *
 * No native form controls, no CSS classes. Inline styles + theme tokens.
 */

import { memo } from 'react';

export type PacketTabId = 'agents' | 'context' | 'changes' | 'files';

interface PacketTabStripProps {
  active: PacketTabId;
  onChange: (tab: PacketTabId) => void;
  agentsHasNotification?: boolean;
  changesCount?: number | null;
}

function PacketTabStripBase({ active, onChange, agentsHasNotification, changesCount }: PacketTabStripProps) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        paddingTop: 5,
        paddingRight: 8,
        paddingBottom: 5,
        paddingLeft: 8,
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'var(--t-panel-hover)',
      }}
    >
      <PacketTab
        id="agents"
        active={active === 'agents'}
        label="Agents"
        notification={agentsHasNotification}
        onClick={() => onChange('agents')}
      />
      <PacketTab
        id="context"
        active={active === 'context'}
        label="Context"
        onClick={() => onChange('context')}
      />
      <PacketTab
        id="changes"
        active={active === 'changes'}
        label="Changes"
        countBadge={typeof changesCount === 'number' && changesCount > 0 ? changesCount : null}
        onClick={() => onChange('changes')}
      />
      <PacketTab
        id="files"
        active={active === 'files'}
        label="Files"
        onClick={() => onChange('files')}
      />
    </div>
  );
}

interface PacketTabProps {
  id: PacketTabId;
  active: boolean;
  label: string;
  onClick: () => void;
  notification?: boolean;
  countBadge?: number | null;
}

function PacketTab({ active, label, onClick, notification, countBadge }: PacketTabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 22,
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 9,
        borderRadius: 6,
        borderWidth: 0,
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 9,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.color = 'var(--t-text-muted)';
      }}
    >
      <span>{label}</span>
      {notification ? (
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: '#FF5A1F',
            flexShrink: 0,
          }}
        />
      ) : null}
      {countBadge != null ? (
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 16,
            height: 14,
            paddingTop: 0,
            paddingRight: 4,
            paddingBottom: 0,
            paddingLeft: 4,
            borderRadius: 7,
            background: active ? 'var(--t-accent)' : 'var(--t-divider-subtle)',
            color: active ? '#ffffff' : 'var(--t-text-muted)',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0,
            fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
          }}
        >
          {countBadge}
        </span>
      ) : null}
    </button>
  );
}

export const PacketTabStrip = memo(PacketTabStripBase);
