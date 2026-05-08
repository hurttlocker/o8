'use client';

import { memo, useMemo, useState } from 'react';
import { PrPanelHeader } from './PrPanelHeader';
import { PrPanelTitle } from './PrPanelTitle';
import { PrPanelTabs } from './PrPanelTabs';
import { ChangesTab } from './tabs/ChangesTab';
import { ChecksTab } from './tabs/ChecksTab';
import { CommitsTab } from './tabs/CommitsTab';
import { ReviewsTab } from './tabs/ReviewsTab';
import { usePrDetail } from './usePrDetail';
import type { PrPanelProps, PrTabId } from './types';

export const PrPanel = memo(function PrPanel({ prNumber, repoSlug, onClose }: PrPanelProps) {
  const { detail, loading, error } = usePrDetail(prNumber, repoSlug);
  const [activeTab, setActiveTab] = useState<PrTabId>('changes');
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  const counts = useMemo(() => {
    if (!detail) return { changes: 0, checksTotal: 0, checksFailing: 0, reviews: 0 };
    const checksTotal = detail.statusCheckRollup.length;
    const checksFailing = detail.statusCheckRollup.filter((check) => {
      const conclusion = (check.conclusion ?? '').toLowerCase();
      return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required' || conclusion === 'startup_failure';
    }).length;
    return {
      changes: detail.files.length,
      checksTotal,
      checksFailing,
      reviews: detail.reviewComments.length + detail.issueComments.length,
    };
  }, [detail]);

  const hasReviewerRequest = useMemo(() => {
    if (!detail) return false;
    return (detail.reviewDecision ?? '').toUpperCase() === 'CHANGES_REQUESTED';
  }, [detail]);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--t-panel)',
    color: 'var(--t-text)',
    minHeight: 0,
  };

  if (loading && !detail) {
    return (
      <div style={containerStyle}>
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
          Loading PR #{prNumber}...
        </div>
      </div>
    );
  }

  if (error && !detail) {
    return (
      <div style={containerStyle}>
        <div style={{ padding: 16, fontSize: 12, color: '#ef4444' }}>{error}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div style={containerStyle}>
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
          PR #{prNumber} not available.
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <PrPanelHeader
        prNumber={detail.number}
        state={detail.state}
        baseRefName={detail.baseRefName}
        headRefName={detail.headRefName}
        onClose={onClose}
      />
      <PrPanelTitle
        title={detail.title}
        prNumber={detail.number}
        body={detail.body}
        expanded={summaryExpanded}
        onToggle={() => setSummaryExpanded((current) => !current)}
      />
      <PrPanelTabs
        activeTab={activeTab}
        onChange={setActiveTab}
        changesCount={counts.changes}
        checksTotal={counts.checksTotal}
        checksFailing={counts.checksFailing}
        commitsCount={null}
        reviewsCount={counts.reviews}
        hasReviewerRequest={hasReviewerRequest}
      />
      <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {activeTab === 'changes' ? (
          <ChangesTab
            files={detail.files}
            totalAdditions={detail.additions}
            totalDeletions={detail.deletions}
          />
        ) : null}
        {activeTab === 'checks' ? <ChecksTab checks={detail.statusCheckRollup} /> : null}
        {activeTab === 'commits' ? <CommitsTab prNumber={detail.number} /> : null}
        {activeTab === 'reviews' ? (
          <ReviewsTab
            reviewComments={detail.reviewComments}
            issueComments={detail.issueComments}
            reviewDecision={detail.reviewDecision}
          />
        ) : null}
      </div>
    </div>
  );
});

export type { PrPanelProps } from './types';
