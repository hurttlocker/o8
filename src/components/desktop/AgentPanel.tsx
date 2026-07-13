'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- AgentPanel keeps a stable prop surface during the refactor */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { AgentPanelExtraAgents } from './AgentPanelExtraAgents';
import { ConnectionPill } from './ConnectionPill';
import { UpdateCard } from './UpdateCard';
import { FixedReportCard } from './FixedReportCard';
import { LeftPanelProjectFocus } from './repo-focus/LeftPanelProjectFocus';
import { ChatsTab } from './repo-focus/tabs/ChatsTab';
import { useLeftPanelProjectFocus } from './repo-focus/useLeftPanelProjectFocus';
import { toRepoFocusRepo, type RepoFocusRepo } from './repo-focus/types';
import { AddRepoDialog } from './repo-registry/AddRepoDialog';
import { RepoStatusHover } from './repo-registry/RepoStatusHover';
import type { RepoRegistryEntry } from './repo-registry/shared';
import { useProjects, type ProjectRecord } from './repo-registry/useProjects';
import { Menu, MessageSquare, Play, Plus, Sparkles, Terminal, type LucideIcon } from './lucide-shims';
import { MenuScale } from 'iconoir-react';
import { AutoFlash, Delivery, InputSearch } from 'iconoir-react';
import { repoSlugFromRemote } from './canvas-utils';

// ── Iconoir → Lucide-shaped adapters ──────────────────────────────────
// MiniAgentPanelAction wants a LucideIcon (size + strokeWidth). Iconoir
// uses width/height. Tiny wrappers keep the AgentPanel callsite clean.
const FolderIcon: LucideIcon = ({ size = 24, strokeWidth = 2, color = 'currentColor' }) => (
  <Delivery width={size} height={size} strokeWidth={Number(strokeWidth)} color={color} />
);
const SearchIcon: LucideIcon = ({ size = 24, strokeWidth = 2, color = 'currentColor' }) => (
  <InputSearch width={size} height={size} strokeWidth={Number(strokeWidth)} color={color} />
);
const AutomationsIcon: LucideIcon = ({ size = 24, strokeWidth = 2, color = 'currentColor' }) => (
  <AutoFlash width={size} height={size} strokeWidth={Number(strokeWidth)} color={color} />
);
import {
  AgentPanelEmptyState,
  SidebarSection,
  THEME_ACCENT,
  type AgentPanelProps,
  useAgentPanelState,
} from './agent-panel';

