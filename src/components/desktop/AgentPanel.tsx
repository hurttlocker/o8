'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- AgentPanel keeps a stable prop surface during the refactor */

import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { Clock } from './lucide-shims';
import { RepoRegistrySection } from './RepoRegistrySection';
import { AgentPanelExtraAgents } from './AgentPanelExtraAgents';
import { LeftPanelRepoFocus } from './repo-focus/LeftPanelRepoFocus';
import { useLeftPanelFocus } from './repo-focus/useLeftPanelFocus';
import { ProjectsBottomBar } from './repo-registry/ProjectsBottomBar';
import { useProjects } from './repo-registry/useProjects';
import {
  AgentPanelEmptyState,
  SidebarSection,
  THEME_ACCENT,
  type AgentPanelProps,
  useAgentPanelState,
} from './agent-panel';

export const AgentPanel = memo(function AgentPanel(props: AgentPanelProps = {}) {
  const {
    activeSessionKey,
    selectedRepo,
    selectedRepoLocalPath,
    activeWorkspacePath,
    onLaunchWorkspaceAgent,
    onLaunchWorkspaceTask,
    onSelectSession,
    onSelectIssue,
    onSelectCommit,
    onSelectPR,
    onReviewPR,
    onRepoRemoved,
    onOpenSpecInWorkspace,
    orchestratorPackets = [],
    orchestratorMissionState,
    registeredRepos = [],
    ideWorkspaceSessions,
    leftPanelFocus: liftedLeftPanelFocus,
  } = props;

  const {
    agents,
    inventoryLoading,
    gatewayReachable,
    gatewayWarming,
    fleetMeta,
    reposOpen,
    setReposOpen,
    repoRegistryState,
    setRepoRegistryState,
    effectiveScopedRepo,
    currentLaunchRepoPath,
    workspacesSummary,
    addRepoIntent,
    titlebarSpacerHeight,
    refreshNow,
    requestAddRepo,
    launchRepoTask,
  } = useAgentPanelState({
    selectedRepo,
    selectedRepoLocalPath,
    onLaunchWorkspaceTask,
    onSelectSession,
    onAgentsUpdate: props.onAgentsUpdate,
  });
  // Prefer the lifted focus state when the dashboard supplies it, so column
  // width and panel content share a single source of truth. Falls back to a
  // local hook for legacy callers that mount AgentPanel without the prop.
  const localLeftPanelFocus = useLeftPanelFocus(registeredRepos);
  const leftPanelFocus = liftedLeftPanelFocus ?? localLeftPanelFocus;
  const focusActive = leftPanelFocus.focusActive;

  // Projects ledger — the bottom-bar dot switcher + the project name header
  // above the repo list. The ledger groups repos and the active project's
  // repoPaths drive what shows in the registry list. First-run defaults to
  // a single "o8" project containing every existing repo.
  const projects = useProjects();
  const activeProjectRepoSet = useMemo(() => {
    if (!projects.activeProject) return null;
    return new Set(projects.activeProject.repoPaths);
  }, [projects.activeProject]);

  // Stable callback so RepoRegistrySection doesn't see a new reference on
  // every render — its useEffect has this in the deps and the section
  // would otherwise call back into here in an infinite loop.
  const refreshProjects = projects.refresh;
  const handleRegistryStateChange = useCallback((state: { loading: boolean; count: number; hasError: boolean }) => {
    setRepoRegistryState(state);
    void refreshProjects();
  }, [refreshProjects, setRepoRegistryState]);

  // When focus is active, the column itself widened — render the focus
  // surface inline so it occupies the whole AgentPanel column and keeps
  // the TitleBar + DesktopStatusBar visible above and below.
  if (focusActive && leftPanelFocus.focusedRepo) {
    return (
      <div
        suppressHydrationWarning
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          // Match the unfocused AgentPanel — transparent over the macOS
          // vibrancy backdrop, no solid paper here. The focused drawer is
          // the same glass surface, just wider.
          background: 'transparent',
        } as CSSProperties}
      >
        <div
          suppressHydrationWarning
          style={{
            height: titlebarSpacerHeight,
            flexShrink: 0,
            WebkitAppRegion: 'drag' as unknown as string,
          } as CSSProperties}
        />
        <LeftPanelRepoFocus
          repo={leftPanelFocus.focusedRepo}
          onBack={leftPanelFocus.clearFocus}
          packets={orchestratorPackets}
          missionState={orchestratorMissionState}
          ideWorkspaceSessions={ideWorkspaceSessions}
          activeSessionKey={activeSessionKey}
          onSelectSession={onSelectSession}
          onSelectFile={props.onSelectFile}
          onOpenSpecInWorkspace={onOpenSpecInWorkspace}
        />
      </div>
    );
  }

  return (
    <div
      suppressHydrationWarning
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'transparent',
      } as CSSProperties}
    >
      <div
        suppressHydrationWarning
        style={{
          height: titlebarSpacerHeight,
          flexShrink: 0,
          WebkitAppRegion: 'drag' as unknown as string,
        } as CSSProperties}
      />

      {projects.activeProject ? (
        <div
          style={{
            flexShrink: 0,
            paddingTop: 4,
            paddingBottom: 6,
            paddingLeft: 14,
            paddingRight: 14,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--t-text-faint)',
          }}
        >
          {projects.activeProject.name}
        </div>
      ) : null}

      <div
        suppressHydrationWarning
        style={{
          flex: 1,
          overflowY: 'auto',
          position: 'relative',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
          paddingTop: titlebarSpacerHeight > 10 ? 2 : 0,
          paddingBottom: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        } as CSSProperties}
        className="hide-scrollbar"
      >
        {/* Workspaces section — the "Workspaces" title and its collapse
            affordance were removed. The repo registry is the only content
            of this panel, so it renders flush without a labelled header. */}
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          {fleetMeta?.mode === 'stale' ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 16,
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.15)',
                fontSize: 11,
                color: '#d97706',
                fontWeight: 600,
              }}
            >
              <Clock size={13} strokeWidth={2} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                Showing cached session state while the gateway reconnects. Live updates resume automatically.
              </span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  border: 'none',
                  borderRadius: 999,
                  background: 'rgba(217, 119, 6, 0.12)',
                  color: '#b45309',
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  flexShrink: 0,
                }}
              >
                Reload
              </button>
            </div>
          ) : gatewayReachable && gatewayWarming ? (
            <div
              style={{
                paddingTop: 14,
                paddingRight: 14,
                paddingBottom: 8,
                paddingLeft: 14,
                fontSize: 11.5,
                fontWeight: 440,
                color: 'var(--t-text-faint)',
                letterSpacing: '-0.005em',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              Loading workspaces...
            </div>
          ) : null}

          <RepoRegistrySection
            repoPathFilter={activeProjectRepoSet}
            projectsForMove={projects.ledger?.projects.map((p) => ({ id: p.id, name: p.name })) ?? []}
            currentProjectId={projects.activeProject?.id ?? null}
            onMoveRepoToProject={async (repoPath, targetId) => {
              await projects.moveRepoToProject(repoPath, targetId);
            }}
            onLaunchComplete={refreshNow}
            onSelectSession={onSelectSession}
            onSelectRepo={(repoId) => {
              leftPanelFocus.focusByRepoId(repoId);
              props.onSelectRepo?.(repoId);
            }}
            onSelectPR={onSelectPR}
            onReviewPR={onReviewPR}
            onRepoRemoved={(repo) => {
              refreshNow();
              void projects.refresh();
              onRepoRemoved?.(repo);
            }}
            onLaunchWorkspaceAgent={onLaunchWorkspaceAgent}
            onRegistryStateChange={handleRegistryStateChange}
            activeSessionKey={activeSessionKey}
            activeRepoLocalPath={currentLaunchRepoPath}
            activeWorkspacePath={activeWorkspacePath ?? selectedRepoLocalPath ?? null}
            activeWorkspaceTabKind={props.activeWorkspaceTabKind ?? null}
            onFocusOrchestratorTab={props.onFocusOrchestratorTab}
            onFocusAssistantTab={props.onFocusAssistantTab}
            sectionOpen={reposOpen}
            onSectionOpenChange={setReposOpen}
            addIntent={addRepoIntent}
            orchestratorPackets={orchestratorPackets}
            ideWorkspaceSessions={ideWorkspaceSessions}
            hideHeader
          />
        </section>

        {/* AgentPanelEmptyState ("No active agents") removed — it tracked
            runtime-discovered CLI sessions, not workspace chat tabs, so it
            was misleading when the user had an Orchestrator or Assistant
            tab open. The repo list above is the primary panel content;
            discovered agent sessions appear inline on branch rows when
            they exist. */}

        {/* #627 fold-in — non-CLI origin agents (MCP, Mobile, Webhook,
            Cloud) grouped by their bound repo, with a final "Other" group
            for cross-repo agents. Renders nothing when absent. */}
        <AgentPanelExtraAgents onSelectSession={onSelectSession} />

        {/* Repo focus is no longer an overlay — when focusActive, the
            AgentPanel returns LeftPanelRepoFocus inline above (the column
            widens). Nothing else to render here. */}

      </div>

      {projects.ledger ? (
        <ProjectsBottomBar
          projects={projects.ledger.projects}
          activeProjectId={projects.ledger.activeProjectId}
          onSwitch={(projectId) => { void projects.switchActive(projectId); }}
          onCreate={projects.createProject}
          onRename={projects.renameProject}
          onDelete={projects.deleteProject}
        />
      ) : null}
    </div>
  );
});
