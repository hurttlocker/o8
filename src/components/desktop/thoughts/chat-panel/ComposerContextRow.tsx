'use client';

import { useRef, useState } from 'react';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { RepoTargetChip } from '../InputButtons';
import { ComposerPopover } from './ComposerPopover';
import type { ThoughtsChatPermissionMode } from './types';

export function ComposerContextRow({
  repoLabel,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  onAddProject,
  permissionMode,
  onPermissionModeChange,
  contextLocationSlot,
}: {
  repoLabel?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  selectedRepoPath?: string | null;
  onSelectRepoPath?: (next: string) => void;
  onAddProject?: () => void;
  permissionMode?: ThoughtsChatPermissionMode;
  onPermissionModeChange?: (mode: ThoughtsChatPermissionMode) => void;
  contextLocationSlot?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
      <RepoTargetChip
        repoLabel={repoLabel}
        workspaceTargets={workspaceTargets}
        selectedRepoPath={selectedRepoPath}
        onSelectRepoPath={onSelectRepoPath}
        onAddProject={onAddProject}
      />
      {contextLocationSlot}
      <div style={{ flex: 1, minWidth: 0 }} />
      {permissionMode && onPermissionModeChange ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`Permissions: ${permissionMode === 'full' ? 'Full access' : 'Plan only'}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 24,
              paddingTop: 0,
              paddingRight: 6,
              paddingBottom: 0,
              paddingLeft: 6,
              borderWidth: 0,
              borderRadius: 7,
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              fontSize: 10.5,
              fontWeight: 300,
              fontFamily: 'var(--font-sans-system)',
              whiteSpace: 'nowrap',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            {permissionMode === 'full' ? 'Full access' : 'Plan only'}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end">
            <div role="menu" aria-label="Permissions for next message" style={{ width: 232, padding: 5, borderRadius: 10, border: '1px solid var(--t-border)', background: 'var(--t-popover-surface)', boxShadow: 'var(--t-panel-shadow)' }}>
              {([
                { mode: 'full', label: 'Full access', detail: 'Can edit files and run actions' },
                { mode: 'plan', label: 'Plan only', detail: 'Inspect and propose without edits' },
              ] as const).map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={permissionMode === option.mode}
                  onClick={() => { onPermissionModeChange(option.mode); setOpen(false); }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%', paddingTop: 7, paddingRight: 9, paddingBottom: 7, paddingLeft: 9, borderWidth: 0, borderRadius: 7, background: permissionMode === option.mode ? 'var(--t-accent-soft)' : 'transparent', color: 'var(--t-text)', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans-system)' }}
                >
                  <span style={{ fontSize: 11.5, fontWeight: 400 }}>{option.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{option.detail}</span>
                </button>
              ))}
            </div>
          </ComposerPopover>
        </>
      ) : null}
      <div data-o8-composer-status-slot="" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }} />
    </div>
  );
}
