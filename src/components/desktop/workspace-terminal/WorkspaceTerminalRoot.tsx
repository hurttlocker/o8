'use client';

import { forwardRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { PreviewPane } from '@/components/desktop/workspace-terminal/PreviewPane';
import { TabBar } from '@/components/desktop/workspace-terminal/TabBar';
import { THEME_ACCENT, THEME_ACCENT_SOFT_STRONG } from '@/components/desktop/workspace-terminal/constants';
import { useWorkspaceTerminalController } from '@/components/desktop/workspace-terminal/useWorkspaceTerminalController';
import { WorkspaceTerminalPanels } from '@/components/desktop/workspace-terminal/WorkspaceTerminalPanels';
import type { TerminalTabHandle, WorkspaceTerminalProps } from '@/components/desktop/workspace-terminal/types';

export const WorkspaceTerminalRoot = forwardRef<TerminalTabHandle, WorkspaceTerminalProps>(
  function WorkspaceTerminalRoot(props, ref) {
    const controller = useWorkspaceTerminalController(props, ref);
    const hasPreviews = (props.showPreviewPane ?? true) && controller.previews.length > 0;

    return (
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              justifyContent: 'space-between',
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 12,
              paddingRight: 12,
              borderBottom: '1px solid rgba(245, 158, 11, 0.16)',
              background: 'rgba(245, 158, 11, 0.08)',
              color: '#b45309',
              fontSize: 12,
              lineHeight: 1.45,
              flexShrink: 0,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              Reconnecting to the workspace runtime. Saved tabs stay in place and sessions reattach automatically when the bridge returns.
            </span>
            {controller.activeTab?.kind === 'chat' && controller.activeCheckpoint ? (
              <button
                type="button"
                onClick={() => controller.handleRestoreLatestCheckpoint(controller.activeTab!.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  border: 'none',
                  borderRadius: 999,
                  background: 'rgba(37, 99, 235, 0.12)',
                  color: '#1d4ed8',
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 8,
                  paddingRight: 8,
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  flexShrink: 0,
                }}
              >
                <RotateCcw size={11} />
                Restore latest checkpoint
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                border: 'none',
                borderRadius: 999,
                background: 'rgba(180, 83, 9, 0.12)',
                color: '#92400e',
                paddingTop: 4,
                paddingBottom: 4,
                paddingLeft: 8,
                paddingRight: 8,
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                flexShrink: 0,
              }}
            >
              Reload workspace
            </button>
          </div>
        ) : null}

        <TabBar
          tabs={controller.visibleTabs}
          activeTabId={controller.effectiveActiveTabId}
          launchRequestKey={controller.launchRequestKey}
          onSelectTab={controller.handleSelectTab}
          onCloseTab={controller.handleCloseTab}
          onNewTab={controller.handleNewTab}
          onNewChatTab={controller.handleNewChatTab}
          onNewLLMChatTab={controller.handleNewLLMChatTab}
          scopedRepo={props.preferredRepo ?? controller.activeRepo ?? null}
          onRegisterRepo={controller.handleRegisterRepo}
          onSplitVertical={props.onSplitVertical}
          onSplitHorizontal={props.onSplitHorizontal}
          canCloseTile={props.canCloseTile}
          onCloseTile={props.onCloseTile}
          onReorderTabs={controller.handleReorderTabs}
        />

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
    );
  },
);