const PROJECT_HISTORY_SECTIONS = ['orchestrator', 'chat'] as const;
const MINI_FLAT_BUTTON_BG = 'transparent';
const MINI_FLAT_HOVER_BG = 'var(--t-hover)';
const MINI_ROW_DIVIDER = '1px solid color-mix(in srgb, var(--t-divider-subtle) 62%, transparent)';

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
    onFocusAssistantTab,
    onCreateWorkspaceOrchestrator,
    onCreateWorkspaceChat,
    onCreateWorkspaceTerminal,
    onRepoAdded,
    onRepoRemoved,
    onOpenSpecInWorkspace,
    orchestratorPackets = [],
    orchestratorMissionState,
    registeredRepos = [],
    ideWorkspaceSessions,
    onOpenCommandPalette,
    onOpenProjectManagement,
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
  // Projects ledger groups repos and drives the compact Projects dropdown.
  // The old footer dot switcher is retired so project navigation lives in
  // one place instead of competing with the bottom utility buttons.
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
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);
  const registeredRepoByPath = useMemo(() => new Map(registeredRepos.map((repo) => [repo.localPath, repo])), [registeredRepos]);
  const activeProjectRepoSet = useMemo(() => {
    if (!projects.activeProject) return null;
    return new Set(projects.activeProject.repoPaths);
  }, [projects.activeProject]);
  const activeProjectReposForChats = useMemo(() => {
    const projectPaths = projects.activeProject?.repoPaths ?? [];
    if (projectPaths.length > 0) {
      return projectPaths.flatMap((repoPath) => {
        const registeredRepo = registeredRepoByPath.get(repoPath);
        return registeredRepo ? [toRepoFocusRepo(registeredRepo)] : [];
      });
    }
    return registeredRepos
      .filter((repo) => !activeProjectRepoSet || activeProjectRepoSet.has(repo.localPath))
      .map(toRepoFocusRepo);
  }, [activeProjectRepoSet, projects.activeProject?.repoPaths, registeredRepoByPath, registeredRepos]);

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
  const effectiveTitlebarSpacerHeight = Math.min(titlebarSpacerHeight, 10);
  const handleCreateOrchestrator = useCallback(() => {
    onCreateWorkspaceOrchestrator?.();
  }, [onCreateWorkspaceOrchestrator]);
  // Repo-header [+] — spawn a fresh orchestrator bound to that repo
  // (Cursor's contextual New Agent pattern).
  const handleCreateOrchestratorForRepo = useCallback((repo: RepoFocusRepo) => {
    onCreateWorkspaceOrchestrator?.({
      name: repo.name,
      localPath: repo.localPath,
      remoteUrl: repo.remoteUrl ?? undefined,
      branch: repo.defaultBranch ?? null,
    });
  }, [onCreateWorkspaceOrchestrator]);
  const handleCreateChat = useCallback(() => {
    if (onCreateWorkspaceChat) {
      onCreateWorkspaceChat();
      return;
    }
    onFocusAssistantTab?.();
  }, [onCreateWorkspaceChat, onFocusAssistantTab]);
  const handleCreateTerminal = useCallback(() => {
    onCreateWorkspaceTerminal?.();
  }, [onCreateWorkspaceTerminal]);
  const [addRepoDialogOpen, setAddRepoDialogOpen] = useState(false);
  const handledAddRepoIntentNonceRef = useRef<number | null>(null);
  const handleOpenProjectManagement = useCallback(() => {
    setProjectsMenuOpen(false);
    onOpenProjectManagement?.();
  }, [onOpenProjectManagement]);
  const handleOpenAddRepoDialog = useCallback(() => {
    setProjectsMenuOpen(false);
    setAddRepoDialogOpen(true);
  }, []);
  const handleRepoAdded = useCallback(async (repo: RepoRegistryEntry) => {
    await projects.refresh();
    await onRepoAdded?.(repo);
    onSelectRepo?.(repo.id);
    // Tell the dashboard's global repo state to refetch so the new repo shows
    // in the workspace targets immediately (no manual reload) — 2026-06-22.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('o8:repos-changed'));
    }
  }, [onRepoAdded, onSelectRepo, projects]);
  // Clicking a project just SELECTS it (makes it active) — the rest of the app
  // follows (right panel + a new orchestrator). The drawer stays OPEN so you can
  // keep navigating; close it manually. Opening the control room is a separate
  // action on the row's chevron (handleMiniOpenControlRoom).
  const handleMiniProjectSelect = useCallback((project: ProjectRecord) => {
    void projects.switchActive(project.id);
  }, [projects]);
  // Clicking a repo selects that specific repo so the right side shows it — no
  // auto control room, and the drawer stays open for repo-to-repo navigation.
  const handleMiniRepoSelect = useCallback((project: ProjectRecord, repoPath: string) => {
    const repo = registeredRepoByPath.get(repoPath);
    void projects.switchActive(project.id);
    onSelectRepo?.(repo?.id ?? repoPath);
  }, [onSelectRepo, projects, registeredRepoByPath]);
  // The chevron explicitly opens the control room (project focus drawer).
  const handleMiniOpenControlRoom = useCallback((project: ProjectRecord) => {
    setProjectsMenuOpen(false);
    void projects.switchActive(project.id);
    leftPanelFocus.focusByProjectId(project.id);
  }, [leftPanelFocus, projects]);

  useEffect(() => {
    const nonce = addRepoIntent?.nonce ?? null;
    if (nonce === null || handledAddRepoIntentNonceRef.current === nonce) return;
    handledAddRepoIntentNonceRef.current = nonce;
    window.setTimeout(handleOpenAddRepoDialog, 0);
  }, [addRepoIntent?.nonce, handleOpenAddRepoDialog]);

  const addRepoDialog = (
    <AddRepoDialog
      open={addRepoDialogOpen}
      projects={projects.ledger?.projects ?? []}
      activeProjectId={projects.ledger?.activeProjectId ?? null}
      onClose={() => setAddRepoDialogOpen(false)}
      onRepoAdded={handleRepoAdded}
      onProjectsChanged={projects.refresh}
      initialMode={addRepoIntent?.mode ?? undefined}
    />
  );

  // When focus is active, the column itself widened — render the focus
  // surface inline so it occupies the whole AgentPanel column and keeps
  // the TitleBar + DesktopStatusBar visible above and below.
  if (focusActive && leftPanelFocus.view) {
    return (
      <div
        suppressHydrationWarning
        data-o8-agent-panel="true"
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
            height: effectiveTitlebarSpacerHeight,
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
          onOpenSpecInWorkspace={onOpenSpecInWorkspace}
        />
        <ConnectionPill />
        <FixedReportCard />
        <UpdateCard />
        {addRepoDialog}
      </div>
    );
  }

  return (
    <div
      suppressHydrationWarning
      data-o8-agent-panel="true"
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
          height: effectiveTitlebarSpacerHeight,
          flexShrink: 0,
          WebkitAppRegion: 'drag' as unknown as string,
        } as CSSProperties}
      />

      {projects.activeProject ? (
        <MiniAgentPanelHeader
          onCreateOrchestrator={handleCreateOrchestrator}
          onCreateChat={handleCreateChat}
          onCreateTerminal={handleCreateTerminal}
          onSearch={onOpenCommandPalette}
          projects={projects.ledger?.projects ?? []}
          activeProjectId={projects.ledger?.activeProjectId ?? null}
          registeredRepoByPath={registeredRepoByPath}
          projectsOpen={projectsMenuOpen}
          onProjectsOpenChange={setProjectsMenuOpen}
          onProjectSelect={handleMiniProjectSelect}
          onRepoSelect={handleMiniRepoSelect}
          onOpenProjectControlRoom={handleMiniOpenControlRoom}
          onManageProjects={handleOpenProjectManagement}
          onAddRepo={handleOpenAddRepoDialog}
        />
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
          paddingTop: effectiveTitlebarSpacerHeight > 10 ? 14 : 12,
          paddingBottom: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          // Symmetric fade — top edge softens against the navigation
          // section above, bottom edge fades into the button dock below.
          // Matches the o8.md panel pattern; 16px top + 32px bottom keeps
          // the bottom dock visually anchored while letting the top blend.
          maskImage: 'linear-gradient(to bottom, transparent 0px, black 16px, black calc(100% - 32px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 16px, black calc(100% - 32px), transparent 100%)',
        } as CSSProperties}
        className="hide-scrollbar"
      >
        {/* Workspaces section — the minimal panel is a project conversation
            stream with the repo context kept close to the project label. */}
        <section style={{ display: 'flex', flexDirection: 'column' }}>
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
                whileHover={{ backgroundColor: 'rgba(249, 115, 22, 0.14)' }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
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
                fontWeight: 300,
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
            sectionLabel={null}
            sections={PROJECT_HISTORY_SECTIONS}
            showLiveSessions={false}
            groupMode="flat"
            showKindInMeta
            onCreateOrchestratorForRepo={handleCreateOrchestratorForRepo}
            packets={orchestratorMissionState?.packets ?? orchestratorPackets}
            // Spawned agents lands between the active chats and the
            // Archived section per operator's hierarchy: chats →
            // spawned → archived. Workers already nested under a visible
            // orchestrator thread are excluded so nothing lists twice.
            slotBeforeArchived={({ nestedPacketIds }) => (
              <AgentPanelExtraAgents
                activeSessionKey={activeSessionKey}
                onSelectSession={onSelectSession}
                hidePacketIds={nestedPacketIds}
              />
            )}
          />
        </section>

        {/* AgentPanelEmptyState ("No active agents") removed — it tracked
            runtime-discovered CLI sessions, not workspace chat tabs, so it
            was misleading when the user had an Orchestrator or Assistant
            tab open. The repo list above is the primary panel content;
            discovered agent sessions appear inline on branch rows when
            they exist. */}

        {/* Repo focus is no longer an overlay — when focusActive, the
            AgentPanel returns LeftPanelRepoFocus inline above (the column
            widens). Nothing else to render here. */}

      </div>
      <ConnectionPill />
      <FixedReportCard />
        <UpdateCard />
      {addRepoDialog}
    </div>
  );
});

