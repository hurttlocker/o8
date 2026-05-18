'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- AgentPanel keeps a stable prop surface during the refactor */

import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
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

const PROJECT_HISTORY_SECTIONS = ['orchestrator', 'chat'] as const;

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
    onSelectRepo,
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

  const activeProjectId = projects.activeProject?.id ?? null;
  const handleProjectRepoSelect = useCallback((repo: RepoFocusRepo) => {
    if (activeProjectId) {
      leftPanelFocus.focusByProjectId(activeProjectId);
      leftPanelFocus.setSelectedRepoPath(repo.localPath);
    } else {
      leftPanelFocus.focusByRepoId(repo.id || repo.localPath);
    }
    onSelectRepo?.(repo.id);
  }, [activeProjectId, leftPanelFocus, onSelectRepo]);

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
        {/* Workspaces section — the minimal panel is a project conversation
            stream with the repo context kept close to the project label. */}
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <ProjectRepoContext
            repos={activeProjectReposForChats}
            onSelectRepo={handleProjectRepoSelect}
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

          <ChatsTab
            repos={activeProjectReposForChats}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
            onOpenHistoryChat={onOpenHistoryChat}
            variant="mini"
            limit={8}
            hideWhenEmpty
            sectionLabel="Recent"
            sections={PROJECT_HISTORY_SECTIONS}
            showLiveSessions={false}
            groupMode="flat"
            showKindInMeta
            packets={orchestratorMissionState?.packets ?? orchestratorPackets}
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

function ProjectRepoContext({
  repos,
  onSelectRepo,
}: {
  repos: RepoFocusRepo[];
  onSelectRepo: (repo: RepoFocusRepo) => void;
}) {
  if (repos.length === 0) return null;

  return (
    <div
      style={{
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div
        style={{
          marginBottom: 6,
          fontSize: 9.5,
          lineHeight: '12px',
          fontWeight: 500,
          color: 'var(--t-text-faint)',
          letterSpacing: 0,
        }}
      >
        {repos.length} repo{repos.length === 1 ? '' : 's'} in this project
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 5,
        }}
      >
        {repos.map((repo) => {
          const tone = projectRepoChipTone(repo);
          return (
            <button
              key={repo.localPath}
              type="button"
              onClick={() => onSelectRepo(repo)}
              title={[`Open ${repo.name}`, repo.readiness?.summary].filter(Boolean).join(' · ')}
              style={{
                minWidth: 0,
                maxWidth: '100%',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                paddingTop: 3,
                paddingRight: 7,
                paddingBottom: 3,
                paddingLeft: 7,
                borderRadius: 999,
                border: `1px solid ${tone.border}`,
                background: tone.background,
                color: 'var(--t-text)',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 10.5,
                lineHeight: '14px',
                fontWeight: 500,
                letterSpacing: 0,
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = tone.hoverBackground;
                event.currentTarget.style.borderColor = tone.hoverBorder;
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = tone.background;
                event.currentTarget.style.borderColor = tone.border;
              }}
            >
              {tone.dot !== 'transparent' ? (
                <span
                  aria-hidden
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: tone.dot,
                    flexShrink: 0,
                  }}
                />
              ) : null}
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {repo.name}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  color: tone.meta,
                  fontSize: 9.5,
                  fontWeight: 500,
                }}
              >
                {repo.readiness?.state === 'blocked' ? 'attention' : repo.defaultBranch || 'main'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function projectRepoChipTone(repo: RepoFocusRepo): {
  dot: string;
  meta: string;
  border: string;
  background: string;
  hoverBorder: string;
  hoverBackground: string;
} {
  switch (repo.readiness?.state) {
    case 'blocked':
    case 'needs_setup':
      return {
        dot: '#FF5A1F',
        meta: '#FF5A1F',
        border: 'rgba(255, 90, 31, 0.18)',
        background: 'rgba(255, 90, 31, 0.055)',
        hoverBorder: 'rgba(255, 90, 31, 0.28)',
        hoverBackground: 'rgba(255, 90, 31, 0.08)',
      };
    default:
      return {
        dot: 'transparent',
        meta: 'var(--t-text-faint)',
        border: 'var(--t-divider-subtle)',
        background: 'var(--t-input-bg)',
        hoverBorder: 'var(--t-border-strong, rgba(148,163,184,0.22))',
        hoverBackground: 'var(--t-hover, rgba(148,163,184,0.12))',
      };
  }
}
