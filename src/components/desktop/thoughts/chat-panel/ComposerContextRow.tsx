'use client';

import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { RepoTargetChip } from '../InputButtons';

export function ComposerContextRow({
  repoLabel,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  onAddProject,
  showRepoTarget = true,
  contextLocationSlot,
}: {
  repoLabel?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
  onAddProject?: () => void;
  showRepoTarget?: boolean;
  contextLocationSlot?: React.ReactNode;
}) {
  if (!showRepoTarget && !contextLocationSlot) return null;

  return (
    <div
      data-o8-composer-context-row=""
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        minHeight: 28,
        paddingTop: 4,
        paddingRight: 4,
        paddingBottom: 0,
        paddingLeft: 4,
        color: 'var(--t-text-muted)',
      }}
    >
      <div
        data-o8-composer-context-controls=""
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 6,
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        {showRepoTarget ? <RepoTargetChip
          repoLabel={repoLabel}
          workspaceTargets={workspaceTargets}
          selectedRepoPath={selectedRepoPath}
          onSelectRepoPath={onSelectRepoPath}
          onAddProject={onAddProject}
        /> : null}
        {contextLocationSlot}
      </div>
      <div style={{ flex: 1, minWidth: 0 }} />
      <div data-o8-composer-status-slot="" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }} />
    </div>
  );
}