function MiniAgentPanelHeader({
  onCreateOrchestrator,
  onCreateChat,
  onCreateTerminal,
  onSearch,
  projects,
  activeProjectId,
  registeredRepoByPath,
  projectsOpen,
  onProjectsOpenChange,
  onProjectSelect,
  onRepoSelect,
  onOpenProjectControlRoom,
  onManageProjects,
  onAddRepo,
}: {
  onCreateOrchestrator?: () => void;
  onCreateChat?: () => void;
  onCreateTerminal?: () => void;
  onSearch?: () => void;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  registeredRepoByPath: Map<string, RepoRegistryEntry>;
  projectsOpen: boolean;
  onProjectsOpenChange: (open: boolean) => void;
  onProjectSelect: (project: ProjectRecord) => void;
  onRepoSelect: (project: ProjectRecord, repoPath: string) => void;
  onOpenProjectControlRoom: (project: ProjectRecord) => void;
  onManageProjects: () => void;
  onAddRepo: () => void;
}) {
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const runSessionAction = useCallback((action?: () => void) => {
    setSessionMenuOpen(false);
    action?.();
  }, []);

  return (
    <div
      style={{
        flexShrink: 0,
        paddingTop: 3,
        paddingRight: 0,
        paddingBottom: 5,
        paddingLeft: 0,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <MiniAgentPanelAction
          icon={Play}
          label="New session"
          active={sessionMenuOpen}
          disclosure="menu"
          onClick={() => {
            onProjectsOpenChange(false);
            setSessionMenuOpen((open) => !open);
          }}
        />
        {sessionMenuOpen ? (
          <MiniSessionMenu
            onCreateOrchestrator={() => runSessionAction(onCreateOrchestrator)}
            onCreateChat={() => runSessionAction(onCreateChat)}
            onCreateTerminal={() => runSessionAction(onCreateTerminal)}
          />
        ) : null}
        <MiniAgentPanelAction
          icon={SearchIcon}
          label="Search"
          onClick={() => {
            setSessionMenuOpen(false);
            onSearch?.();
          }}
          disabled={!onSearch}
        />
        <MiniAgentPanelAction
          icon={AutomationsIcon}
          label="Automations"
          onClick={() => {
            setSessionMenuOpen(false);
            // Dashboard listens for this and flips activeNavSection to 'automations'.
            // Same pattern as o8:open-inbox-tab keeps AgentPanel decoupled.
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('o8:open-automations'));
            }
          }}
        />
        <MiniAgentPanelAction
          icon={FolderIcon}
          label="Projects"
          active={projectsOpen}
          disclosure="filter"
          onClick={() => {
            setSessionMenuOpen(false);
            onProjectsOpenChange(!projectsOpen);
          }}
          // Add-repo lives here now (moved out of the status-bar footer,
          // Q ruling 2026-07-11) — contextual to Projects, left of the
          // filter disclosure. Span-not-button: the row itself is a button.
          trailing={
            <span
              role="button"
              tabIndex={0}
              aria-label="Add repository"
              title="Add repository"
              onClick={(event) => {
                event.stopPropagation();
                onAddRepo();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation();
                  event.preventDefault();
                  onAddRepo();
                }
              }}
              style={{
                flexShrink: 0,
                width: 17,
                height: 17,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 5,
                color: 'var(--t-text-faint)',
                cursor: 'pointer',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = MINI_FLAT_HOVER_BG;
                event.currentTarget.style.color = 'var(--t-text)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent';
                event.currentTarget.style.color = 'var(--t-text-faint)';
              }}
            >
              <Plus size={13} strokeWidth={2} />
            </span>
          }
        />
        {projectsOpen ? (
          <MiniProjectsMenu
            projects={projects}
            activeProjectId={activeProjectId}
            registeredRepoByPath={registeredRepoByPath}
            onProjectSelect={onProjectSelect}
            onRepoSelect={onRepoSelect}
            onOpenProjectControlRoom={onOpenProjectControlRoom}
            onManageProjects={onManageProjects}
            onAddRepo={onAddRepo}
          />
        ) : null}
      </div>
    </div>
  );
}

