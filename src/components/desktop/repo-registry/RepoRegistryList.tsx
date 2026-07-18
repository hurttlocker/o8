'use client';

import { toast } from '@/components/shared/ConfirmToastHost';

import { memo } from 'react';
import {
  AlertCircle,
  FolderOpen,
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
  expandedRepoIds: Set<string>;
  setExpandedRepoIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  activeRepoLocalPath?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceTabKind?: 'terminal' | 'chat' | 'llm-chat' | 'canvas' | 'orchestrator' | null;
  onFocusOrchestratorTab?: () => void;
  onFocusAssistantTab?: () => void;
  onSelectRepo?: (repoId: string) => void;
  /** Used to populate the right-click "Move to →" menu on each repo card. */
  projectsForMove?: Array<{ id: string; name: string }>;
  currentProjectId?: string | null;
  onMoveRepoToProject?: (repoLocalPath: string, targetProjectId: string) => void | Promise<void>;
  /** Display label for the active project. Used in the empty-state hint
   *  ("No repos in {name} yet") so the operator knows which scope is empty. */
  activeProjectName?: string | null;
  /** Total count of repos in the registry, ignoring the current project
   *  filter. When this is > 0 but the filtered list is empty, the empty
   *  state nudges the operator toward dragging from another project. */
  totalReposInRegistry?: number;
  /** Repos that exist in other projects (not the active one). The empty
   *  state lists these as quick-pick targets so the operator can pull them
   *  into the active project without dragging or right-clicking. */
  reposInOtherProjects?: Array<{
    repoName: string;
    repoLocalPath: string;
    projectName: string;
    projectColor?: string;
  }>;
  /** Open the add-repo modal scoped to the active project. Called by the
   *  empty-state primary button. */
  onAddRepoToActiveProject?: () => void;
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
  expandedRepoIds,
  setExpandedRepoIds,
  activeRepoLocalPath = null,
  activeWorkspacePath = null,
  activeWorkspaceTabKind = null,
  onFocusOrchestratorTab,
  onFocusAssistantTab,
  onSelectRepo,
  projectsForMove,
  currentProjectId = null,
  onMoveRepoToProject,
  activeProjectName,
  totalReposInRegistry,
  reposInOtherProjects = [],
  onAddRepoToActiveProject,
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
              fontFamily: 'var(--font-sans-system)',
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
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                paddingTop: 40,
                paddingBottom: 12,
                paddingLeft: 20,
                paddingRight: 20,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--t-text-secondary)',
                  letterSpacing: '-0.01em',
                  lineHeight: 1.3,
                }}
              >
                No repos yet
              </div>
              <div
                style={{
                  marginTop: 4,
                  maxWidth: 220,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: 'var(--t-text-faint)',
                  letterSpacing: '-0.005em',
                }}
              >
                Click <span style={{ color: 'var(--t-text-muted)', fontWeight: 600 }}>+</span> to add a local Git repository.
              </div>
            </div>
          ) : null}

          {!loading && !loadError && orderedRepos.length === 0 && (totalReposInRegistry ?? 0) > 0 ? (
            <>
              {/* Centered intro + primary CTA. */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  textAlign: 'center',
                  paddingTop: 28,
                  paddingBottom: 0,
                  paddingLeft: 14,
                  paddingRight: 14,
                  gap: 4,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--t-text-secondary)',
                    letterSpacing: '-0.01em',
                    lineHeight: 1.3,
                  }}
                >
                  {activeProjectName ? `${activeProjectName} has no repos` : 'This project has no repos'}
                </div>
                <div
                  style={{
                    maxWidth: 260,
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: 'var(--t-text-faint)',
                    letterSpacing: '-0.005em',
                  }}
                >
                  Add a new repo, or pull one from another project below.
                </div>

                {onAddRepoToActiveProject ? (
                  <button
                    type="button"
                    onClick={onAddRepoToActiveProject}
                    style={{
                      marginTop: 12,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      paddingTop: 5,
                      paddingBottom: 5,
                      paddingLeft: 12,
                      paddingRight: 14,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: 'var(--t-input-border, var(--t-divider))',
                      background: 'var(--t-input-bg, transparent)',
                      color: 'var(--t-text)',
                      cursor: 'pointer',
                      fontSize: 11.5,
                      fontWeight: 600,
                      letterSpacing: '-0.005em',
                      fontFamily: 'var(--font-sans-system)',
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover, rgba(148,163,184,0.12))'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--t-input-bg, transparent)'; }}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="M6 1.5 V10.5 M1.5 6 H10.5" />
                    </svg>
                    Add a repo
                  </button>
                ) : null}
              </div>

              {/* Cross-project list — left-aligned so the F in
                  "FROM OTHER PROJECTS" lands directly under the U in the
                  active project label above. Math:
                    parent marginLeft -14 (RepoCards bleed to the edge)
                    + 14 to neutralize that
                    + 14 to match the project label's panel inset
                    + 12 (dot 6 + gap 6) to skip past the project's color dot
                    = 40px paddingLeft. */}
              {reposInOtherProjects.length > 0 ? (
                <div
                  style={{
                    marginTop: 22,
                    paddingLeft: 40,
                    paddingRight: 28,
                    paddingBottom: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.12em',
                      textTransform: 'uppercase',
                      color: 'var(--t-text-faint)',
                      paddingBottom: 2,
                    }}
                  >
                    From other projects
                  </div>
                  {reposInOtherProjects.map((entry) => (
                    <button
                      key={entry.repoLocalPath}
                      type="button"
                      onClick={() => onMoveRepoToProject?.(entry.repoLocalPath, currentProjectId ?? '')}
                      disabled={!onMoveRepoToProject || !currentProjectId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        width: '100%',
                        paddingTop: 6,
                        paddingBottom: 6,
                        paddingLeft: 10,
                        paddingRight: 10,
                        borderRadius: 7,
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: 'var(--t-divider-subtle)',
                        background: 'transparent',
                        color: 'var(--t-text)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'var(--font-sans-system)',
                      }}
                      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover, rgba(148,163,184,0.08))'; }}
                      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                        {entry.projectColor ? (
                          <span
                            aria-hidden
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              background: entry.projectColor,
                              flexShrink: 0,
                            }}
                          />
                        ) : null}
                        <span
                          style={{
                            fontSize: 11.5,
                            fontWeight: 500,
                            letterSpacing: '-0.005em',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {entry.repoName}
                        </span>
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: 'var(--t-text-faint)',
                          letterSpacing: '-0.005em',
                          flexShrink: 0,
                        }}
                      >
                        {entry.projectName}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {!loading && !loadError ? (
            orderedRepos.map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                workspaceNotice={workspaceNotice[repo.id] ?? null}
                onLaunchAgent={(targetRepo) => {
                  void launchIntoWorkspace(targetRepo).catch((error) => {
                    toast(error instanceof Error ? error.message : 'Unable to launch workspace agent.');
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
                expanded={repo.readiness?.state !== 'missing' && expandedRepoIds.has(repo.id)}
                onToggle={() => setExpandedRepoIds((prev) => {
                  if (repo.readiness?.state === 'missing') return prev;
                  const next = new Set(prev);
                  if (next.has(repo.id)) next.delete(repo.id);
                  else next.add(repo.id);
                  return next;
                })}
                onSelectRepo={() => onSelectRepo?.(repo.id)}
                isActive={repo.localPath === activeRepoLocalPath}
                activeWorkspacePath={activeWorkspacePath}
                activeWorkspaceTabKind={activeWorkspaceTabKind}
                onFocusOrchestratorTab={onFocusOrchestratorTab}
                onFocusAssistantTab={onFocusAssistantTab}
                projectsForMove={projectsForMove}
                currentProjectId={currentProjectId}
                onMoveToProject={onMoveRepoToProject}
              />
            ))
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export const RepoRegistryList = memo(RepoRegistryListBase);
