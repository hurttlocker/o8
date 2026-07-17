'use client';

import { MutableRefObject, Suspense, memo, useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon } from '../lucide-shims';
import type { CanvasTab } from '@/components/desktop/Canvas';
import { WorkspaceChatPane } from '@/components/desktop/workspace-terminal/WorkspaceChatPane';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { repoSlugFromRemote, shortenPath } from '@/components/desktop/workspace-terminal/utils';
import { XtermPanel, type XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { WorkspaceBootLoaderClaim } from '@/components/desktop/workspace-terminal/workspace-boot-loader-claim';
import { retryingLazy } from '@/lib/react/retrying-lazy';

// LazyLLMChat used to render the Assistant tab (kind='llm-chat'). The
// chooser-spawn rewrite routes both orchestrator and llm-chat tabs
// through OrchestratorTab now (chat tabs run with lockedMode='chat'),
// so the standalone LLMChat surface is no longer mounted from here.
const LazyCanvas = retryingLazy(() => import('@/components/desktop/Canvas').then((module) => ({ default: module.Canvas })), { label: 'Canvas' });
const LazyOrchestratorTab = retryingLazy(() => import('@/components/desktop/workspace-terminal/OrchestratorTab').then((module) => ({ default: module.OrchestratorTab })), { label: 'Orchestrator tab' });
const LazyFleetCanvasTab = retryingLazy(() => import('@/components/desktop/workspace-terminal/FleetCanvasTab').then((module) => ({ default: module.FleetCanvasTab })), { label: 'Fleet canvas' });

interface WorkspaceTerminalPanelsProps {
  visibleTabs: TerminalTab[];
  /** True once the tab restore for the CURRENT restore key has landed. While
   *  false, a zero-tab workspace is "not restored yet", never "empty" — the
   *  CTA must not render a clickable surface whose spawns a landing restore
   *  would clobber (GQXEZD). */
  restoreSettled: boolean;
  effectiveActiveTabId: string;
  termWsConnected: boolean;
  panelRefs: MutableRefObject<Map<string, XtermPanelHandle>>;
  onCloseTab: (tabId: string) => void;
  onRunInTerminal: (command: string) => void;
  onOpenWorkspaceCommitTab: (hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => void;
  onUpdateLlmSummary: (tabId: string, summary: string | null) => void;
  onUpdateLinkedIssue: (tabId: string, linkedIssue: import('@/components/desktop/IssueLinkPicker').LinkedIssueRef | null) => void;
  onUpdateChatMessages: (tabId: string, messages: import('@/lib/mobile/types').MobileTranscriptEntry[]) => void;
  onUpdateChatSessionKey: (tabId: string, sessionKey: string) => void;
  onUpdateChatModel: (tabId: string, modelId: string) => void;
  onConsumeChatDraftInjection: (tabId: string, injectionId: string) => void;
  onSaveCheckpoint: (tabId: string) => void;
  onRestoreLatestCheckpoint: (tabId: string) => void;
  projectContextRailVisible: boolean;
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
  onCloseTab,
  onRunInTerminal,
  onOpenWorkspaceCommitTab,
  onUpdateLlmSummary,
  onUpdateLinkedIssue,
  onUpdateChatMessages,
  onUpdateChatSessionKey,
  onUpdateChatModel,
  onConsumeChatDraftInjection,
  onSaveCheckpoint,
  onRestoreLatestCheckpoint,
  projectContextRailVisible,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
  onInjectChatContext,
  onSelectCommit,
  onLaunchWorkspaceTask,
  restoreSettled,
}: WorkspaceTerminalPanelsProps) {
  // Track whether this workspace has EVER shown a tab. On a fresh mount
  // (page reload) tabs hydrate async, so visibleTabs is momentarily 0 — that's
  // the boot window, NOT a genuinely empty workspace. We only let the
  // "Start a new session" CTA appear once tabs have actually populated and then
  // been closed; during boot we hold the loader so the picker never flickers.
  const hasEverHadTabsRef = useRef(false);
  useEffect(() => {
    if (visibleTabs.length > 0) hasEverHadTabsRef.current = true;
  }, [visibleTabs.length]);
  // Boot claim while the tab restore is UNSETTLED — even when default tabs
  // already render. The boot restore re-runs when the repo registry hydrates
  // late (restoreKey flips 'no-repo' → repo), and without this hold the
  // splash revealed the default tabs at ~10s and the real restored tabs
  // popped into the strip ~6s later (prod boot recording 2026-07-17). After
  // the boot latch a mid-session restoreKey flip claims into a no-op, so
  // repo switches never re-summon the splash. Fail-open cap mirrors the
  // EmptyWorkspaceState grace so a restore that never settles can't hold
  // boot hostage.
  const [restoreHoldExpired, setRestoreHoldExpired] = useState(false);
  useEffect(() => {
    if (restoreSettled) return;
    setRestoreHoldExpired(false);
    const timer = window.setTimeout(() => setRestoreHoldExpired(true), 15000);
    return () => window.clearTimeout(timer);
  }, [restoreSettled]);
  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--t-chat-surface-bg, var(--t-panel))' }}>
      {!restoreSettled && !restoreHoldExpired ? <WorkspaceBootLoaderClaim /> : null}
      {visibleTabs.map((tab) => (
        tab.kind === 'orchestrator' ? (
          <OrchestratorResidentPanel
            key={tab.id}
            tab={tab}
            active={tab.id === effectiveActiveTabId}
            projectContextRailVisible={projectContextRailVisible}
            onUpdateLlmSummary={onUpdateLlmSummary}
          />
        ) : tab.kind === 'llm-chat' ? (
          <OrchestratorResidentPanel
            key={tab.id}
            tab={tab}
            active={tab.id === effectiveActiveTabId}
            projectContextRailVisible={projectContextRailVisible}
            onUpdateLlmSummary={onUpdateLlmSummary}
          />
        ) : tab.kind === 'chat' ? (
          <ChatResidentPanel
            key={tab.id}
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
        ) : tab.kind === 'fleet-canvas' ? (
          <FleetCanvasResidentPanel key={tab.id} active={tab.id === effectiveActiveTabId} repoPath={tab.repo?.localPath ?? null} />
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
          <TerminalResidentPanel
            key={tab.tmuxSession}
            tmuxSession={tab.tmuxSession}
            panelRefs={panelRefs}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalDetach={sendTerminalDetach}
            active={tab.id === effectiveActiveTabId}
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
        <EmptyWorkspaceState hasEverHadTabs={hasEverHadTabsRef.current} restoreSettled={restoreSettled} />
      ) : null}
    </div>
  );
}

/** What renders when the center workspace has no tabs:
 *  - BOOT / RELOAD: tabs hydrate async, so visibleTabs is briefly 0. This is
 *    NOT a real empty workspace — show the o8 boot loader and NEVER the CTA,
 *    so "Start a new session" never flickers before the tabs arrive. The
 *    moment tabs hydrate this whole branch unmounts.
 *  - GENUINELY EMPTY: tabs existed and were all closed (hasEverHadTabs) — now
 *    the "Start a new session" CTA is the right thing to show.
 *  A long fallback grace covers the rare workspace that truly never spawns a
 *  tab, so we don't sit on the loader forever. */
function EmptyWorkspaceState({ hasEverHadTabs, restoreSettled }: { hasEverHadTabs: boolean; restoreSettled: boolean }) {
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    if (hasEverHadTabs && restoreSettled) return;
    // While a restore is unsettled, a zero-tab workspace is a boot/re-restore
    // window, NOT genuinely empty — spawns clicked into a premature CTA get
    // clobbered by the landing restore (GQXEZD, wide on Rosetta). Hold the
    // loader with a long fail-open grace so a restore that never settles
    // still surfaces the CTA eventually instead of a forever-spinner.
    setGraceExpired(false);
    const timer = window.setTimeout(() => setGraceExpired(true), restoreSettled ? 4000 : 15000);
    return () => window.clearTimeout(timer);
  }, [hasEverHadTabs, restoreSettled]);
  return ((hasEverHadTabs && restoreSettled) || graceExpired) ? <EmptyWorkspaceCTA /> : <WorkspaceBootLoaderClaim />;
}

