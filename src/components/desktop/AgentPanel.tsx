'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- AgentPanel keeps a stable prop surface during the refactor */

import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { RepoRegistrySection } from './RepoRegistrySection';
import { AgentPanelExtraAgents } from './AgentPanelExtraAgents';
import { LeftPanelProjectFocus } from './repo-focus/LeftPanelProjectFocus';
import { ChatsTab } from './repo-focus/tabs/ChatsTab';
import { useLeftPanelProjectFocus } from './repo-focus/useLeftPanelProjectFocus';
import { toRepoFocusRepo, type RepoFocusRepo } from './repo-focus/types';
import { ProjectsBottomBar } from './repo-registry/ProjectsBottomBar';
import { useProjects } from './repo-registry/useProjects';
import {
  AgentPanelEmptyState,
  SidebarSection,
  THEME_ACCENT,
  type AgentPanelProps,
  useAgentPanelState,
} from './agent-panel';

const ORCHESTRATOR_HISTORY_SECTIONS = ['orchestrator'] as const;
const CHAT_HISTORY_SECTIONS = ['chat'] as const;

function repoFocusRepoFromPath(localPath: string): RepoFocusRepo {
  const name = (localPath.split('/').filter(Boolean).pop() ?? localPath) || 'repo';
  return {
    id: `project-path:${localPath}`,
    name,
    localPath,
    remoteUrl: null,
    defaultBranch: 'main',
  };
}

