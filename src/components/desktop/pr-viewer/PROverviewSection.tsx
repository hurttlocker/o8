'use client';

import React, { memo } from 'react';
import { MarkdownBody } from '../MarkdownBody';
import type { PRDetail } from './types';

interface PROverviewSectionProps {
  pr: PRDetail;
}

function PROverviewSectionBase({ pr }: PROverviewSectionProps) {
  const ciChecks = pr.statusCheckRollup ?? [];
  const passedChecks = ciChecks.filter(c => c.conclusion === 'SUCCESS' || c.conclusion === 'success').length;
  const reviews = pr.reviews ?? [];

  return (
    <div>
      {/* CI Status */}
      {ciChecks.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            CI Checks ({passedChecks}/{ciChecks.length} passed)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ciChecks.map((check, i) => {
              const passed = check.conclusion === 'SUCCESS' || check.conclusion === 'success';
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ color: passed ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                    {passed ? '\u2713' : '\u2717'}
                  </span>
                  <span style={{ color: 'var(--t-text-strong)' }}>{check.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Reviews */}
      {reviews.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Reviews
          </div>
          {reviews.map((review, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
              <span style={{
                color: review.state === 'APPROVED' ? '#22c55e' : review.state === 'CHANGES_REQUESTED' ? '#ef4444' : '#f59e0b',
                fontWeight: 600,
              }}>
                {review.state === 'APPROVED' ? '\u2713' : review.state === 'CHANGES_REQUESTED' ? '\u2717' : '\u25CB'}
              </span>
              <span style={{ color: 'var(--t-text-strong)' }}>{review.author.login}</span>
              <span style={{ color: 'var(--t-text-muted)' }}>{review.state.toLowerCase().replace('_', ' ')}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Labels */}
      {pr.labels.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {pr.labels.map((label) => (
            <span key={label.name} style={{
              fontSize: 11,
              fontWeight: 600,
              paddingTop: 2,
              paddingRight: 8,
              paddingBottom: 2,
              paddingLeft: 8,
              borderRadius: 99,
              color: `#${label.color}`,
              background: `#${label.color}10`,
              border: `1px solid #${label.color}25`,
            }}>
              {label.name}
            </span>
          ))}
        </div>
      ) : null}

      {/* Body */}
      {pr.body ? (
        <div style={{ marginTop: 8 }}>
          <MarkdownBody text={pr.body} />
        </div>
      ) : (
        <div style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>No description provided</div>
      )}
    </div>
  );
}

export const PROverviewSection = memo(PROverviewSectionBase);
