'use client';

import { memo } from 'react';
import { RefreshCw } from 'lucide-react';
import type { BoardToolbarProps } from './types';
import { compactPath, toolbarButtonStyle } from './utils';
import { MetricChip } from './shared';

function BoardToolbarBase({
  repoName,
  repoPath,
  snapshot,
  refreshing,
  backlogIssueCount,
  onRefresh,
}: BoardToolbarProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 14,
      flexWrap: 'wrap',
    }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
          Cortex Board
        </div>
        <div style={{ marginTop: 4, fontSize: 18, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)' }}>
          {repoName || compactPath(repoPath) || 'Current repository'}
        </div>
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Repo issues feed the backlog. Starting an issue creates a real Cortex task, worktree, and review lane.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <MetricChip label="Startable" value={snapshot?.startableTaskIds.length ?? 0} tone="blue" />
        <MetricChip label="Running" value={snapshot?.columns.find((column) => column.id === 'in_progress')?.tasks.length ?? 0} tone="orange" />
        <MetricChip label="Review" value={snapshot?.columns.find((column) => column.id === 'review')?.tasks.length ?? 0} tone="green" />
        <button
          type="button"
          onClick={onRefresh}
          style={toolbarButtonStyle(Boolean(refreshing))}
        >
          <RefreshCw size={14} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />
          Refresh
        </button>
      </div>
    </div>
  );
}

export const BoardToolbar = memo(BoardToolbarBase);