/** Centered three-way CTA for the empty workspace state. Operator
 *  dogfood noted the old "Launch workspace" button was opaque — what
 *  is a workspace? Spelling out Orchestrator / Chat / Terminal gives
 *  a first-time user the actual mental model.
 *
 *  Each card dispatches o8:request-spawn-tab — the same event the
 *  global header play button uses — so spawn lands in this workspace. */
function EmptyWorkspaceCTA() {
  const spawn = (kind: 'orchestrator' | 'chat' | 'terminal') => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind } }));
  };
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, textAlign: 'center', maxWidth: 560 }}>
        <div style={{ color: 'var(--t-text)', fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Start a new session
        </div>
        <div style={{ color: 'var(--t-text-muted)', fontSize: 12.5, lineHeight: 1.55, maxWidth: 440 }}>
          Pick how you want to work. You can switch between sessions and spawn more from the play button in the header.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))', gap: 10, marginTop: 8 }}>
          <EmptyWorkspaceCard
            label="Orchestrator"
            hint="Plan & dispatch with Claude"
            onClick={() => spawn('orchestrator')}
          />
          <EmptyWorkspaceCard
            label="Chat"
            hint="Direct LLM conversation"
            onClick={() => spawn('chat')}
          />
          <EmptyWorkspaceCard
            label="Terminal"
            hint="Plain shell, no chat"
            onClick={() => spawn('terminal')}
          />
        </div>
      </div>
    </div>
  );
}

