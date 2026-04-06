'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- AgentPanel keeps a stable prop surface during the refactor */

import { memo, type CSSProperties } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Clock, Plus } from 'lucide-react';
import { RepoRegistrySection } from './RepoRegistrySection';
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
    orchestratorPackets = [],
    ideWorkspaceSessions,
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

  return (
    <div
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

      <div
        suppressHydrationWarning
        style={{
          flex: 1,
          overflowY: 'auto',
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
        <SidebarSection
          title="Workspaces"
          summary={workspacesSummary}
          accent="#ef4444"
          open={reposOpen}
          onToggle={() => setReposOpen((current) => !current)}
          headerAction={(
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                aria-label="Add repository"
                onClick={requestAddRepo}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  padding: 0,
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  cursor: 'pointer',
                  appearance: 'none',
                  WebkitAppearance: 'none',
                  lineHeight: 0,
                  transition: 'background 140ms ease, color 140ms ease',
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = 'var(--t-panel-hover)';
                  event.currentTarget.style.color = 'var(--t-text)';
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = 'transparent';
                  event.currentTarget.style.color = 'var(--t-text-muted)';
                }}
              >
                <Plus size={15} strokeWidth={2.2} />
              </button>
            </div>
          )}
        >
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
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  flexShrink: 0,
                }}
              >
                Reload
              </button>
            </div>
          ) : gatewayReachable && gatewayWarming ? (
            <div style={{ padding: '8px 2px 2px', fontSize: 11, color: THEME_ACCENT }}>
              Loading live workspaces...
            </div>
          ) : null}

          <RepoRegistrySection
            onLaunchComplete={refreshNow}
            onSelectSession={onSelectSession}
            onSelectPR={onSelectPR}
            onReviewPR={onReviewPR}
            onRepoRemoved={(repo) => {
              refreshNow();
              onRepoRemoved?.(repo);
            }}
            onLaunchWorkspaceAgent={onLaunchWorkspaceAgent}
            onRegistryStateChange={setRepoRegistryState}
            activeSessionKey={activeSessionKey}
            activeRepoLocalPath={currentLaunchRepoPath}
            activeWorkspacePath={activeWorkspacePath ?? selectedRepoLocalPath ?? null}
            sectionOpen={reposOpen}
            onSectionOpenChange={setReposOpen}
            addIntent={addRepoIntent}
            orchestratorPackets={orchestratorPackets}
            ideWorkspaceSessions={ideWorkspaceSessions}
            hideHeader
          />
        </SidebarSection>

        <AnimatePresence initial={false}>
          {!inventoryLoading && agents.length === 0 ? (
            <AgentPanelEmptyState key="agent-panel-empty-state" />
          ) : null}
        </AnimatePresence>

      </div>
    </div>
  );
});
