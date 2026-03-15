/**
 * WorktreeBadge — Inline worktree indicator for agent pills in squad panel.
 *
 * Shows: branch name, dirty file count, conflict warning.
 * Designed to be compact — fits inside the existing agent pill layout.
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/67
 */

import { memo } from 'react';
import type { WorktreeInfo } from '@/lib/worktree/types';

interface WorktreeBadgeProps {
  worktree: WorktreeInfo;
  hasConflict?: boolean;
}

export const WorktreeBadge = memo(function WorktreeBadge({ worktree, hasConflict }: WorktreeBadgeProps) {
  const branchShort = worktree.branch
    .replace(/^worktree\/[^/]+\//, '')
    .slice(0, 24);

  const fileCount = worktree.dirtyFiles.length;
  const statusColor = worktree.status === 'active'
    ? '#34c759'
    : worktree.status === 'stale'
      ? '#8e8e93'
      : '#007aff';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        marginTop: '2px',
        fontSize: '10px',
        letterSpacing: '-0.01em',
        lineHeight: 1,
        color: '#8e8e93',
      }}
    >
      {/* Git branch icon (inline SVG for zero deps) */}
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <circle cx="5" cy="4" r="1.5" stroke="#8e8e93" strokeWidth="1.5" fill="none" />
        <circle cx="5" cy="12" r="1.5" stroke="#8e8e93" strokeWidth="1.5" fill="none" />
        <circle cx="11" cy="6" r="1.5" stroke={statusColor} strokeWidth="1.5" fill="none" />
        <line x1="5" y1="5.5" x2="5" y2="10.5" stroke="#8e8e93" strokeWidth="1.5" />
        <path d="M5 7.5 C5 7.5 7 6 11 6" stroke="#8e8e93" strokeWidth="1.5" fill="none" />
      </svg>

      <span style={{ color: '#b0b0b0', maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {branchShort}
      </span>

      {fileCount > 0 ? (
        <span
          style={{
            color: statusColor,
            fontWeight: 600,
            fontSize: '9px',
          }}
        >
          {fileCount} {fileCount === 1 ? 'file' : 'files'}
        </span>
      ) : null}

      {hasConflict ? (
        <span
          title="Conflicts with another agent's worktree"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '2px',
            color: '#ff9f0a',
            fontWeight: 600,
            fontSize: '9px',
          }}
        >
          <span
            style={{
              width: '5px',
              height: '5px',
              borderRadius: '50%',
              backgroundColor: '#ff9f0a',
              flexShrink: 0,
            }}
          />
          conflict
        </span>
      ) : null}
    </div>
  );
});
