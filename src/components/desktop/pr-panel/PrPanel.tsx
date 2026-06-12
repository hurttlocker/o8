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
import { O8ScratchChat } from '../o8-panel/workspace-rail/O8ScratchChat';
import { ArtifactStrip } from '../artifacts/ArtifactStrip';
import { useArtifacts } from '../artifacts/useArtifacts';
import type { PrPanelProps, PrTabId } from './types';

export const PrPanel = memo(function PrPanel({ prNumber, repoSlug, repoPath, onClose }: PrPanelProps) {
  const { detail, loading, error } = usePrDetail(prNumber, repoSlug);
  const [activeTab, setActiveTab] = useState<PrTabId>('changes');
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  // Visual proof (#1147): an agent's before/after stills for this PR, if any.
  // The strip self-hides when empty, so it only appears on PRs whose packet
  // captured proof.
  const { artifacts } = useArtifacts({ prNumber });

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
        url={detail.url}
        actions={(
          <O8ScratchChat
            surfaceLabel="pull requests"
            repoPath={repoPath ?? null}
            selectedFile={null}
            surface="diff"
            placement="review-toolbar"
          />
        )}
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
          <>
            {artifacts.length > 0 ? (
              <div style={{ paddingTop: 12, paddingBottom: 8, paddingLeft: 14, paddingRight: 14 }}>
                <ArtifactStrip artifacts={artifacts} />
              </div>
            ) : null}
            <ChangesTab
              files={detail.files}
              totalAdditions={detail.additions}
              totalDeletions={detail.deletions}
            />
          </>
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