function MiniSessionMenu({
  onCreateOrchestrator,
  onCreateChat,
  onCreateTerminal,
}: {
  onCreateOrchestrator: () => void;
  onCreateChat: () => void;
  onCreateTerminal: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 0,
        marginRight: 0,
        marginBottom: 2,
        marginLeft: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        borderRadius: 0,
        border: 0,
        background: 'transparent',
        overflow: 'visible',
      }}
    >
      <MiniSessionMenuItem
        icon={Sparkles}
        title="Orchestrator"
        subtitle="Fleet by default"
        onClick={onCreateOrchestrator}
      />
      <MiniSessionMenuItem
        icon={MessageSquare}
        title="Chat"
        subtitle="Direct LLM conversation"
        onClick={onCreateChat}
      />
      <MiniSessionMenuItem
        icon={Terminal}
        title="Terminal"
        subtitle="Plain shell"
        onClick={onCreateTerminal}
        last
      />
    </div>
  );
}

function MiniSessionMenuItem({
  icon: Icon,
  title,
  subtitle,
  last = false,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  last?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: 'calc(100% - 16px)',
        marginLeft: 8,
        marginRight: 8,
        borderWidth: 0,
        borderBottom: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        outline: 'none',
        display: 'grid',
        gridTemplateColumns: '21px minmax(0, 1fr)',
        gap: 10,
        alignItems: 'center',
        paddingTop: 7,
        paddingRight: 10,
        paddingBottom: 7,
        paddingLeft: 10,
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        // Instant flat hover — matches the terminal toggle pattern.
        // No row divider or fade transition (operator pass 2026-05-27).
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = MINI_FLAT_HOVER_BG;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <span
        aria-hidden
        style={{
          width: 21,
          height: 21,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--t-accent)',
        }}
      >
        <Icon size={14} strokeWidth={1.9} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 4,
            fontSize: 9.5,
            lineHeight: 1.25,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subtitle}
        </span>
      </span>
    </button>
  );
}

