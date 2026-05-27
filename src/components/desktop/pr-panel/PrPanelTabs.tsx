'use client';

import { memo } from 'react';
import { Eye, XCircle } from '../lucide-shims';
import type { PrTabId } from './types';

const UI_FONT = 'var(--font-sans-system)';

interface PrPanelTabsProps {
  activeTab: PrTabId;
  onChange: (tab: PrTabId) => void;
  changesCount: number;
  checksTotal: number;
  checksFailing: number;
  commitsCount: number | null;
  reviewsCount: number;
  hasReviewerRequest: boolean;
}

interface TabSpec {
  id: PrTabId;
  label: string;
  count: string | null;
  tone: 'default' | 'danger';
  trailing?: React.ReactNode;
  leading?: React.ReactNode;
}

export const PrPanelTabs = memo(function PrPanelTabs({
  activeTab,
  onChange,
  changesCount,
  checksTotal,
  checksFailing,
  commitsCount,
  reviewsCount,
  hasReviewerRequest,
}: PrPanelTabsProps) {
  const checksDanger = checksFailing > 0;
  const tabs: TabSpec[] = [
    {
      id: 'changes',
      label: 'Changes',
      count: String(changesCount),
      tone: 'default',
    },
    {
      id: 'checks',
      label: checksDanger ? 'Checks Failed' : 'Checks',
      count: checksTotal > 0
        ? (checksDanger
          ? `${checksTotal - checksFailing}/${checksTotal}`
          : `${checksTotal}`)
        : null,
      tone: checksDanger ? 'danger' : 'default',
      leading: checksDanger ? <XCircle size={11} strokeWidth={2.4} /> : null,
    },
    {
      id: 'commits',
      label: 'Commits',
      count: commitsCount === null ? null : String(commitsCount),
      tone: 'default',
    },
    {
      id: 'reviews',
      label: 'Reviews',
      count: String(reviewsCount),
      tone: 'default',
      trailing: hasReviewerRequest ? <Eye size={11} strokeWidth={2} /> : null,
    },
  ];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 14,
        paddingRight: 14,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
      }}
    >
      {tabs.map((tab) => (
        <PrTabButton
          key={tab.id}
          spec={tab}
          active={tab.id === activeTab}
          onClick={() => onChange(tab.id)}
        />
      ))}
    </div>
  );
});

function PrTabButton({
  spec,
  active,
  onClick,
}: {
  spec: TabSpec;
  active: boolean;
  onClick: () => void;
}) {
  const danger = spec.tone === 'danger';
  // Per DESIGN.md §06.7 — flat tab pill. No always-on border; the active
  // state is the var(--t-input-bg) fill alone. Danger gets a red text +
  // count color so a failing checks tab still reads loud even when it
  // isn't selected; no red border outline.
  const background = active ? 'var(--t-input-bg)' : 'transparent';
  const labelColor = danger
    ? '#ef4444'
    : active
      ? 'var(--t-text)'
      : 'var(--t-text-muted)';
  const countColor = danger
    ? '#ef4444'
    : active
      ? 'var(--t-text-muted)'
      : 'var(--t-text-faint)';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 26,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 7,
        borderWidth: 0,
        background,
        color: labelColor,
        cursor: 'pointer',
        fontFamily: UI_FONT,
        fontSize: 11,
        fontWeight: 350,
        letterSpacing: '-0.1px',
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(e) => {
        if (!active && !danger) e.currentTarget.style.background = 'var(--t-hover)';
      }}
      onMouseLeave={(e) => {
        if (!active && !danger) e.currentTarget.style.background = 'transparent';
      }}
    >
      {spec.leading}
      <span>{spec.label}</span>
      {spec.count !== null ? (
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: countColor,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {spec.count}
        </span>
      ) : null}
      {spec.trailing}
    </button>
  );
}
