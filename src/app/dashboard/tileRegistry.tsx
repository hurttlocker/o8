'use client';

import { Suspense, lazy, type Dispatch, type SetStateAction } from 'react';
import type { CanvasRepoTaskLaunchRequest } from '@/components/desktop/Canvas';
import { ContextualPanel, type ContextualPanelHandle, type ContextualPanelProps } from '@/components/desktop/ContextualPanel';
import { LocalhostPreviewTabs } from '@/components/desktop/LocalhostPreviewTabs';
import type { TileContentRegistry } from '@/components/desktop/TileContainer';
import type { WorkspaceSidePanelRepo, WorkspaceSidePanelView } from '@/components/desktop/WorkspaceSidePanel';
import type { TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type {
  OrchestratorLaneBinding,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorWorkspaceTarget,
  WorkspaceLaneState,
} from '@/lib/orchestrator/types';
import type { DetectedLocalhostPreview, PreviewSelectionPayload } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import {
  collectLeafContentKinds,
  createDefaultTileLayout,
  getFirstLeaf,
} from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import type {
  CanvasTileState,
  PaletteAgentSummary,
  WorkspaceScopeEntry,
} from './types';
import {
  collectOpenTerminalRepoPaths,
  repoSlugFromRemote,
  sameWorkspaceLaneState,
  sameWorkspaceSidePanelRepo,
} from './utils';

const LazyWorkspaceTerminal = lazy(() => import('@/components/desktop/WorkspaceTerminal').then(m => ({ default: m.WorkspaceTerminal })));
const LazyCanvas = lazy(() => import('@/components/desktop/Canvas').then(m => ({ default: m.Canvas })));

const TILE_LAYOUT_STORAGE_KEY = 'cortex-ide:dashboard-tiles:v1';

interface WorkspaceAgentLaunchRequest {
  repoPath: string;
  runtime?: 'codex' | 'claude-code';
  modelId?: string;
  initialText?: string;
  autoSend?: boolean;
  createNew?: boolean;
  label?: string;
  targetSessionKey?: string;
  supervisorStatus?: string | null;
  autoArchiveOnIdle?: boolean;
}

export interface TileRegistryDeps {
  activeTileId: string | null;
  canvasStateByTileId: Record<string, CanvasTileState>;
  closeCanvasTab: (tileId: string, tabId: string) => void;
  ensureWorkspaceTerminalTile: (repoPath?: string | null, preferredTileId?: string | null) => string | null;
  focusOrchestrationPacketLane: (packet: OrchestratorPacket) => void;
  globalRepoEntries: RepoRegistryEntry[];
  handleAgentPanelChatInjection: (payload: AgentPanelChatInjectionPayload) => void;
  handleClosePreviewTileItem: (tileId: string, previewId: string) => void;
  handleCloseTile: (tileId: string) => void;
  handleLaunchWorkspaceAgent: (request: WorkspaceAgentLaunchRequest) => Promise<void>;
  handleLaunchWorkspaceRepoTask: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
  handleOpenCI: (repo: string) => void;
  handleOpenGitLog: (workspace?: string) => void;
  handlePreviewDetected: (preview: DetectedLocalhostPreview) => void;
  handlePreviewSelection: (selection: PreviewSelectionPayload) => void;
  handleSelectCommit: (hash: string, meta?: Record<string, string>) => void;
  handleSelectPreviewTile: (tileId: string, previewId: string) => void;
  handleSelectRegisteredRepo: (repoId: string) => Promise<void>;
  handleSplitTile: (tileId: string, direction: 'vertical' | 'horizontal') => void;
  handleThoughtsMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  launchOrchestrationPacket: (packet: OrchestratorPacket) => Promise<OrchestratorLaneBinding | null>;
  openWorkspaceSidePanel: (
    view: WorkspaceSidePanelView,
    repo?: WorkspaceSidePanelRepo | null,
  ) => void;
  orchestratorWorkspaceTargets: OrchestratorWorkspaceTarget[];
  parsedAgents: PaletteAgentSummary[];
  registerContextualPanelHandle: (tileId: string, handle: ContextualPanelHandle | null) => void;
  registerWorkspaceTerminalHandle: (tileId: string, handle: TerminalTabHandle | null) => void;
  selectCanvasTab: (tileId: string, tabId: string) => void;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  setActiveWorkspace: Dispatch<SetStateAction<string | undefined>>;
  setTileLayout: Dispatch<SetStateAction<TileLayout>>;
  setTileLayoutHydrated: Dispatch<SetStateAction<boolean>>;
  setTerminalTileRepoScope: (tileId: string, repoPath: string | null) => void;
  setWorkspaceChatSessionByTileId: Dispatch<SetStateAction<Record<string, string | undefined>>>;
  setWorkspaceChatSessionsByTileId: Dispatch<SetStateAction<Record<string, MobileInboxSnapshot['sessions']>>>;
  setWorkspaceLaneByTileId: Dispatch<SetStateAction<Record<string, WorkspaceLaneState | null>>>;
  setWorkspaceSidePanelRepoContext: Dispatch<SetStateAction<WorkspaceSidePanelRepo | null>>;
  sendAgentKill: ContextualPanelProps['sendAgentKill'];
  sendTerminalAttach: ContextualPanelProps['sendTerminalAttach'];
  sendTerminalCreate: ContextualPanelProps['sendTerminalCreate'];
  sendTerminalDetach: ContextualPanelProps['sendTerminalDetach'];
  sendTerminalInput: ContextualPanelProps['sendTerminalInput'];
  sendTerminalResize: ContextualPanelProps['sendTerminalResize'];
  termWsConnected: boolean;
  thoughtsDraftInjection: { id: string; text: string } | null;
  thoughtsMissionState: OrchestratorMissionState;
  tileLayout: TileLayout;
  workspacePreviews: DetectedLocalhostPreview[];
  workspaceScopeEntries: WorkspaceScopeEntry[];
  workspaceTerminalPreferredRepo: WorkspaceScopeEntry | null;
  workspaceTerminalResetNonceByTileId: Record<string, number>;
}

export function createTileRegistry({
  activeTileId,
  canvasStateByTileId,
  closeCanvasTab,
  ensureWorkspaceTerminalTile,
  focusOrchestrationPacketLane,
  globalRepoEntries,
  handleAgentPanelChatInjection,
  handleClosePreviewTileItem,
  handleCloseTile,
  handleLaunchWorkspaceAgent,
  handleLaunchWorkspaceRepoTask,
  handleOpenCI,
  handleOpenGitLog,
  handlePreviewDetected,
  handlePreviewSelection,
  handleSelectCommit,
  handleSelectPreviewTile,
  handleSelectRegisteredRepo,
  handleSplitTile,
  handleThoughtsMissionStateChange,
  launchOrchestrationPacket,
  openWorkspaceSidePanel,
  orchestratorWorkspaceTargets,
  parsedAgents,
  registerContextualPanelHandle,
  registerWorkspaceTerminalHandle,
  selectCanvasTab,
  setActiveTileId,
  setActiveWorkspace,
  setTileLayout,
  setTileLayoutHydrated,
  setTerminalTileRepoScope,
  setWorkspaceChatSessionByTileId,
  setWorkspaceChatSessionsByTileId,
  setWorkspaceLaneByTileId,
  setWorkspaceSidePanelRepoContext,
  sendAgentKill,
  sendTerminalAttach,
  sendTerminalCreate,
  sendTerminalDetach,
  sendTerminalInput,
  sendTerminalResize,
  termWsConnected,
  thoughtsDraftInjection,
  thoughtsMissionState,
  tileLayout,
  workspacePreviews,
  workspaceScopeEntries,
  workspaceTerminalPreferredRepo,
  workspaceTerminalResetNonceByTileId,
}: TileRegistryDeps): TileContentRegistry {
  return {
    workspace: {
      label: 'Workspace',
      description: 'Empty repo workspace pane that will pick up the next terminal or inspector surface you open.',
      render: ({ active }) => (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          background: 'linear-gradient(180deg, rgba(6,10,18,0.98) 0%, rgba(12,18,30,0.98) 100%)',
          color: '#e2e8f0',
        }}>
          <div style={{
            width: 48,
            height: 48,
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(148,163,184,0.08)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: active ? 'rgba(96,165,250,0.26)' : 'rgba(148,163,184,0.12)',
            marginBottom: 14,
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </div>
          <div style={{
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            marginBottom: 6,
          }}>
            Empty workspace
          </div>
          <div style={{
            maxWidth: 320,
            textAlign: 'center',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'rgba(226,232,240,0.72)',
            marginBottom: 16,
          }}>
            Split first, then open a repo surface. Cortex will route the next workspace tab into this pane automatically.
          </div>
          <button
            type="button"
            onClick={() => {
              window.localStorage.removeItem(TILE_LAYOUT_STORAGE_KEY);
              setTileLayout(createDefaultTileLayout());
              setTileLayoutHydrated(true);
            }}
            style={{
              padding: '8px 20px',
              borderRadius: 8,
              border: '1px solid rgba(96,165,250,0.3)',
              background: 'rgba(96,165,250,0.08)',
              color: '#93c5fd',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reset Layout
          </button>
        </div>
      ),
    },
    terminal: {
      label: 'Workspace',
      description: 'Multi-tab terminal and chat workspace for active sessions.',
      singleton: true,
      hideHeader: true,
      // closable determined dynamically in TileContainer (last terminal is protected)
      render: ({ tileId, content }) => {
        const firstTerminalLeafId = (() => {
          const firstLeaf = getFirstLeaf(tileLayout.root);
          return firstLeaf.content.kind === 'terminal' ? firstLeaf.id : null;
        })();
        const hasScopedTerminalLeaf = collectOpenTerminalRepoPaths(tileLayout.root).length > 0;
        const tileRepoEntry = content.kind === 'terminal' && content.repoPath
          ? workspaceScopeEntries.find((repo) => repo.localPath === content.repoPath) ?? null
          : null;
        const isFreshSplitTile = content.kind === 'terminal' && !content.repoPath && tileId !== 'tile-root';
        const isPrimaryUnscopedTerminal = content.kind === 'terminal'
          && !content.repoPath
          && !hasScopedTerminalLeaf
          && firstTerminalLeafId === tileId;
        const effectiveSplitCreated = isFreshSplitTile && !isPrimaryUnscopedTerminal;
        const tilePreferredRepo = tileRepoEntry ? {
          name: tileRepoEntry.name,
          localPath: tileRepoEntry.localPath,
          branch: tileRepoEntry.branch ?? tileRepoEntry.readiness?.currentBranch ?? null,
          readiness: tileRepoEntry.readiness ?? null,
          ...(tileRepoEntry.remoteUrl ? { remoteUrl: tileRepoEntry.remoteUrl } : {}),
          ...(tileRepoEntry.registryRepoId ? { registryRepoId: tileRepoEntry.registryRepoId } : {}),
          ...(tileRepoEntry.isWorktree ? { isWorktree: true, worktreeStatus: tileRepoEntry.worktreeStatus ?? null } : {}),
        } : isPrimaryUnscopedTerminal
          ? workspaceTerminalPreferredRepo
        : isFreshSplitTile
          ? null
          : workspaceTerminalPreferredRepo;
        const canCloseTerminalTile = collectLeafContentKinds(tileLayout.root).filter((kind) => kind === 'terminal').length > 1;
        const openRepoPaths = Array.from(new Set(collectOpenTerminalRepoPaths(tileLayout.root, tileId)));

        return (
          <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--t-bg)', color: 'var(--t-text-faint)', fontSize: 13 }} />}>
          <LazyWorkspaceTerminal
            key={`workspace-terminal:${tileId}:${workspaceTerminalResetNonceByTileId[tileId] ?? 0}`}
            ref={(handle) => registerWorkspaceTerminalHandle(tileId, handle)}
            stateScope={tileId}
            defaultTab={tileId === 'tile-root' ? 'llm-chat' : 'terminal'}
            autoCreateDefaultTab={tileId === 'tile-root' || workspaceScopeEntries.length > 0}
            preferredRepo={tilePreferredRepo}
            splitCreated={content.kind === 'terminal' ? effectiveSplitCreated : false}
            availableRepos={workspaceScopeEntries}
            openRepoPaths={openRepoPaths}
            canCloseTile={canCloseTerminalTile}
            onActiveChatSessionChange={(sessionKey) => {
              setWorkspaceChatSessionByTileId((current) => (
                current[tileId] === (sessionKey ?? undefined)
                  ? current
                  : { ...current, [tileId]: sessionKey ?? undefined }
              ));
            }}
            onChatSessionsChange={(sessions) => {
              setWorkspaceChatSessionsByTileId((current) => {
                const previous = current[tileId] ?? [];
                const same = previous.length === sessions.length
                  && previous.every((session, index) => (
                    session.sessionKey === sessions[index]?.sessionKey
                    && session.status === sessions[index]?.status
                    && session.name === sessions[index]?.name
                  ));
                if (same) return current;
                return { ...current, [tileId]: sessions };
              });
            }}
            onActiveLaneChange={(lane) => {
              setWorkspaceLaneByTileId((current) => (
                sameWorkspaceLaneState(current[tileId], lane)
                  ? current
                  : { ...current, [tileId]: lane }
              ));
            }}
            onRepoScopeChange={(repoPath) => setTerminalTileRepoScope(tileId, repoPath)}
            onActiveRepoContextChange={(repo) => {
              if (activeTileId !== tileId) return;
              setWorkspaceSidePanelRepoContext((current) => sameWorkspaceSidePanelRepo(current, repo) ? current : repo);
            }}
            onSelectRepoScope={(repo) => {
              const currentRepoPath = tilePreferredRepo?.localPath ?? null;
              if (currentRepoPath === repo.localPath) {
                setActiveTileId(tileId);
                setActiveWorkspace(repo.localPath);
              } else {
                const targetTileId = ensureWorkspaceTerminalTile(repo.localPath, tileId);
                if (targetTileId) {
                  setActiveTileId(targetTileId);
                }
                setActiveWorkspace(repo.localPath);
              }
              const matched = repo.registryRepoId
                ? globalRepoEntries.find((entry) => entry.id === repo.registryRepoId) ?? null
                : globalRepoEntries.find((entry) => entry.localPath === repo.localPath) ?? null;
              if (matched) {
                void handleSelectRegisteredRepo(matched.id);
              }
            }}
            onLaunchRepoAgent={(repo) => {
              void handleLaunchWorkspaceAgent({
                repoPath: repo.localPath,
                createNew: true,
              }).catch((error) => {
                window.alert(error instanceof Error ? error.message : 'Unable to launch workspace agent.');
              });
            }}
            onOpenRepoGitLog={(repo) => handleOpenGitLog(repo.localPath)}
            onOpenRepoCI={(repo) => {
              const repoSlug = repoSlugFromRemote(repo.remoteUrl);
              if (repoSlug) handleOpenCI(repoSlug);
            }}
            onOpenRepoDiff={(repo) => openWorkspaceSidePanel('diff', repo ? {
              name: repo.name,
              localPath: repo.localPath,
              branch: repo.branch ?? null,
              readiness: repo.readiness ?? null,
              remoteUrl: repo.remoteUrl,
            } : null)}
            onInjectChatContext={handleAgentPanelChatInjection}
            onSelectCommit={handleSelectCommit}
            onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
            onSplitVertical={() => handleSplitTile(tileId, 'vertical')}
            onSplitHorizontal={() => handleSplitTile(tileId, 'horizontal')}
            onCloseTile={() => handleCloseTile(tileId)}
            sendTerminalCreate={sendTerminalCreate}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalDetach={sendTerminalDetach}
            termWsConnected={termWsConnected}
            onPreviewDetected={handlePreviewDetected}
            onPreviewSelection={handlePreviewSelection}
            showPreviewPane={false}
          />
          </Suspense>
        );
      },
    },
    preview: {
      label: 'Preview',
      description: 'Tabbed localhost previews detected from the workspace terminal.',
      singleton: true,
      render: ({ content, tileId }) => (
        <LocalhostPreviewTabs
          previews={workspacePreviews}
          selectedPreviewId={content.kind === 'preview' ? content.selectedPreviewId ?? null : null}
          onSelectPreview={(previewId) => handleSelectPreviewTile(tileId, previewId)}
          onClosePreview={(previewId) => handleClosePreviewTileItem(tileId, previewId)}
          onElementSelect={handlePreviewSelection}
        />
      ),
    },
    canvas: {
      label: 'Inspector',
      description: 'Legacy canvas surface for diffs, issues, PRs, and session replay.',
      render: ({ tileId, content }) => {
        const tileState = canvasStateByTileId[tileId] ?? { tabs: [], activeTabId: null, revealKey: 0 };
        const tileRepoEntry = content.kind === 'canvas' && content.repoPath
          ? globalRepoEntries.find((repo) => repo.localPath === content.repoPath) ?? null
          : null;

        return (
          <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>Loading inspector...</div>}>
            <LazyCanvas
              tabs={tileState.tabs}
              activeTabId={tileState.activeTabId}
              onSelectTab={(tabId) => selectCanvasTab(tileId, tabId)}
              onCloseTab={(tabId) => closeCanvasTab(tileId, tabId)}
              selectedRepo={repoSlugFromRemote(tileRepoEntry?.remoteUrl) ?? null}
              onInjectChatContext={handleAgentPanelChatInjection}
              onSelectCommit={handleSelectCommit}
              onLaunchWorkspaceTask={handleLaunchWorkspaceRepoTask}
            />
          </Suspense>
        );
      },
    },
    'contextual-panel': {
      label: 'Global Terminal',
      description: 'Global operator shell for scratch commands, quick command execution, and non-repo-specific utilities.',
      singleton: true,
      hideHeader: true,
      render: ({ tileId }) => (
        <ContextualPanel
          ref={(handle) => registerContextualPanelHandle(tileId, handle)}
          sendTerminalCreate={sendTerminalCreate}
          sendTerminalAttach={sendTerminalAttach}
          sendTerminalInput={sendTerminalInput}
          sendTerminalResize={sendTerminalResize}
          sendTerminalDetach={sendTerminalDetach}
          sendAgentKill={sendAgentKill}
          termWsConnected={termWsConnected}
          onSplitVertical={() => handleSplitTile(tileId, 'vertical')}
          onSplitHorizontal={() => handleSplitTile(tileId, 'horizontal')}
          onClose={() => handleCloseTile(tileId)}
        />
      ),
    },
  };
}
