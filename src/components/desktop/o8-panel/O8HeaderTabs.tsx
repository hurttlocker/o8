'use client';

import type { O8Tab } from './types';

function IconWorkspace({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
      <path d="M8 13h8" />
      <path d="M12 9v8" />
    </svg>
  );
}

function IconFiles({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconGitPullRequest({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

function IconActivity({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function IconPulse({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <path d="M3 12h4l3-9 4 18 3-9h4" />
    </svg>
  );
}

function IconInbox({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

const O8_ICON_ACTIVE = '#e2e8f0';
const O8_ICON_INACTIVE = 'var(--t-text-muted)';

function O8HeaderTabButton({
  icon,
  active,
  onClick,
  label,
}: {
  icon: (color: string) => React.ReactNode;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        padding: 0,
        border: 'none',
        borderRadius: 10,
        background: active ? 'var(--t-panel-active, var(--t-input-bg))' : 'transparent',
        color: active ? O8_ICON_ACTIVE : O8_ICON_INACTIVE,
        cursor: 'pointer',
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        position: 'relative',
        flexShrink: 0,
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(event) => {
        if (!active) event.currentTarget.style.background = 'var(--t-hover)';
      }}
      onMouseLeave={(event) => {
        if (!active) event.currentTarget.style.background = 'transparent';
      }}
    >
      {icon(active ? O8_ICON_ACTIVE : O8_ICON_INACTIVE)}
      {active ? (
        <span
          style={{
            position: 'absolute',
            bottom: 3,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 12,
            height: 2,
            borderRadius: 1,
            background: 'var(--t-brand-orange)',
          }}
        />
      ) : null}
    </button>
  );
}

function O8HeaderDivider() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 1,
        height: 18,
        background: 'var(--t-divider-subtle)',
        marginLeft: 6,
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

export function O8HeaderTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: O8Tab;
  onTabChange: (tab: O8Tab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="O8 panel tabs"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        height: 32,
        flexShrink: 0,
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      <O8HeaderTabButton icon={(color) => <IconWorkspace size={16} color={color} />} active={activeTab === 'workspace'} onClick={() => onTabChange('workspace')} label="Workspace" />
      <O8HeaderTabButton icon={(color) => <IconPulse size={16} color={color} />} active={activeTab === 'pulse'} onClick={() => onTabChange('pulse')} label="Pulse" />
      <O8HeaderDivider />
      <O8HeaderTabButton icon={(color) => <IconGitPullRequest size={16} color={color} />} active={activeTab === 'prs'} onClick={() => onTabChange('prs')} label="PRs" />
      <O8HeaderTabButton icon={(color) => <IconInbox size={16} color={color} />} active={activeTab === 'inbox'} onClick={() => onTabChange('inbox')} label="Inbox" />
      <O8HeaderTabButton icon={(color) => <IconActivity size={16} color={color} />} active={activeTab === 'activity'} onClick={() => onTabChange('activity')} label="Activity" />
      <O8HeaderDivider />
      <O8HeaderTabButton icon={(color) => <IconFiles size={16} color={color} />} active={activeTab === 'spec'} onClick={() => onTabChange('spec')} label="o8.md" />
    </div>
  );
}
