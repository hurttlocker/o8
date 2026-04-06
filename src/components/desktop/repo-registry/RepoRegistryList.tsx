'use client';

import { memo } from 'react';
import {
  AlertCircle,
  FolderOpen,
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_BG_CARD,
  THEME_PANEL_GLASS,
  type BranchAgent,
  type OrchestratorPacket,
  type RepoRegistryEntry,
  type RepoSetupConfig,
  type WorkspaceCreateResult,
} from './shared';
import { RepoCard } from './RepoCard';

interface RepoRegistryListProps {
  hideHeader: boolean;
  reposOpen: boolean;
  loading: boolean;
  reposCount: number;
  loadError: string | null;
  showEmptyState: boolean;
  orderedRepos: RepoRegistryEntry[];
  workspaceNotice: Record<string, WorkspaceCreateResult>;
  onToggleOpen: () => void;
  launchIntoWorkspace: (repo: RepoRegistryEntry) => Promise<void>;
  openWorkspaceModal: (repo: RepoRegistryEntry) => void;
  handleOpenGitHub: (repo: RepoRegistryEntry) => void;
  setRemoveTarget: (repo: RepoRegistryEntry | null) => void;
  handleSaveSetup: (repoId: string, setup: RepoSetupConfig) => Promise<void>;
  onSelectSession?: (sessionKey: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  activeSessionKey?: string | null;
  effectiveAgentBranchMap: Map<string, Map<string, BranchAgent[]>>;
  orchestratorPackets?: OrchestratorPacket[];
  portsByRepo: Map<string, number[]>;
  expandedRepoId: string | null;
  setExpandedRepoId: React.Dispatch<React.SetStateAction<string | null>>;
  activeRepoLocalPath?: string | null;
  activeWorkspacePath?: string | null;
}

function RepoRegistryListBase({
  hideHeader,
  reposOpen,
  loading,
  reposCount,
  loadError,
  showEmptyState,
  orderedRepos,
  workspaceNotice,
  onToggleOpen,
  launchIntoWorkspace,
  openWorkspaceModal,
  handleOpenGitHub,
  setRemoveTarget,
  handleSaveSetup,
  onSelectSession,
  onSelectPR,
  onReviewPR,
  activeSessionKey,
  effectiveAgentBranchMap,
  orchestratorPackets = [],
  portsByRepo,
  expandedRepoId,
  setExpandedRepoId,
  activeRepoLocalPath = null,
  activeWorkspacePath = null,
}: RepoRegistryListProps) {
  return (
    <>
      {!hideHeader ? (
        <div style={{ flexShrink: 0, paddingLeft: 14, paddingRight: 14, paddingTop: 0, paddingBottom: 0 }}>
          <button
            type="button"
            onClick={onToggleOpen}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 2px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <FolderOpen size={12} strokeWidth={2} color={reposOpen ? '#ef4444' : 'var(--t-text-muted)'} />
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: reposOpen ? 'var(--t-text)' : 'var(--t-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Repositories
            </span>
            <span
              style={{
                fontSize: 10,
                color: 'var(--t-text-faint)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}
            >
              {loading ? (
                <span
                  style={{
                    display: 'inline-flex',
                    width: 16,
                    height: 10,
                    borderRadius: 999,
                    background: 'linear-gradient(90deg, rgba(148,163,184,0.14), rgba(148,163,184,0.28), rgba(148,163,184,0.14))',
                  }}
                />
              ) : reposCount}
            </span>
          </button>
        </div>
      ) : null}

      {reposOpen ? (
        <div
          style={{
            flexShrink: 0,
            marginLeft: hideHeader ? -14 : 0,
            marginRight: hideHeader ? -14 : 0,
            paddingTop: 0,
            paddingRight: hideHeader ? 0 : 14,
            paddingBottom: showEmptyState ? 0 : 8,
            paddingLeft: hideHeader ? 0 : 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
          }}
        >
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingTop: 4 }}>
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  style={{
                    borderBottom: '1px solid var(--t-divider-subtle)',
                    padding: '12px 0 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ width: `${58 + index * 12}%`, height: 12, borderRadius: 999, background: 'var(--t-divider-strong)' }} />
                  <div style={{ width: `${42 + index * 10}%`, height: 10, borderRadius: 999, background: 'var(--t-divider)' }} />
                </div>
              ))}
            </div>
          ) : null}

          {loadError ? (
            <div
              style={{
                padding: '12px 0',
                borderBottom: '1px solid rgba(239, 68, 68, 0.16)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 12,
                color: '#991b1b',
              }}
            >
              <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{loadError}</span>
            </div>
          ) : null}

          {showEmptyState ? (
            <div style={{ padding: '8px 0 2px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '9px 12px',
                  borderRadius: 16,
                  border: '1px solid var(--t-panel-border)',
                  background: `linear-gradient(180deg, ${THEME_PANEL_GLASS} 0%, ${THEME_BG_CARD} 100%)`,
                  boxShadow: '0 10px 24px rgba(4, 8, 14, 0.12), inset 0 1px 0 var(--t-divider-subtle)',
                }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    marginTop: 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 999,
                    background: THEME_ACCENT_SOFT,
                    color: THEME_ACCENT,
                    flexShrink: 0,
                  }}
                >
                  <FolderOpen size={13} strokeWidth={2.1} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 11.5,
                      fontWeight: 650,
                      color: 'var(--t-text)',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    Bring a repo into Cortex
                  </span>
                  <span
                    style={{
                      display: 'block',
                      marginTop: 3,
                      fontSize: 10.5,
                      lineHeight: 1.45,
                      color: 'var(--t-text-faint)',
                    }}
                  >
                    Add a local Git repository with + and launch workspace flows from here.
                  </span>
                </span>
              </div>
            </div>
          ) : null}

          {!loading && !loadError ? (
            orderedRepos.map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                workspaceNotice={workspaceNotice[repo.id] ?? null}
                onLaunchAgent={(targetRepo) => {
                  void launchIntoWorkspace(targetRepo).catch((error) => {
                    window.alert(error instanceof Error ? error.message : 'Unable to launch workspace agent.');
                  });
                }}
                onOpenWorkspace={openWorkspaceModal}
                onOpenGitHub={handleOpenGitHub}
                onRemove={setRemoveTarget}
                onSaveSetup={handleSaveSetup}
                onSelectSession={onSelectSession}
                onSelectPR={onSelectPR}
                onReviewPR={onReviewPR}
                activeSessionKey={activeSessionKey}
                onSelectBranch={() => {
                  // Future: switch conversation context to agent on this branch
                  // For now: could trigger file tree refresh for this branch
                }}
                agentsByBranch={effectiveAgentBranchMap.get(repo.name)}
                orchestratorPackets={orchestratorPackets}
                activePorts={portsByRepo.get(repo.name)}
                expanded={expandedRepoId === repo.id}
                onToggle={() => setExpandedRepoId((current) => current === repo.id ? null : repo.id)}
                isActive={repo.localPath === activeRepoLocalPath}
                activeWorkspacePath={activeWorkspacePath}
              />
            ))
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export const RepoRegistryList = memo(RepoRegistryListBase);
