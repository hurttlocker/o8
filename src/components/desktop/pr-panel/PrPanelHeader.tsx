'use client';

import { memo } from 'react';
import { ChevronDown, Expand, GitBranch, MoreHorizontal, PanelRight, Plus, X } from '../lucide-shims';

const MONO_FONT = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";

const HEADER_BTN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 8,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--t-text-muted)',
  cursor: 'pointer',
  padding: 0,
};

function statePill(state: string): { label: string; bg: string; color: string } {
  const s = state.toLowerCase();
  if (s === 'merged') return { label: 'Merged', bg: 'rgba(168, 85, 247, 0.14)', color: '#a855f7' };
  if (s === 'closed') return { label: 'Closed', bg: 'rgba(239, 68, 68, 0.14)', color: '#ef4444' };
  if (s === 'draft') return { label: 'Draft', bg: 'rgba(148, 163, 184, 0.18)', color: 'var(--t-text-muted)' };
  return { label: 'Open', bg: 'rgba(22, 163, 74, 0.14)', color: '#16a34a' };
}

interface PrPanelHeaderProps {
  prNumber: number;
  state: string;
  baseRefName?: string | null;
  headRefName?: string | null;
  onClose: () => void;
}

export const PrPanelHeader = memo(function PrPanelHeader({
  prNumber,
  state,
  baseRefName,
  headRefName,
  onClose,
}: PrPanelHeaderProps) {
  const pill = statePill(state);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 14,
        paddingRight: 10,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      {/* Top strip: PR pill + window controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 8,
            paddingRight: 10,
            borderRadius: 999,
            background: 'var(--t-bg-card)',
            border: '1px solid var(--t-divider-subtle)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--t-text)',
            fontFamily: MONO_FONT,
          }}
        >
          <GitBranch size={12} strokeWidth={2} />
          PR #{prNumber}
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" style={HEADER_BTN} title="New" onClick={() => {}}>
          <Plus size={14} strokeWidth={2} />
        </button>
        <button type="button" style={HEADER_BTN} title="Expand" onClick={() => {}}>
          <Expand size={14} strokeWidth={2} />
        </button>
        <button type="button" style={HEADER_BTN} title="Close" onClick={onClose}>
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Status row: state pill + branches + auto-merge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 2,
            paddingBottom: 2,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 999,
            background: pill.bg,
            color: pill.color,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          {pill.label}
        </span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--t-text-muted)',
            fontFamily: MONO_FONT,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {headRefName || 'branch'}
          <span style={{ color: 'var(--t-text-faint)' }}>{'→'}</span>
          {baseRefName || 'main'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" style={HEADER_BTN} title="More options" onClick={() => {}}>
          <MoreHorizontal size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          title="Coming soon"
          onClick={() => {}}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 10,
            paddingRight: 8,
            borderRadius: 10,
            border: '1px solid transparent',
            background: 'var(--t-text)',
            color: 'var(--t-bg, #ffffff)',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Enable Auto-Merge
          <ChevronDown size={12} strokeWidth={2} />
        </button>
        <button type="button" style={HEADER_BTN} title="Side panel" onClick={() => {}}>
          <PanelRight size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
});
