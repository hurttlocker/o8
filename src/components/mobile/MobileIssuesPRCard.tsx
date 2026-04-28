'use client';

/**
 * Extracted from IssuesPage so that file stays under the repo's 800-line
 * ceiling once the inline diff trigger landed.
 */

import { memo } from 'react';
import { useTheme } from './ThemeContext';

export interface IssuesPagePR {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  state: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  statusCheckRollup: { name: string; status: string; conclusion: string }[];
  reviewDecision: string;
  url: string;
}

export function repoShortLabel(repo: string): string {
  const map: Record<string, string> = {
    '': 'Cortex IDE',
    'hurttlocker/cortex': 'Cortex',
    'LavonTMCQ/spear-production': 'Spear',
    'LavonTMCQ/mybeautifulwife': 'Antiflammi',
  };
  return map[repo] ?? repo.split('/').pop() ?? repo;
}

function checksRollup(checks: { status: string; conclusion: string }[]): { color: string; label: string } {
  if (!checks || checks.length === 0) return { color: '#A09890', label: 'No CI' };
  const failed = checks.some((check) => check.conclusion === 'FAILURE');
  const pending = checks.some((check) => check.status !== 'COMPLETED');
  if (failed) return { color: '#ff453a', label: 'CI Failed' };
  if (pending) return { color: '#ff9f0a', label: 'CI Running' };
  return { color: '#30d158', label: 'CI Passed' };
}

export const MobileIssuesPRCard = memo(function MobileIssuesPRCard({
  pr,
  repo,
  onOpen,
}: {
  pr: IssuesPagePR;
  repo: string;
  onOpen: () => void;
}) {
  const { colors } = useTheme();
  const ci = checksRollup(pr.statusCheckRollup);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onTouchEnd={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      style={{
        width: '100%',
        minHeight: 44,
        padding: '14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        textAlign: 'left',
        display: 'block',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke={colors.blueAccent}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, marginTop: 2 }}
        >
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M13 6h3a2 2 0 0 1 2 2v7" />
          <line x1="6" y1="9" x2="6" y2="21" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, lineHeight: 1.4 }}>{pr.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: colors.textSecondary, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
              #{pr.number}
            </span>
            <span
              style={{
                fontSize: 10,
                color: colors.blueAccent,
                padding: '3px 8px',
                borderRadius: 999,
                background: colors.blueGlass,
                border: `1px solid ${colors.blueGlassBorder}`,
                fontWeight: 600,
              }}
            >
              {repoShortLabel(repo)}
            </span>
            <span style={{ fontSize: 10, color: colors.textSecondary }}>{pr.headRefName}</span>
          </div>
        </div>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: '4px 8px',
            borderRadius: 999,
            background: `${ci.color}18`,
            color: ci.color,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {ci.label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, marginLeft: 22, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: colors.textSecondary }}>{pr.changedFiles} files</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#30d158', fontFamily: '"SF Mono", monospace' }}>
          +{pr.additions}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#ff453a', fontFamily: '"SF Mono", monospace' }}>
          -{pr.deletions}
        </span>
        {pr.reviewDecision ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              marginLeft: 'auto',
              color:
                pr.reviewDecision === 'APPROVED'
                  ? '#30d158'
                  : pr.reviewDecision === 'CHANGES_REQUESTED'
                    ? '#ff453a'
                    : '#ff9f0a',
            }}
          >
            {pr.reviewDecision === 'APPROVED'
              ? 'Approved'
              : pr.reviewDecision === 'CHANGES_REQUESTED'
                ? 'Changes requested'
                : 'Review needed'}
          </span>
        ) : null}
      </div>
    </button>
  );
});
