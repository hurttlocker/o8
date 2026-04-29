'use client';

/**
 * IntentChips — repo + branch chips that appear below the composer
 * once the operator types something into the orchestrator chat (#891).
 *
 * Reads:
 *   - workspaceTargets passed by ThoughtsChatPanel (already loaded
 *     from the registry).
 *   - active branch via fetchPacketBranches (existing helper).
 *
 * Writes:
 *   - selected repo localPath + branch into local state. The composer
 *     is the source of truth for intent text; the chips advise the
 *     orchestrator about scope, but no API mutation fires until send.
 *
 * Style: Issues-style row chips. No native form controls. Theme tokens.
 * Disappears when input is empty (parent gates this via `visible`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { BranchPickerPopover } from '@/components/desktop/thoughts/BranchPickerPopover';

interface IntentChipsProps {
  visible: boolean;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  selectedRepoPath: string | null;
  onSelectRepoPath: (next: string | null) => void;
  selectedBranch: string;
  onSelectBranch: (next: string) => void;
}

export function IntentChips({
  visible,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  selectedBranch,
  onSelectBranch,
}: IntentChipsProps) {
  const [repoOpen, setRepoOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close popovers on outside click.
  useEffect(() => {
    if (!repoOpen && !branchOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (containerRef.current && !containerRef.current.contains(target)) {
        setRepoOpen(false);
        setBranchOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRepoOpen(false);
        setBranchOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [repoOpen, branchOpen]);

  const repoLabel = useMemo(() => {
    const target = workspaceTargets.find((t) => t.localPath === selectedRepoPath);
    return target?.label ?? target?.repoName ?? (selectedRepoPath ? selectedRepoPath.split('/').pop() ?? selectedRepoPath : null);
  }, [selectedRepoPath, workspaceTargets]);

  const handleSelectRepo = useCallback((path: string) => {
    onSelectRepoPath(path);
    setRepoOpen(false);
  }, [onSelectRepoPath]);

  const handleSelectBranch = useCallback((branchName: string) => {
    onSelectBranch(branchName);
    setBranchOpen(false);
  }, [onSelectBranch]);

  if (!visible) return null;

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        paddingTop: 6,
        paddingRight: 14,
        paddingBottom: 6,
        paddingLeft: 14,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        position: 'relative',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--t-text-muted)',
          letterSpacing: '-0.005em',
        }}
      >
        Work on
      </span>
      <ChipButton
        active={repoOpen}
        onClick={() => { setRepoOpen((v) => !v); setBranchOpen(false); }}
        muted={!selectedRepoPath}
      >
        {repoLabel ?? 'choose repo'}
      </ChipButton>
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--t-text-muted)',
          letterSpacing: '-0.005em',
        }}
      >
        off
      </span>
      <ChipButton
        active={branchOpen}
        onClick={() => { setBranchOpen((v) => !v); setRepoOpen(false); }}
        muted={!selectedBranch}
      >
        {selectedBranch || 'main'}
      </ChipButton>

      {/* Repo popover — Issues-style row list, NOT native select. */}
      {repoOpen ? (
        <div
          style={{
            position: 'absolute',
            top: 32,
            left: 56,
            zIndex: 30,
            minWidth: 220,
            maxWidth: 320,
            maxHeight: 240,
            overflowY: 'auto',
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            background: 'var(--t-panel-solid)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
          }}
        >
          {workspaceTargets.length === 0 ? (
            <div style={{ paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, fontSize: 11, color: 'var(--t-text-muted)' }}>
              No repos in registry. Add one from the workspace settings.
            </div>
          ) : (
            workspaceTargets.map((target) => {
              const isSelected = target.localPath === selectedRepoPath;
              return (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => handleSelectRepo(target.localPath)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    paddingTop: 7,
                    paddingRight: 10,
                    paddingBottom: 7,
                    paddingLeft: 10,
                    borderWidth: 0,
                    background: isSelected ? 'var(--t-accent-soft)' : 'transparent',
                    color: isSelected ? 'var(--t-accent)' : 'var(--t-text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '-0.005em' }}>{target.label}</span>
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--t-text-muted)',
                      fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {target.localPath}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}

      {branchOpen ? (
        <BranchPickerPopover
          open
          workspaceTargetPath={selectedRepoPath}
          selectedBranch={selectedBranch}
          onSelect={handleSelectBranch}
          onClose={() => setBranchOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface ChipButtonProps {
  active: boolean;
  onClick: () => void;
  muted?: boolean;
  children: React.ReactNode;
}

function ChipButton({ active, onClick, muted, children }: ChipButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 22,
        paddingTop: 0,
        paddingRight: 8,
        paddingBottom: 0,
        paddingLeft: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: active ? 'var(--t-accent-soft)' : 'var(--t-bg-card)',
        color: muted ? 'var(--t-text-faint)' : (active ? 'var(--t-accent)' : 'var(--t-text)'),
        cursor: 'pointer',
        fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0,
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        maxWidth: 160,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
      <svg width={9} height={9} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden style={{ flexShrink: 0, opacity: 0.7 }}>
        <path d="M2.5 3.5L5 6L7.5 3.5" />
      </svg>
    </button>
  );
}