/**
 * LOCKED 2026-05-28 — DO NOT modify the icon column geometry, label x-position,
 * or trailing-icon shift on this component without operator sign-off. These
 * values are aligned by-eye against the Yesterday folder glyph (x=12) and
 * chat-row text (x=37) below in the same column. See [[next-session-pickup-may28]].
 *
 *   Leading icon span: width 17, transform translateX(-2px) → visible icon
 *     left edge ≈ x=10, matches Yesterday folder at x=12.
 *   Button paddingLeft: 2 (was 10) → label text lands at x=37, matches
 *     HistoryChatRow paddingLeft: 37.
 *   Disclosure trailing icon: transform translateX(7px) → sits ~6px right of
 *     the Yesterday FilterList glyph. New session uses lucide Menu (≡), Projects
 *     uses iconoir MenuScale.
 */
function MiniAgentPanelAction({
  icon: Icon,
  label,
  active = false,
  disabled = false,
  disclosure,
  onClick,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  disclosure?: 'menu' | 'filter';
  onClick?: () => void;
  /** Extra control rendered between the label and the disclosure glyph
      (e.g. Projects row's add-repo). Must NOT be a <button> — the row
      itself is one; use a span with role="button" + stopPropagation. */
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 'calc(100% - 16px)',
        marginLeft: 8,
        marginRight: 8,
        minHeight: 27,
        borderWidth: 0,
        borderBottom: 0,
        // Round + slight inset so the hover bg reads as a flat chip,
        // not a full-bleed slab across the column. Matches the bottom
        // terminal toggle's footprint feel — operator pass 2026-05-27.
        borderRadius: 8,
        background: active ? MINI_FLAT_HOVER_BG : 'transparent',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        outline: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 3,
        paddingRight: 10,
        paddingBottom: 3,
        paddingLeft: 2,
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        // No transition — instant flat color swap, no soft fade. The
        // terminal toggle button uses the same instant pattern.
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = MINI_FLAT_HOVER_BG;
      }}
      onMouseLeave={(event) => {
        if (!disabled) event.currentTarget.style.background = active ? MINI_FLAT_HOVER_BG : 'transparent';
      }}
    >
      <span
        aria-hidden
        style={{
          width: 17,
          height: 17,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
          flexShrink: 0,
          transform: 'translateX(-2px)',
        }}
      >
        <Icon size={14} strokeWidth={2} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </span>
      {trailing ?? null}
      {disclosure ? (
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--t-text-faint)',
            // Per-glyph optical nudge (2026-06-11 re-snap): both glyphs' ink
            // sat 1-2px left of the right-rail column (ring+2). Menu's lines
            // inset ~1px inside its 13px box, MenuScale's ~0.5px inside 12px
            // — measured from rendered pixels at 4x, not the bbox math.
            transform: disclosure === 'menu' ? 'translateX(9px)' : 'translateX(8px)',
          }}
        >
          {disclosure === 'menu' ? (
            <Menu size={13} strokeWidth={2} />
          ) : (
            <MenuScale width={12} height={12} color="currentColor" strokeWidth={1.8} />
          )}
        </span>
      ) : null}
    </button>
  );
}

