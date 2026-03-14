'use client';

import type { TokenUsageSummaryProps } from './types';

export function TokenUsageSummary({ snapshot, onViewCosts }: TokenUsageSummaryProps) {
  const tracked = snapshot.sessions.filter((session) => session.runtime === 'openclaw' && session.tokenUsage);
  const total = tracked.reduce((sum, session) => sum + (session.tokenUsage?.totalTokens ?? 0), 0);
  const cap = tracked.reduce(
    (sum, session) => sum + (session.tokenUsage?.totalTokens ?? 0) + (session.tokenUsage?.remainingTokens ?? 0),
    0,
  );
  const pct = cap > 0 ? Math.round((total / cap) * 100) : 0;

  if (!tracked.length) {
    return null;
  }

  return (
    <button
      type="button"
      className="remodex-costs-summary-card"
      onClick={onViewCosts}
    >
      <div className="remodex-costs-summary-left">
        <span className="remodex-costs-summary-kicker">
          Token Usage · {tracked.length} session{tracked.length === 1 ? '' : 's'}
        </span>
        <strong className="remodex-costs-summary-value">
          {total.toLocaleString()} <span className="remodex-costs-summary-unit">tokens</span>
        </strong>
      </div>
      <div className="remodex-costs-summary-right">
        <div className="remodex-costs-summary-ring">
          <svg viewBox="0 0 36 36" className="remodex-costs-ring-svg">
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke="#f5f5f7"
              strokeWidth="3"
            />
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke={pct >= 75 ? '#ff3b30' : pct >= 50 ? '#ff9f0a' : '#34c759'}
              strokeWidth="3"
              strokeDasharray={`${pct}, 100`}
              strokeLinecap="round"
            />
          </svg>
          <span className="remodex-costs-ring-label">{pct}%</span>
        </div>
      </div>
    </button>
  );
}
