'use client';

import { memo } from 'react';
import { Eye, XCircle } from '../lucide-shims';
import type { PrTabId } from './types';

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
        alignItems: 'stretch',
        gap: 0,
        paddingLeft: 14,
        paddingRight: 14,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        const danger = tab.tone === 'danger';
        const color = danger
          ? '#ef4444'
          : active
            ? 'var(--t-text)'
            : 'var(--t-text-muted)';
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 10,
              paddingRight: 10,
              border: 'none',
              background: 'transparent',
              color,
              fontSize: 12,
              fontWeight: active ? 700 : 500,
              cursor: 'pointer',
              borderBottom: active
                ? `2px solid ${danger ? '#ef4444' : 'var(--t-text)'}`
                : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {tab.leading}
            <span>{tab.label}</span>
            {tab.count !== null ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: danger ? '#ef4444' : 'var(--t-text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {tab.count}
              </span>
            ) : null}
            {tab.trailing}
          </button>
        );
      })}
    </div>
  );
});
