/**
 * WorktreeActions — Merge/PR/Discard actions for completed worktree sessions.
 *
 * Appears in the agent pill when an agent session completes with dirty files.
 * Three actions: Create PR, Merge to main, Discard.
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/67
 * @see https://github.com/hurttlocker/cortex-ide/issues/70
 */

import { memo, useCallback, useState } from 'react';
import type { WorktreeInfo, MergeResult } from '@/lib/worktree/types';

interface WorktreeActionsProps {
  worktree: WorktreeInfo;
  repoRoot: string;
  onResult: (result: MergeResult) => void;
}

type ActionType = 'pr' | 'merge' | 'discard';

export const WorktreeActions = memo(function WorktreeActions({
  worktree,
  repoRoot,
  onResult,
}: WorktreeActionsProps) {
  const [loading, setLoading] = useState<ActionType | null>(null);
  const [confirmed, setConfirmed] = useState<ActionType | null>(null);

  const handleAction = useCallback(async (action: ActionType) => {
    // Discard requires confirmation
    if (action === 'discard' && confirmed !== 'discard') {
      setConfirmed('discard');
      return;
    }

    setLoading(action);
    setConfirmed(null);

    try {
      const res = await fetch('/api/worktrees/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: repoRoot,
          worktreeId: worktree.id,
          action,
        }),
      });

      const result = (await res.json()) as MergeResult;
      onResult(result);
    } catch (err) {
      onResult({
        action,
        ok: false,
        note: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setLoading(null);
    }
  }, [worktree.id, repoRoot, onResult, confirmed]);

  const fileCount = worktree.dirtyFiles.length;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        marginTop: '6px',
        padding: '8px',
        borderRadius: '10px',
        backgroundColor: 'rgba(255,255,255,0.04)',
      }}
    >
      {/* Status line */}
      <div
        style={{
          fontSize: '11px',
          color: '#34c759',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <span>✓</span>
        <span>Done — {fileCount} file{fileCount !== 1 ? 's' : ''} changed</span>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
        <button
          type="button"
          onClick={() => handleAction('pr')}
          disabled={loading !== null}
          style={{
            padding: '6px 0',
            borderRadius: '8px',
            backgroundColor: '#007aff',
            border: 'none',
            color: '#fff',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
            opacity: loading === 'pr' ? 0.6 : loading ? 0.4 : 1,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {loading === 'pr' ? '…' : 'Create PR'}
        </button>

        <button
          type="button"
          onClick={() => handleAction('merge')}
          disabled={loading !== null}
          style={{
            padding: '6px 0',
            borderRadius: '8px',
            backgroundColor: '#34c759',
            border: 'none',
            color: '#fff',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
            opacity: loading === 'merge' ? 0.6 : loading ? 0.4 : 1,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {loading === 'merge' ? '…' : 'Merge'}
        </button>

        <button
          type="button"
          onClick={() => handleAction('discard')}
          disabled={loading !== null}
          style={{
            padding: '6px 0',
            borderRadius: '8px',
            backgroundColor: confirmed === 'discard' ? '#ff3b30' : 'rgba(255,59,48,0.15)',
            border: 'none',
            color: confirmed === 'discard' ? '#fff' : '#ff3b30',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
            opacity: loading === 'discard' ? 0.6 : loading ? 0.4 : 1,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {loading === 'discard' ? '…' : confirmed === 'discard' ? 'Confirm' : 'Discard'}
        </button>
      </div>
    </div>
  );
});
