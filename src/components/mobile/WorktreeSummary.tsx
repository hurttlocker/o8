/**
 * WorktreeSummary — Summary card for all active worktrees in a repo.
 *
 * Shows: active count, total disk, conflict status, prune button.
 * Lives above the squad grid when worktrees are active.
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/67
 */

import { memo, useCallback, useState } from 'react';
import type { WorktreeInfo, ConflictReport } from '@/lib/worktree/types';

interface WorktreeSummaryProps {
  worktrees: WorktreeInfo[];
  conflicts: { safe: boolean; count: number };
  onPrune: () => void | Promise<void>;
  onWorktreeSelect?: (worktreeId: string) => void;
}

const AGENT_COLORS: Record<string, string> = {
  'claude-code': '#cc785c',  // Claude warm orange
  'codex': '#10a37f',        // Codex green
  'openclaw': '#ff3b30',     // OpenClaw red
};

export const WorktreeSummary = memo(function WorktreeSummary({
  worktrees,
  conflicts,
  onPrune,
  onWorktreeSelect,
}: WorktreeSummaryProps) {
  const [pruning, setPruning] = useState(false);
  const [pruneConfirm, setPruneConfirm] = useState(false);

  const active = worktrees.filter((wt) =>
    wt.status === 'active' || wt.status === 'ready' || wt.status === 'setup',
  );

  if (active.length === 0) return null;

  const handlePrune = useCallback(async () => {
    if (!pruneConfirm) {
      setPruneConfirm(true);
      setTimeout(() => setPruneConfirm(false), 3000);
      return;
    }
    setPruning(true);
    setPruneConfirm(false);
    try {
      await onPrune();
    } finally {
      setPruning(false);
    }
  }, [onPrune, pruneConfirm]);

  const totalFiles = active.reduce((sum, wt) => sum + wt.dirtyFiles.length, 0);

  return (
    <div
      style={{
        margin: '0 12px 8px',
        padding: '10px 14px',
        borderRadius: '14px',
        backgroundColor: '#1c1c1e',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="5" cy="4" r="1.5" stroke="#8e8e93" strokeWidth="1.5" fill="none" />
            <circle cx="5" cy="12" r="1.5" stroke="#8e8e93" strokeWidth="1.5" fill="none" />
            <circle cx="11" cy="6" r="1.5" stroke="#34c759" strokeWidth="1.5" fill="none" />
            <line x1="5" y1="5.5" x2="5" y2="10.5" stroke="#8e8e93" strokeWidth="1.5" />
            <path d="M5 7.5 C5 7.5 7 6 11 6" stroke="#8e8e93" strokeWidth="1.5" fill="none" />
          </svg>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: '#e5e5ea',
              letterSpacing: '-0.02em',
            }}
          >
            Worktrees
          </span>
          <span
            style={{
              fontSize: '11px',
              color: '#8e8e93',
              fontWeight: 500,
            }}
          >
            {active.length} active · {totalFiles} files
          </span>
        </div>

        {!conflicts.safe ? (
          <span
            style={{
              fontSize: '10px',
              fontWeight: 600,
              color: '#ff9f0a',
              display: 'flex',
              alignItems: 'center',
              gap: '3px',
            }}
          >
            <span
              style={{
                width: '5px',
                height: '5px',
                borderRadius: '50%',
                backgroundColor: '#ff9f0a',
              }}
            />
            {conflicts.count} conflict{conflicts.count !== 1 ? 's' : ''}
          </span>
        ) : null}
      </div>

      {/* Worktree mini-pills */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          marginBottom: '8px',
        }}
      >
        {active.map((wt) => {
          const color = AGENT_COLORS[wt.agentType] ?? '#8e8e93';
          const label = wt.id.slice(0, 16);

          return (
            <button
              key={wt.id}
              type="button"
              onClick={() => onWorktreeSelect?.(wt.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '3px 8px',
                borderRadius: '8px',
                backgroundColor: 'rgba(255,255,255,0.06)',
                border: 'none',
                cursor: 'pointer',
                fontSize: '10px',
                color: '#e5e5ea',
                letterSpacing: '-0.01em',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: color,
                  flexShrink: 0,
                }}
              />
              {label}
              {wt.dirtyFiles.length > 0 ? (
                <span style={{ color: '#8e8e93' }}>
                  {wt.dirtyFiles.length}f
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Actions row */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          onClick={handlePrune}
          disabled={pruning}
          style={{
            padding: '4px 10px',
            borderRadius: '8px',
            backgroundColor: pruneConfirm ? '#ff3b30' : 'rgba(255,255,255,0.08)',
            border: 'none',
            color: pruneConfirm ? '#fff' : '#8e8e93',
            fontSize: '11px',
            fontWeight: pruneConfirm ? 600 : 500,
            cursor: 'pointer',
            opacity: pruning ? 0.5 : 1,
            transition: 'background-color 0.15s, color 0.15s',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {pruning ? 'Pruning…' : pruneConfirm ? 'Confirm prune' : 'Prune stale'}
        </button>
      </div>
    </div>
  );
});
