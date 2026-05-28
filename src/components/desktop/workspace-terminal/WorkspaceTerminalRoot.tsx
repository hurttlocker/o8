'use client';
/* eslint-disable react-hooks/refs -- useWorkspaceTerminalController returns render state and stable refs through one controller object. */

import { forwardRef, useEffect, useId, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
// RotateCcw shim removed with the in-workspace reconnect banner —
// recovery now lives in the AgentPanel ConnectionPill.
import { PreviewPane } from '@/components/desktop/workspace-terminal/PreviewPane';
import { THEME_ACCENT, THEME_ACCENT_SOFT_STRONG } from '@/components/desktop/workspace-terminal/constants';
import { useWorkspaceTerminalController } from '@/components/desktop/workspace-terminal/useWorkspaceTerminalController';
import { WorkspaceTerminalPanels } from '@/components/desktop/workspace-terminal/WorkspaceTerminalPanels';
import { WorkspaceSpawnProvider, type WorkspaceSpawnHandlers } from '@/components/desktop/workspace-terminal/spawn-context';
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
    const activeTab = controller.activeTab;
    // workspaceConversationHeaderLabel only knows chat-shaped tabs
    // (orchestrator / llm-chat / single-runtime chat). For terminals
    // and canvas tabs we fall back to "<repo> / Shell" or "<repo> /
    // Canvas" so the title strip never reads blank.
    const conversationHeaderLabel = (() => {
      if (!activeTab) return null;
      const chatLabel = workspaceConversationHeaderLabel(activeTab);
      if (chatLabel) return chatLabel;
      const repoName = activeTab.repo?.name
        ?? (activeTab.repo?.localPath ? activeTab.repo.localPath.split('/').filter(Boolean).pop() ?? null : null);
      const kindLabel = activeTab.kind === 'terminal'
        ? 'Shell'
        : activeTab.kind === 'canvas'
          ? 'Canvas'
          : null;
      if (!kindLabel) return null;
      return repoName ? `${repoName} / ${kindLabel}` : kindLabel;
    })();

    // Stable workspace instance id — declared early so the spawn /
    // close event listeners below can use it.
    const workspaceInstanceId = useId();

    // Listen for header spawn / close-workspace requests. Events
    // include an optional workspaceId — when set, only the matching
    // pane responds. Untargeted events (single-mode global play) only
    // the lone pane responds (canCloseTile = false). Lets two split
    // panes' header play buttons drive their own spawns.
    const handleNewTab = controller.handleNewTab;
    const handleNewLLMChatTab = controller.handleNewLLMChatTab;
    const spawnOrchestratorTab = controller.spawnOrchestratorTab;
    const activeRepo = controller.activeRepo;
    const preferredRepo = props.preferredRepo;
    const onCloseTile = props.onCloseTile;
    useEffect(() => {
      if (typeof window === 'undefined') return;
      const matchWorkspace = (eventWorkspaceId: string | null | undefined) => {
        if (!eventWorkspaceId) return props.canCloseTile !== true;
        return eventWorkspaceId === workspaceInstanceId;
      };
      const onSpawn = (event: Event) => {
        const detail = (event as CustomEvent<{ kind?: string; workspaceId?: string }>).detail;
        if (!matchWorkspace(detail?.workspaceId)) return;
        const repo = preferredRepo ?? activeRepo ?? undefined;
        if (detail?.kind === 'orchestrator') spawnOrchestratorTab?.();
        else if (detail?.kind === 'chat') handleNewLLMChatTab(repo ?? undefined);
        else if (detail?.kind === 'terminal') handleNewTab('shell', repo ?? undefined);
      };
      const onCloseWorkspace = (event: Event) => {
        const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
        if (detail?.workspaceId !== workspaceInstanceId) return;
        onCloseTile?.();
      };
      window.addEventListener('o8:request-spawn-tab', onSpawn as EventListener);
      window.addEventListener('o8:request-close-workspace', onCloseWorkspace as EventListener);
      return () => {
        window.removeEventListener('o8:request-spawn-tab', onSpawn as EventListener);
        window.removeEventListener('o8:request-close-workspace', onCloseWorkspace as EventListener);
      };
    }, [props.canCloseTile, handleNewTab, handleNewLLMChatTab, spawnOrchestratorTab, activeRepo, preferredRepo, onCloseTile, workspaceInstanceId]);

    // Broadcast the active-tab label + tabId + kind + workspaceId + full
    // tabs list so the dashboard can route the title to the column-level
    // header strip (one workspace) or hide it on splits (more than one),
    // surface the multi-tab pill strip when 2+ tabs exist, and drive the
    // `…` / right-click menu actions when applicable.
    const activeTabId = controller.activeTab?.id ?? null;
    const activeTabKind = controller.activeTab?.kind ?? null;
    const projectContextRailAvailable = activeTabKind === 'orchestrator' || activeTabKind === 'llm-chat';
    const [projectContextRailVisible, setProjectContextRailVisible] = useState(true);
    const tabsForBroadcast = useMemo(() => (
      controller.visibleTabs.map((tab) => ({
        id: tab.id,
        label: tab.label ?? '',
        kind: tab.kind,
        runtime: tab.kind === 'orchestrator'
          ? (tab.singleRuntime ?? 'claude-code')
          : (tab.chatRuntime ?? null),
        packetStatus: tab.orchestrationPacket?.status ?? null,
      }))
    ), [controller.visibleTabs]);

    useEffect(() => {
      if (typeof window === 'undefined') return;
      const onToggle = (event: Event) => {
        const detail = (event as CustomEvent<{ workspaceId?: string | null }>).detail;
        const eventWorkspaceId = detail?.workspaceId;
        if (eventWorkspaceId && eventWorkspaceId !== workspaceInstanceId) return;
        if (!eventWorkspaceId && props.canCloseTile === true) return;
        setProjectContextRailVisible((value) => !value);
      };
      window.addEventListener('o8:request-toggle-context-rail', onToggle as EventListener);
      return () => window.removeEventListener('o8:request-toggle-context-rail', onToggle as EventListener);
    }, [props.canCloseTile, workspaceInstanceId]);

    useEffect(() => {
      if (typeof window === 'undefined') return;
      window.dispatchEvent(new CustomEvent('o8:workspace-active-label', {
        detail: {
          workspaceId: workspaceInstanceId,
          label: conversationHeaderLabel,
          tabId: activeTabId,
          kind: activeTabKind,
          tabs: tabsForBroadcast,
          contextRailAvailable: projectContextRailAvailable,
          contextRailVisible: projectContextRailVisible,
        },
      }));
      return () => {
        window.dispatchEvent(new CustomEvent('o8:workspace-active-label', {
          detail: {
            workspaceId: workspaceInstanceId,
            label: null,
            tabId: null,
            kind: null,
            tabs: [],
            contextRailAvailable: false,
            contextRailVisible: false,
            removed: true,
          },
        }));
      };
    }, [conversationHeaderLabel, activeTabId, activeTabKind, workspaceInstanceId, tabsForBroadcast, projectContextRailAvailable, projectContextRailVisible]);

    // Listen for chat-history rename so the workspace tab's label
    // refreshes in sync with the chat-history PATCH. The header strip
    // reads tab.label via workspaceConversationHeaderLabel — without
    // this update the renamed title would lag until a remount.
    const handleUpdateTabLabel = controller.handleUpdateTabLabel;
    useEffect(() => {
      if (typeof window === 'undefined') return;
      const onRename = (event: Event) => {
        const detail = (event as CustomEvent<{ tabId?: string; title?: string }>).detail;
        if (!detail?.tabId || typeof detail.title !== 'string') return;
        handleUpdateTabLabel(detail.tabId, detail.title);
      };
      window.addEventListener('o8:chat-history-updated', onRename as EventListener);
      return () => window.removeEventListener('o8:chat-history-updated', onRename as EventListener);
    }, [handleUpdateTabLabel]);

    // Listen for header pill clicks. In single mode (no split) we
    // accept events that omit workspaceId; in split mode each pane
    // claims only events carrying its own workspaceId. Lets two
    // SplitHeaderPillStrips in the global header drive both panes
    // without crosstalk.
    const handleSelectTab = controller.handleSelectTab;
    const handleCloseTab = controller.handleCloseTab;
    useEffect(() => {
      if (typeof window === 'undefined') return;
      const matchWorkspace = (eventWorkspaceId: string | null | undefined) => {
        if (!eventWorkspaceId) {
          // Untargeted event — only the single pane should claim it.
          return props.canCloseTile !== true;
        }
        return eventWorkspaceId === workspaceInstanceId;
      };
      const onSelect = (event: Event) => {
        const detail = (event as CustomEvent<{ tabId?: string; workspaceId?: string }>).detail;
        if (!matchWorkspace(detail?.workspaceId)) return;
        if (detail?.tabId) handleSelectTab(detail.tabId);
      };
      const onClose = (event: Event) => {
        const detail = (event as CustomEvent<{ tabId?: string; workspaceId?: string }>).detail;
        if (!matchWorkspace(detail?.workspaceId)) return;
        if (detail?.tabId) handleCloseTab(detail.tabId);
      };
      window.addEventListener('o8:request-select-tab', onSelect as EventListener);
      window.addEventListener('o8:request-close-tab', onClose as EventListener);
      return () => {
        window.removeEventListener('o8:request-select-tab', onSelect as EventListener);
        window.removeEventListener('o8:request-close-tab', onClose as EventListener);
      };
    }, [props.canCloseTile, handleSelectTab, handleCloseTab, workspaceInstanceId]);

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
          position: 'relative',
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

        {/* The full-width "Reconnecting to workspace runtime" banner used
            to live here. It covered the workspace tab strip whenever
            the WS dropped. The same state now surfaces as a compact
            ConnectionPill inside AgentPanel (above UpdateCard) so the
            workspace stays uncovered. The "Restore checkpoint" recovery
            action still exists on each chat tab's header strip. */}

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
          projectContextRailVisible={projectContextRailVisible}
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

// WorkspaceReconnectDot retired — see comment above where the
// in-workspace reconnect banner used to render.
