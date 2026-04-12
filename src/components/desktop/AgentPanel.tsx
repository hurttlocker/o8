'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- AgentPanel keeps a stable prop surface during the refactor */

import { memo, type CSSProperties } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Clock } from 'lucide-react';
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
                  fontFamily: '-apple-system, system-ui, sans-serif',
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
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
              }}
            >
              Loading workspaces...
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
        </section>

        {/* AgentPanelEmptyState ("No active agents") removed — it tracked
            runtime-discovered CLI sessions, not workspace chat tabs, so it
            was misleading when the user had an Orchestrator or Assistant
            tab open. The repo list above is the primary panel content;
            discovered agent sessions appear inline on branch rows when
            they exist. */}

      </div>
    </div>
  );
});