function EmptyWorkspaceCard({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        padding: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-hover)';
        e.currentTarget.style.borderColor = 'var(--t-accent-border, rgba(37, 99, 235, 0.3))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.borderColor = 'var(--t-divider)';
      }}
    >
      <span style={{ color: 'var(--t-text)', fontSize: 12.5, fontWeight: 600, letterSpacing: '-0.005em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--t-text-muted)', fontSize: 11, lineHeight: 1.4 }}>
        {hint}
      </span>
    </button>
  );
}

export const WorkspaceTerminalPanels = memo(WorkspaceTerminalPanelsBase);

const OrchestratorResidentPanel = memo(function OrchestratorResidentPanel({
  tab,
  active,
  projectContextRailVisible,
  onUpdateLlmSummary,
}: {
  tab: TerminalTab;
  active: boolean;
  projectContextRailVisible: boolean;
  onUpdateLlmSummary: (tabId: string, summary: string | null) => void;
}) {
  if (tab.kind === 'llm-chat') {
    return (
      <Suspense fallback={null}>
        <LazyOrchestratorTab
          tabId={tab.id}
          active={active}
          repoPath={tab.repo?.localPath ?? null}
          repoLabel={tab.repo?.name ?? null}
          lockedMode="chat"
          initialMode="chat"
          initialChatModelId={tab.chatModelId}
          initialChatOpenrouterModel={tab.chatOpenrouterModel}
          initialThreadId={tab.id}
          projectContextRailVisible={projectContextRailVisible}
          onChatSummary={(text) => onUpdateLlmSummary(tab.id, text)}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={active ? <WorkspaceBootLoaderClaim /> : null}>
      <LazyOrchestratorTab
        tabId={tab.id}
        active={active}
        repoPath={tab.repo?.localPath ?? null}
        repoLabel={tab.repo?.name ?? null}
        initialMode={tab.mode}
        initialSingleRuntime={tab.singleRuntime}
        initialChatModelId={tab.chatModelId}
        initialThreadId={tab.orchestratorThreadId ?? (tab.id.startsWith('thoughts-') ? tab.id : undefined)}
        restoringPersistedThread={Boolean(tab.orchestratorThreadId)}
        projectContextRailVisible={projectContextRailVisible}
        onChatSummary={(text) => onUpdateLlmSummary(tab.id, text)}
        restoreLastThread={!tab.freshSpawn}
        turnInjection={tab.orchestratorTurnInjection}
      />
    </Suspense>
  );
});

const ChatResidentPanel = memo(function ChatResidentPanel({
  tab,
  active,
  onUpdateMessages,
  onUpdateSessionKey,
  onRunInTerminal,
  onSelectModel,
  onConsumeDraftInjection,
  onLinkedIssueChange,
  onSaveCheckpoint,
  onRestoreLatestCheckpoint,
}: {
  tab: TerminalTab;
  active: boolean;
  onUpdateMessages: WorkspaceTerminalPanelsProps['onUpdateChatMessages'];
  onUpdateSessionKey: WorkspaceTerminalPanelsProps['onUpdateChatSessionKey'];
  onRunInTerminal: WorkspaceTerminalPanelsProps['onRunInTerminal'];
  onSelectModel: WorkspaceTerminalPanelsProps['onUpdateChatModel'];
  onConsumeDraftInjection: WorkspaceTerminalPanelsProps['onConsumeChatDraftInjection'];
  onLinkedIssueChange: WorkspaceTerminalPanelsProps['onUpdateLinkedIssue'];
  onSaveCheckpoint: WorkspaceTerminalPanelsProps['onSaveCheckpoint'];
  onRestoreLatestCheckpoint: WorkspaceTerminalPanelsProps['onRestoreLatestCheckpoint'];
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
      }}
    >
      <WorkspaceChatPane
        tab={tab}
        active={active}
        onUpdateMessages={onUpdateMessages}
        onUpdateSessionKey={onUpdateSessionKey}
        onRunInTerminal={onRunInTerminal}
        onSelectModel={onSelectModel}
        onConsumeDraftInjection={onConsumeDraftInjection}
        onLinkedIssueChange={onLinkedIssueChange}
        onSaveCheckpoint={onSaveCheckpoint}
        onRestoreLatestCheckpoint={onRestoreLatestCheckpoint}
      />
    </div>
  );
});

