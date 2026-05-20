'use client';
/* eslint-disable react-hooks/refs -- useWorkspaceTerminalController returns render state and stable refs through one controller object. */

import { forwardRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw } from '../lucide-shims';
import { PreviewPane } from '@/components/desktop/workspace-terminal/PreviewPane';
import { TabBar } from '@/components/desktop/workspace-terminal/TabBar';
import { THEME_ACCENT, THEME_ACCENT_SOFT_STRONG } from '@/components/desktop/workspace-terminal/constants';
import { useWorkspaceTerminalController } from '@/components/desktop/workspace-terminal/useWorkspaceTerminalController';
import { WorkspaceTerminalPanels } from '@/components/desktop/workspace-terminal/WorkspaceTerminalPanels';
import { WorkspaceSpawnProvider, type WorkspaceSpawnHandlers } from '@/components/desktop/workspace-terminal/spawn-context';
import { useTabBarVisibility } from '@/components/desktop/workspace-terminal/useTabBarVisibility';
import { workspaceConversationHeaderLabel } from '@/components/desktop/workspace-terminal/utils';
import type { TerminalTabHandle, WorkspaceTerminalProps } from '@/components/desktop/workspace-terminal/types';

export const WorkspaceTerminalRoot = forwardRef<TerminalTabHandle, WorkspaceTerminalProps>(
  function WorkspaceTerminalRoot(props, ref) {
    const controller = useWorkspaceTerminalController(props, ref);
    const hasPreviews = (props.showPreviewPane ?? true) && controller.previews.length > 0;
    const spawnHandlers = useMemo<WorkspaceSpawnHandlers>(() => ({
      spawnSingleRuntimeTab: controller.spawnSingleRuntimeTab,
      spawnChatTab: controller.spawnChatTab,
      spawnOrchestratorTab: controller.spawnOrchestratorTab,
      updateTabMode: controller.handleUpdateTabMode,
    }), [controller.handleUpdateTabMode, controller.spawnChatTab, controller.spawnOrchestratorTab, controller.spawnSingleRuntimeTab]);
    // Drop the primary mode tabs (Orchestrator + Chat) from the top
    // tab bar — they duplicate the left-rail nav. Only "real" workspace
    // tabs (spawned Codex sessions / terminals / canvas) appear here.
    const topBarTabs = useMemo(
      () => controller.visibleTabs.filter((tab) => tab.kind !== 'orchestrator' && tab.kind !== 'llm-chat'),
      [controller.visibleTabs],
    );
    const { widthAllowsTabs } = useTabBarVisibility();
    // Top tab bar only renders when (a) the viewport is narrow AND
    // (b) there's at least one non-primary tab to show. Above the
    // breakpoint the left rail fully serves nav.
    const showTabBar = widthAllowsTabs && topBarTabs.length > 0;
    const conversationHeaderLabel = !showTabBar && controller.activeTab
      ? workspaceConversationHeaderLabel(controller.activeTab)
      : null;

    return (
      <WorkspaceSpawnProvider value={spawnHandlers}>
      <div
        ref={controller.containerDivRef}
        data-vibrancy-passthrough=""
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--t-bg-gradient)',
        }}
      >
        {hasPreviews ? (
          <div
            style={{
              height: `${controller.previewHeight * 100}%`,
              minHeight: 120,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              flexShrink: 0,
              animation: 'slide-in-preview 300ms ease-out',
              pointerEvents: controller.isDragging ? 'none' : 'auto',
            }}
          >
            <PreviewPane
              previews={controller.previews}
              onElementSelect={props.onPreviewSelection}
              onRefresh={() => undefined}
              onClose={controller.handleClosePreview}
            />
          </div>
        ) : null}

        {hasPreviews ? (
          <div
            onMouseDown={controller.handleDragStart}
            style={{
              height: 8,
              cursor: 'row-resize',
              background: controller.isDragging ? THEME_ACCENT_SOFT_STRONG : 'var(--t-divider)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 20,
              position: 'relative',
            }}
          >
            <div
              style={{
                width: 32,
                height: 3,
                borderRadius: 2,
                background: controller.isDragging ? THEME_ACCENT : 'var(--t-text-muted)',
              }}
            />
          </div>
        ) : null}

        {!controller.termWsConnected ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.6 }}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: 10,
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 12,
              paddingRight: 12,
              borderBottom: '0.5px solid rgba(249, 115, 22, 0.22)',
              background: 'var(--t-panel)',
              backdropFilter: 'saturate(180%) blur(20px)',
              WebkitBackdropFilter: 'saturate(180%) blur(20px)',
              color: 'var(--t-text)',
              fontSize: 12,
              lineHeight: 1.4,
              letterSpacing: '-0.005em',
              flexShrink: 0,
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            <WorkspaceReconnectDot />
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <strong style={{ fontWeight: 600, color: 'var(--t-text)' }}>Reconnecting to workspace runtime</strong>
              <span style={{ color: 'var(--t-text-muted)', fontWeight: 400 }}> · saved tabs stay in place, sessions reattach when the bridge returns</span>
            </span>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                flexShrink: 0,
              }}
            >
              {controller.activeTab?.kind === 'chat' && controller.activeCheckpoint ? (
                <motion.button
                  type="button"
                  onClick={() => controller.handleRestoreLatestCheckpoint(controller.activeTab!.id)}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 480, damping: 22, mass: 0.5 }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    border: '0.5px solid rgba(37, 99, 235, 0.32)',
                    borderRadius: 9,
                    background: 'rgba(37, 99, 235, 0.10)',
                    color: '#2563eb',
                    paddingTop: 4,
                    paddingBottom: 4,
                    paddingLeft: 10,
                    paddingRight: 10,
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '-0.005em',
                    fontFamily: 'var(--font-sans-system)',
                    flexShrink: 0,
                  }}
                >
                  <RotateCcw size={11} />
                  Restore checkpoint
                </motion.button>
              ) : null}
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
                  paddingBottom: 4,
                  paddingLeft: 10,
                  paddingRight: 10,
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '-0.005em',
                  fontFamily: 'var(--font-sans-system)',
                  flexShrink: 0,
                }}
              >
                Reload workspace
              </motion.button>
            </div>
          </motion.div>
        ) : null}

        {conversationHeaderLabel ? (
          <div
            title={conversationHeaderLabel}
            style={{
              minHeight: 34,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              paddingTop: 0,
              paddingRight: 12,
              paddingBottom: 0,
              paddingLeft: 14,
              borderBottom: '0.5px solid var(--t-divider-subtle)',
              background: 'var(--t-panel)',
              color: 'var(--t-text-secondary)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 12,
              lineHeight: '16px',
              fontWeight: 400,
              letterSpacing: 0,
              flexShrink: 0,
              minWidth: 0,
            }}
          >
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <ConversationHeaderText label={conversationHeaderLabel} />
            </span>
          </div>
        ) : null}

        {showTabBar ? (
          <TabBar
            tabs={topBarTabs}
            activeTabId={controller.effectiveActiveTabId}
            launchRequestKey={controller.launchRequestKey}
            onSelectTab={controller.handleSelectTab}
            onCloseTab={controller.handleCloseTab}
            onNewTab={controller.handleNewTab}
            onNewLLMChatTab={controller.handleNewLLMChatTab}
            scopedRepo={props.preferredRepo ?? controller.activeRepo ?? null}
            canCloseTile={props.canCloseTile}
            onCloseTile={props.onCloseTile}
            onReorderTabs={controller.handleReorderTabs}
          />
        ) : null}

        <WorkspaceTerminalPanels
          visibleTabs={controller.visibleTabs}
          effectiveActiveTabId={controller.effectiveActiveTabId}
          termWsConnected={controller.termWsConnected}
          panelRefs={controller.panelRefs}
          onLaunchWorkspace={() => controller.setLaunchRequestKey((value) => value + 1)}
          onCloseTab={controller.handleCloseTab}
          onRunInTerminal={controller.handleRunCommandInTerminal}
          onOpenHistoryChat={controller.handleOpenHistoryChat}
          onOpenWorkspaceCommitTab={controller.handleOpenWorkspaceCommitTab}
          onUpdateLlmSummary={controller.handleUpdateLlmSummary}
          onConsumeLlmDraftInjection={controller.handleConsumeLlmDraftInjection}
          onUpdateLinkedIssue={controller.handleUpdateLinkedIssue}
          onUpdateChatMessages={controller.handleUpdateChatMessages}
          onUpdateChatSessionKey={controller.handleUpdateChatSessionKey}
          onUpdateChatModel={controller.handleUpdateChatModel}
          onConsumeChatDraftInjection={controller.handleConsumeChatDraftInjection}
          onSaveCheckpoint={controller.handleSaveCheckpoint}
          onRestoreLatestCheckpoint={controller.handleRestoreLatestCheckpoint}
          sendTerminalAttach={props.sendTerminalAttach}
          sendTerminalInput={props.sendTerminalInput}
          sendTerminalResize={props.sendTerminalResize}
          sendTerminalDetach={props.sendTerminalDetach}
          onInjectChatContext={props.onInjectChatContext}
          onSelectCommit={props.onSelectCommit}
          onLaunchWorkspaceTask={props.onLaunchWorkspaceTask}
        />
      </div>
      </WorkspaceSpawnProvider>
    );
  },
);

function ConversationHeaderText({ label }: { label: string }) {
  const separator = ' / ';
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex < 0) return <>{label}</>;
  const repo = label.slice(0, separatorIndex);
  const title = label.slice(separatorIndex + separator.length);
  return (
    <>
      <span style={{ color: 'var(--t-text)', fontWeight: 500 }}>{repo}</span>
      <span style={{ color: 'var(--t-text-faint)', fontWeight: 400 }}> / </span>
      <span style={{ color: 'var(--t-text-secondary)', fontWeight: 400 }}>{title}</span>
    </>
  );
}

function WorkspaceReconnectDot() {
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