function MiniProjectsMenu({
  projects,
  activeProjectId,
  registeredRepoByPath,
  onProjectSelect,
  onRepoSelect,
  onOpenProjectControlRoom,
  onManageProjects,
  onAddRepo,
}: {
  projects: ProjectRecord[];
  activeProjectId: string | null;
  registeredRepoByPath: Map<string, RepoRegistryEntry>;
  onProjectSelect: (project: ProjectRecord) => void;
  onRepoSelect: (project: ProjectRecord, repoPath: string) => void;
  onOpenProjectControlRoom: (project: ProjectRecord) => void;
  onManageProjects: () => void;
  onAddRepo: () => void;
}) {
  const [hoveredRepo, setHoveredRepo] = useState<{ repo: RepoRegistryEntry; rect: DOMRect } | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleProjects = useMemo(() => {
    const hasConcreteProject = projects.some((project) => project.id !== 'default');
    return hasConcreteProject ? projects.filter((project) => project.id !== 'default') : projects;
  }, [projects]);

  const clearCloseTimer = useCallback(() => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const closeRepoHover = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setHoveredRepo(null);
      closeTimerRef.current = null;
    }, 120);
  }, [clearCloseTimer]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  // B2 — rename is surfaced here because this is the live project list the user
  // actually sees; the old ProjectsBottomBar rename UI is orphaned/unmounted.
  // useProjects is multi-instance by design (mutations broadcast), so renaming
  // here refreshes the parent's `projects` prop and the new name renders.
  // Double-click a row to rename (default "Workspace" included).
  const { renameProject } = useProjects();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const beginRename = useCallback((project: ProjectRecord) => {
    setRenamingId(project.id);
    setRenameDraft(project.name);
  }, []);
  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft('');
  }, []);
  const submitRename = useCallback(async (project: ProjectRecord) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft('');
    if (!next || next === project.name) return;
    await renameProject(project.id, next);
  }, [renameDraft, renameProject]);
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  return (
    <div
      style={{
        marginTop: 0,
        marginBottom: 3,
        paddingTop: 3,
        paddingRight: 0,
        paddingBottom: 3,
        paddingLeft: 0,
        maxHeight: 188,
        overflowY: 'auto',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        borderTop: '1px solid color-mix(in srgb, var(--t-divider-subtle) 74%, transparent)',
      } as CSSProperties}
      className="hide-scrollbar"
    >
      {visibleProjects.length > 0 ? (
        visibleProjects.map((project) => {
          const active = project.id === activeProjectId;
          const visibleRepoPaths = project.repoPaths.filter((repoPath) => registeredRepoByPath.has(repoPath));
          return (
            <div key={project.id} style={{ paddingTop: 1, paddingBottom: 1 }}>
              {project.id === renamingId ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void submitRename(project); }
                    else if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
                  }}
                  onBlur={() => { void submitRename(project); }}
                  placeholder={project.name}
                  maxLength={60}
                  style={{
                    width: '100%',
                    minHeight: 25,
                    boxSizing: 'border-box',
                    fontSize: 13.5,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                    color: 'var(--t-text)',
                    background: 'var(--t-input-bg)',
                    border: '1px solid var(--t-input-border, var(--t-divider))',
                    borderRadius: 6,
                    marginTop: 1,
                    marginBottom: 1,
                    paddingTop: 3,
                    paddingBottom: 3,
                    paddingLeft: 16,
                    paddingRight: 16,
                    outline: 'none',
                    fontFamily: 'var(--font-sans-system)',
                  }}
                />
              ) : (
              <button
                type="button"
                onClick={() => onProjectSelect(project)}
                onDoubleClick={(event) => { event.preventDefault(); beginRename(project); }}
                title={`Double-click to rename ${project.name}`}
                style={{
                  width: '100%',
                  minHeight: 25,
                  borderWidth: 0,
                  borderRadius: 0,
                  background: active ? 'var(--t-hover)' : 'transparent',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  paddingTop: 3,
                  paddingRight: 18,
                  paddingBottom: 3,
                  paddingLeft: 15,
                  textAlign: 'left',
                  fontFamily: 'var(--font-sans-system)',
                  outlineOffset: -2,
                  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = 'var(--t-hover)';
                  const chevron = event.currentTarget.querySelector<HTMLElement>('.o8-project-row-chevron');
                  if (chevron) chevron.style.opacity = '1';
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = active ? 'var(--t-hover)' : 'transparent';
                  const chevron = event.currentTarget.querySelector<HTMLElement>('.o8-project-row-chevron');
                  if (chevron) chevron.style.opacity = '0';
                }}
              >
                <span
                  aria-hidden
                  style={{
                    // Ring, not a filled dot: filled dots are the STATUS LED
                    // vocabulary (green = running). A ring in the project color
                    // reads as identity without implying agent state.
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: 'transparent',
                    border: `1.5px solid ${project.color ?? 'var(--t-text-faint)'}`,
                    boxSizing: 'border-box',
                    flexShrink: 0,
                    marginRight: 9,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 13.5,
                    lineHeight: 1.25,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                  }}
                >
                  {project.name}
                </span>
                <span
                  style={{
                    color: 'var(--t-text-faint)',
                    fontSize: 9.5,
                    lineHeight: 1.25,
                    fontWeight: 260,
                    letterSpacing: '-0.4px',
                    flexShrink: 0,
                  }}
                >
                  {visibleRepoPaths.length}
                </span>
                {/* Chevron = the explicit "open control room" affordance.
                    Clicking the row itself just SELECTS the project; clicking
                    this opens the project's control room (stopPropagation keeps
                    the two separate). Hover-reveal via the row's mouse handlers. */}
                <span
                  className="o8-project-row-chevron"
                  role="button"
                  tabIndex={0}
                  title="Open control room"
                  aria-label={`Open control room for ${project.name}`}
                  onClick={(event) => { event.stopPropagation(); onOpenProjectControlRoom(project); }}
                  onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-faint)'; }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--t-text-faint)',
                    opacity: 0,
                    flexShrink: 0,
                    cursor: 'pointer',
                    marginLeft: 2,
                    transition: 'opacity 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                >
                  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </span>
              </button>
              )}
              {visibleRepoPaths.length > 0 ? (
                <div style={{ paddingTop: 1, display: 'flex', flexDirection: 'column' }}>
                  {visibleRepoPaths.map((repoPath) => {
                    const repo = registeredRepoByPath.get(repoPath);
                    const label = repo?.name ?? repoFocusRepoFromPath(repoPath).name;
                    return (
                      <button
                        key={`${project.id}:${repoPath}`}
                        type="button"
                        onClick={() => onRepoSelect(project, repoPath)}
                        aria-label={`${label} repository`}
                        style={{
                          width: '100%',
                          minHeight: 22,
                          borderWidth: 0,
                          borderRadius: 0,
                          background: 'transparent',
                          color: 'var(--t-text-muted)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          paddingTop: 2,
                          paddingRight: 18,
                          paddingBottom: 2,
                          paddingLeft: 35,
                          textAlign: 'left',
                          fontFamily: 'var(--font-sans-system)',
                          outlineOffset: -2,
                          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                        }}
                        onMouseEnter={(event) => {
                          if (repo) {
                            clearCloseTimer();
                            setHoveredRepo({ repo, rect: event.currentTarget.getBoundingClientRect() });
                          }
                          event.currentTarget.style.background = 'var(--t-hover)';
                          event.currentTarget.style.color = 'var(--t-text)';
                        }}
                        onMouseLeave={(event) => {
                          closeRepoHover();
                          event.currentTarget.style.background = 'transparent';
                          event.currentTarget.style.color = 'var(--t-text-muted)';
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 3,
                            height: 3,
                            borderRadius: 999,
                            background: 'var(--t-text-faint)',
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 12.5,
                            lineHeight: 1.25,
                            fontWeight: 300,
                            letterSpacing: '-0.1px',
                          }}
                        >
                          {label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div style={{ padding: '8px 7px', color: 'var(--t-text-faint)', fontSize: 12.5, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px' }}>
          No projects yet
        </div>
      )}
      <button
        type="button"
        onClick={onAddRepo}
        style={{
          width: '100%',
          minHeight: 25,
          marginTop: 3,
          borderWidth: 0,
          borderRadius: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 3,
          paddingRight: 18,
          paddingBottom: 3,
          paddingLeft: 30,
          textAlign: 'left',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 13,
          lineHeight: 1.25,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = 'var(--t-hover)';
          event.currentTarget.style.color = 'var(--t-text)';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = 'transparent';
          event.currentTarget.style.color = 'var(--t-text-muted)';
        }}
      >
        <Plus size={12} strokeWidth={2} />
        Add repo...
      </button>
      <button
        type="button"
        onClick={onManageProjects}
        style={{
          width: '100%',
          minHeight: 25,
          marginTop: 3,
          borderWidth: 0,
          borderRadius: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          paddingTop: 3,
          paddingRight: 18,
          paddingBottom: 3,
          paddingLeft: 30,
          textAlign: 'left',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 13,
          lineHeight: 1.25,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = 'var(--t-hover)';
          event.currentTarget.style.color = 'var(--t-text)';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = 'transparent';
          event.currentTarget.style.color = 'var(--t-text-muted)';
        }}
      >
        Manage projects
      </button>
      {hoveredRepo ? (
        <RepoStatusHover
          repo={hoveredRepo.repo}
          anchorRect={hoveredRepo.rect}
          agents={[]}
          githubSlug={repoSlugFromRemote(hoveredRepo.repo.remoteUrl)}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={closeRepoHover}
        />
      ) : null}
    </div>
  );
}

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
              aria-label={`Open ${repo.name}`}
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
