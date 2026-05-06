'use client';

import { MutableRefObject, Suspense, lazy, memo } from 'react';
import { Terminal as TerminalIcon } from '../lucide-shims';
import type { CanvasTab } from '@/components/desktop/Canvas';
import { WorkspaceChatPane } from '@/components/desktop/workspace-terminal/WorkspaceChatPane';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { repoSlugFromRemote, shortenPath } from '@/components/desktop/workspace-terminal/utils';
import { XtermPanel, type XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';

// LazyLLMChat used to render the Assistant tab (kind='llm-chat'). The
// chooser-spawn rewrite routes both orchestrator and llm-chat tabs
// through OrchestratorTab now (chat tabs run with lockedMode='chat'),
// so the standalone LLMChat surface is no longer mounted from here.
const LazyCanvas = lazy(() => import('@/components/desktop/Canvas').then((module) => ({ default: module.Canvas })));
const LazyOrchestratorTab = lazy(() => import('@/components/desktop/workspace-terminal/OrchestratorTab').then((module) => ({ default: module.OrchestratorTab })));

interface WorkspaceTerminalPanelsProps {
  visibleTabs: TerminalTab[];
  effectiveActiveTabId: string;
  termWsConnected: boolean;
  panelRefs: MutableRefObject<Map<string, XtermPanelHandle>>;
  onLaunchWorkspace: () => void;
  onCloseTab: (tabId: string) => void;
  onRunInTerminal: (command: string) => void;
  onOpenHistoryChat: (
    currentTab: TerminalTab,
    historyTabId: string,
    title: string,
    historyRepo?: { name?: string; localPath?: string; branch?: string | null; remoteUrl?: string | null } | null,
  ) => void;
  onOpenWorkspaceCommitTab: (hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => void;
  onUpdateLlmSummary: (tabId: string, summary: string | null) => void;
  onConsumeLlmDraftInjection: (tabId: string, injectionId: string) => void;
  onUpdateLinkedIssue: (tabId: string, linkedIssue: import('@/components/desktop/IssueLinkPicker').LinkedIssueRef | null) => void;
  onUpdateChatMessages: (tabId: string, messages: import('@/lib/mobile/types').MobileTranscriptEntry[]) => void;
  onUpdateChatSessionKey: (tabId: string, sessionKey: string) => void;
  onUpdateChatModel: (tabId: string, modelId: string) => void;
  onConsumeChatDraftInjection: (tabId: string, injectionId: string) => void;
  onSaveCheckpoint: (tabId: string) => void;
  onRestoreLatestCheckpoint: (tabId: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  onInjectChatContext?: (payload: import('@/lib/chat/injection').AgentPanelChatInjectionPayload) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onLaunchWorkspaceTask?: (request: import('@/components/desktop/Canvas').CanvasRepoTaskLaunchRequest) => Promise<void>;
}

function WorkspaceTerminalPanelsBase({
  visibleTabs,
  effectiveActiveTabId,
  termWsConnected,
  panelRefs,
  onLaunchWorkspace,
  onCloseTab,
  onRunInTerminal,
  onOpenHistoryChat,
  onOpenWorkspaceCommitTab,
  onUpdateLlmSummary,
  onConsumeLlmDraftInjection,
  onUpdateLinkedIssue,
  onUpdateChatMessages,
  onUpdateChatSessionKey,
  onUpdateChatModel,
  onConsumeChatDraftInjection,
  onSaveCheckpoint,
  onRestoreLatestCheckpoint,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
  onInjectChatContext,
  onSelectCommit,
  onLaunchWorkspaceTask,
}: WorkspaceTerminalPanelsProps) {
  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--t-chat-surface-bg, var(--t-panel))' }}>
      {visibleTabs.map((tab) => (
        tab.kind === 'orchestrator' ? (
          <Suspense key={tab.id} fallback={null}>
            <LazyOrchestratorTab
              tabId={tab.id}
              active={tab.id === effectiveActiveTabId}
              repoPath={tab.repo?.localPath ?? null}
              repoLabel={tab.repo?.name ?? null}
              lockedMode={tab.mode === 'single' ? 'single' : undefined}
              initialMode={tab.mode}
              initialSingleRuntime={tab.singleRuntime}
              initialChatModelId={tab.chatModelId}
            />
          </Suspense>
        ) : tab.kind === 'llm-chat' ? (
          <Suspense key={tab.id} fallback={null}>
            <LazyOrchestratorTab
              tabId={tab.id}
              active={tab.id === effectiveActiveTabId}
              repoPath={tab.repo?.localPath ?? null}
              repoLabel={tab.repo?.name ?? null}
              lockedMode="chat"
              initialMode="chat"
              initialChatModelId={tab.chatModelId}
              initialChatOpenrouterModel={tab.chatOpenrouterModel}
            />
          </Suspense>
        ) : tab.kind === 'chat' ? (
          <div
            key={tab.id}
            aria-hidden={tab.id !== effectiveActiveTabId}
            style={{
              display: 'flex',
              flexDirection: 'column',
              visibility: tab.id === effectiveActiveTabId ? 'visible' : 'hidden',
              pointerEvents: tab.id === effectiveActiveTabId ? 'auto' : 'none',
              position: tab.id === effectiveActiveTabId ? 'relative' : 'absolute',
              inset: 0,
              flex: tab.id === effectiveActiveTabId ? 1 : undefined,
              height: '100%',
              minHeight: 0,
            }}
          >
            <WorkspaceChatPane
              tab={tab}
              active={tab.id === effectiveActiveTabId}
              onUpdateMessages={onUpdateChatMessages}
              onUpdateSessionKey={onUpdateChatSessionKey}
              onRunInTerminal={onRunInTerminal}
              onSelectModel={onUpdateChatModel}
              onConsumeDraftInjection={onConsumeChatDraftInjection}
              onLinkedIssueChange={onUpdateLinkedIssue}
              onSaveCheckpoint={onSaveCheckpoint}
              onRestoreLatestCheckpoint={onRestoreLatestCheckpoint}
            />
          </div>
        ) : tab.kind === 'canvas' && tab.canvasTab ? (
          <CanvasPanel
            key={tab.id}
            tab={tab as TerminalTab & { canvasTab: CanvasTab }}
            active={tab.id === effectiveActiveTabId}
            onCloseTab={onCloseTab}
            onInjectChatContext={onInjectChatContext}
            onSelectCommit={onSelectCommit}
            onLaunchWorkspaceTask={onLaunchWorkspaceTask}
            onOpenWorkspaceCommitTab={onOpenWorkspaceCommitTab}
          />
        ) : tab.tmuxSession ? (
          <XtermPanel
            key={tab.tmuxSession}
            ref={(handle) => {
              if (handle) panelRefs.current.set(tab.tmuxSession!, handle);
              else panelRefs.current.delete(tab.tmuxSession!);
            }}
            tmuxSession={tab.tmuxSession}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalDetach={sendTerminalDetach}
            visible={tab.id === effectiveActiveTabId}
          />
        ) : (
          <PendingTerminalPanel
            key={tab.id}
            tab={tab}
            termWsConnected={termWsConnected}
            active={tab.id === effectiveActiveTabId}
          />
        )
      ))}

      {visibleTabs.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', maxWidth: 320 }}>
            <div
              style={{
                width: 40,
                height: 40,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 12,
                background: 'rgba(148, 163, 184, 0.08)',
                color: 'var(--t-text-muted)',
              }}
            >
              <TerminalIcon size={18} />
            </div>
            <div style={{ color: 'var(--t-text-muted)', fontSize: 14, fontWeight: 600 }}>
              Workspace surface idle
            </div>
            <div style={{ color: 'var(--t-text-muted)', fontSize: 12, lineHeight: 1.5 }}>
              Open a terminal, chat, or canvas in this workspace. The shell can stay active in the background even when no terminal tab is open.
            </div>
            <button
              type="button"
              onClick={onLaunchWorkspace}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                minHeight: 32,
                paddingTop: 0,
                paddingBottom: 0,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 9,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(37, 99, 235, 0.3)',
                background: 'rgba(37, 99, 235, 0.1)',
                color: '#2563eb',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <TerminalIcon size={14} />
              Launch workspace
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const WorkspaceTerminalPanels = memo(WorkspaceTerminalPanelsBase);

function CanvasPanel({
  tab,
  active,
  onCloseTab,
  onInjectChatContext,
  onSelectCommit,
  onLaunchWorkspaceTask,
  onOpenWorkspaceCommitTab,
}: {
  tab: TerminalTab & { canvasTab: CanvasTab };
  active: boolean;
  onCloseTab: (tabId: string) => void;
  onInjectChatContext?: (payload: import('@/lib/chat/injection').AgentPanelChatInjectionPayload) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onLaunchWorkspaceTask?: (request: import('@/components/desktop/Canvas').CanvasRepoTaskLaunchRequest) => Promise<void>;
  onOpenWorkspaceCommitTab: (hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => void;
}) {
  return (
    <div
      aria-hidden={!active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
        position: active ? 'relative' : 'absolute',
        inset: 0,
        flex: active ? 1 : undefined,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <Suspense fallback={null}>
        <LazyCanvas
          tabs={[tab.canvasTab]}
          activeTabId={tab.canvasTab.id}
          onSelectTab={() => undefined}
          onCloseTab={() => onCloseTab(tab.id)}
          selectedRepo={repoSlugFromRemote(tab.repo?.remoteUrl) ?? null}
          onInjectChatContext={onInjectChatContext}
          onSelectCommit={(hash, meta) => {
            if (tab.repo || meta?.workspace) {
              onOpenWorkspaceCommitTab(hash, meta, tab.repo);
              return;
            }
            onSelectCommit?.(hash, meta);
          }}
          onLaunchWorkspaceTask={onLaunchWorkspaceTask}
          embedded
        />
      </Suspense>
    </div>
  );
}

function PendingTerminalPanel({
  tab,
  termWsConnected,
  active,
}: {
  tab: TerminalTab;
  termWsConnected: boolean;
  active: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: active ? 'flex' : 'none',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        flexDirection: 'column',
        gap: 8,
        textAlign: 'center',
        paddingTop: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <TerminalIcon size={14} />
      <div style={{ fontWeight: 600, color: 'var(--t-text-secondary)' }}>
        {termWsConnected ? 'Starting workspace lane...' : 'Waiting for the workspace bridge...'}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 420 }}>
        {tab.repo?.localPath
          ? `Restoring ${tab.repo.name} in ${shortenPath(tab.repo.localPath)} and replaying the saved repo context.`
          : 'This tab will attach automatically as soon as the runtime is available.'}
      </div>
    </div>
  );
}
