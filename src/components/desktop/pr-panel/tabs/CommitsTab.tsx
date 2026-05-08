'use client';

import { memo } from 'react';

interface CommitsTabProps {
  // Commits aren't surfaced by /api/panel/prs/[number] yet — placeholder until
  // a follow-up endpoint is added. We render a simple "not yet available" stub
  // so the tab renders without errors.
  prNumber: number;
}

export const CommitsTab = memo(function CommitsTab({ prNumber }: CommitsTabProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingTop: 14,
        paddingBottom: 14,
        paddingLeft: 14,
        paddingRight: 14,
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--t-text)', fontWeight: 600 }}>
        Commits
      </div>
      <div style={{ fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>
        Commit history for PR #{prNumber} is not yet wired into this panel. The
        upstream API needs a follow-up endpoint to expose commits.
      </div>
    </div>
  );
});