const FleetCanvasResidentPanel = memo(function FleetCanvasResidentPanel({ active, repoPath }: { active: boolean; repoPath: string | null }) {
  return (
    <Suspense fallback={null}>
      <LazyFleetCanvasTab active={active} repoPath={repoPath} />
    </Suspense>
  );
});

const TerminalResidentPanel = memo(function TerminalResidentPanel({
  tmuxSession,
  panelRefs,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
  active,
}: {
  tmuxSession: string;
  panelRefs: MutableRefObject<Map<string, XtermPanelHandle>>;
  sendTerminalAttach: WorkspaceTerminalPanelsProps['sendTerminalAttach'];
  sendTerminalInput: WorkspaceTerminalPanelsProps['sendTerminalInput'];
  sendTerminalResize: WorkspaceTerminalPanelsProps['sendTerminalResize'];
  sendTerminalDetach: WorkspaceTerminalPanelsProps['sendTerminalDetach'];
  active: boolean;
}) {
  return (
    <XtermPanel
      ref={(handle) => {
        if (handle) panelRefs.current.set(tmuxSession, handle);
        else panelRefs.current.delete(tmuxSession);
      }}
      tmuxSession={tmuxSession}
      sendTerminalAttach={sendTerminalAttach}
      sendTerminalInput={sendTerminalInput}
      sendTerminalResize={sendTerminalResize}
      sendTerminalDetach={sendTerminalDetach}
      visible={active}
    />
  );
});

const CanvasPanel = memo(function CanvasPanel({
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
});

const PendingTerminalPanel = memo(function PendingTerminalPanel({
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
        fontFamily: 'var(--font-sans-system)',
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
});