export const AgentPanel = memo(function AgentPanel(props: AgentPanelProps = {}) {
  const {
    activeSessionKey,
    selectedRepo,
    selectedRepoLocalPath,
    activeWorkspacePath,
    onLaunchWorkspaceAgent,
    onLaunchWorkspaceTask,
    onSelectSession,
    onOpenHistoryChat,
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
  // Projects ledger — the bottom-bar dot switcher + the project name header
  // above the repo list. The ledger groups repos and the active project's
  // repoPaths drive what shows in the registry list. First-run defaults to
  // a single "o8" project containing every existing repo.
  const projects = useProjects();

  // Prefer the lifted focus state when the dashboard supplies it, so column
  // width and panel content share a single source of truth. Falls back to a
  // local hook for legacy callers that mount AgentPanel without the prop.
  const localLeftPanelFocus = useLeftPanelProjectFocus({
    registeredRepos,
    ledger: projects.ledger,
  });
  const leftPanelFocus = liftedLeftPanelFocus ?? localLeftPanelFocus;
  const focusActive = leftPanelFocus.active;
  const activeProjectRepoSet = useMemo(() => {
    if (!projects.activeProject) return null;
    return new Set(projects.activeProject.repoPaths);
  }, [projects.activeProject]);
  const activeProjectReposForChats = useMemo(() => {
    const registryByPath = new Map(registeredRepos.map((repo) => [repo.localPath, repo]));
    const projectPaths = projects.activeProject?.repoPaths ?? [];
    if (projectPaths.length > 0) {
      return projectPaths.map((repoPath) => {
        const registeredRepo = registryByPath.get(repoPath);
        return registeredRepo ? toRepoFocusRepo(registeredRepo) : repoFocusRepoFromPath(repoPath);
      });
    }
    return registeredRepos
      .filter((repo) => !activeProjectRepoSet || activeProjectRepoSet.has(repo.localPath))
      .map(toRepoFocusRepo);
  }, [activeProjectRepoSet, projects.activeProject?.repoPaths, registeredRepos]);

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
  if (focusActive && leftPanelFocus.view) {
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
        <LeftPanelProjectFocus
          project={leftPanelFocus.view.project}
          repos={leftPanelFocus.view.repos}
          selectedRepoPath={leftPanelFocus.view.selectedRepo?.localPath ?? null}
          onSelectRepoPath={leftPanelFocus.setSelectedRepoPath}
          onBack={leftPanelFocus.clearFocus}
          packets={orchestratorPackets}
          missionState={orchestratorMissionState}
          ideWorkspaceSessions={ideWorkspaceSessions}
          activeSessionKey={activeSessionKey}
          onSelectSession={onSelectSession}
          onOpenHistoryChat={onOpenHistoryChat}
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
        <button
          type="button"
          onClick={() => leftPanelFocus.focusByProjectId(projects.activeProject!.id)}
          aria-label={`Open project — ${projects.activeProject.name}`}
          title={`Open project — ${projects.activeProject.name}`}
          style={{
            flexShrink: 0,
            paddingTop: 4,
            paddingRight: 14,
            paddingBottom: 6,
            paddingLeft: 14,
            fontFamily: 'var(--font-sans-system)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--t-text-faint)',
            background: 'transparent',
            borderWidth: 0,
            borderRadius: 0,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            alignSelf: 'flex-start',
            gap: 6,
            transition: 'color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-faint)'; }}
        >
          {projects.activeProject.color ? (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: projects.activeProject.color,
                flexShrink: 0,
              }}
            />
          ) : null}
          {projects.activeProject.name}
        </button>
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
        {/* Workspaces section — history groups frame the repo registry so the
            minimal panel stays navigable when the focused drawer is hidden. */}
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <ChatsTab
            repos={activeProjectReposForChats}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
            onOpenHistoryChat={onOpenHistoryChat}
            variant="mini"
            limit={3}
            hideWhenEmpty
            sectionLabel="Orchestrator"
            sections={ORCHESTRATOR_HISTORY_SECTIONS}
            showLiveSessions={false}
          />

          {fleetMeta?.mode === 'stale' ? (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.6 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                paddingTop: 10,
                paddingRight: 12,
                paddingBottom: 10,
                paddingLeft: 12,
                borderRadius: 14,
                background: 'var(--t-panel)',
                backdropFilter: 'saturate(180%) blur(20px)',
                WebkitBackdropFilter: 'saturate(180%) blur(20px)',
                border: '0.5px solid rgba(249, 115, 22, 0.22)',
                fontSize: 11.5,
                color: 'var(--t-text)',
                fontWeight: 500,
                letterSpacing: '-0.005em',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              <StaleStatusDot />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  lineHeight: 1.35,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <strong style={{ fontWeight: 600 }}>Showing cached state</strong>
                <span style={{ color: 'var(--t-text-muted)', fontWeight: 400 }}> · gateway reconnecting</span>
              </span>
              <motion.button
                type="button"
                onClick={() => window.location.reload()}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 480, damping: 22, mass: 0.5 }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  border: '0.5px solid rgba(249, 115, 22, 0.32)',
                  borderRadius: 9,
                  background: 'rgba(249, 115, 22, 0.10)',
                  color: '#f97316',
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '-0.005em',
                  fontFamily: 'var(--font-sans-system)',
                  flexShrink: 0,
                }}
              >
                Reload
              </motion.button>
            </motion.div>
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
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              Loading workspaces...
            </div>
          ) : null}

          <RepoRegistrySection
            repoPathFilter={activeProjectRepoSet}
            projectsForMove={projects.ledger?.projects.map((p) => ({
              id: p.id,
              name: p.name,
              color: p.color,
              repoPaths: p.repoPaths,
            })) ?? []}
            currentProjectId={projects.activeProject?.id ?? null}
            activeProjectName={projects.activeProject?.name ?? null}
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

          <ChatsTab
            repos={activeProjectReposForChats}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
            onOpenHistoryChat={onOpenHistoryChat}
            variant="mini"
            limit={5}
            hideWhenEmpty
            sectionLabel="Chats"
            sections={CHAT_HISTORY_SECTIONS}
            showLiveSessions={false}
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
          onSetColor={projects.setProjectColor}
          onDropRepoOnProject={async (repoPath, targetId) => {
            await projects.moveRepoToProject(repoPath, targetId);
          }}
        />
      ) : null}
    </div>
  );
});

function StaleStatusDot() {
  return (
    <span style={{ position: 'relative', width: 10, height: 10, flexShrink: 0 }}>
      <motion.span
        aria-hidden
        animate={{ scale: [1, 1.9, 1], opacity: [0.45, 0, 0.45] }}
        transition={{ duration: 1.6, ease: 'easeOut', repeat: Infinity }}
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 999,
          background: '#f97316',
        }}
      />
      <span
        style={{
          position: 'absolute',
          inset: 1,
          borderRadius: 999,
          background: '#f97316',
          boxShadow: '0 0 0 0.5px rgba(249, 115, 22, 0.55) inset',
        }}
      />
    </span>
  );
}
