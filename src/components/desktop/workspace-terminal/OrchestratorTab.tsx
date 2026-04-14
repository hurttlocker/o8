'use client';

/**
 * OrchestratorTab — full-workspace orchestrator surface inside a
 * WorkspaceTerminal tab. Three-pane layout:
 *
 *   ┌───────┬────────────────────┬──────────┐
 *   │History│ Chat (ThoughtsChat)│ Mission  │
 *   │(260px)│                    │(320px)   │
 *   │ left  │                    │ right    │
 *   └───────┴────────────────────┴──────────┘
 *
 * Both side panels are collapsed by default and toggle via the header
 * (History button, Mission button). This lets the orchestrator host
 * past-conversation browsing AND mission planning without ever leaving
 * the chat — no tab switching, no lost flow.
 *
 * Data deps come from OrchestratorDataContext (provided at the
 * dashboard level) so WorkspaceTerminal doesn't prop-drill them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  OrchestratorEmptyState,
  timeOfDayGreeting,
} from '@/components/desktop/OrchestratorEmptyState';
import { OrchestratorHistorySidebar } from '@/components/desktop/OrchestratorHistorySidebar';
import { SessionVisualizer } from '@/components/desktop/SessionVisualizer';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import {
  ThoughtsChatPanel,
  type ThoughtsChatPanelChromeState,
  type ThoughtsChatPanelHandle,
  type ThoughtsChatPermissionMode,
} from '@/components/desktop/thoughts/ThoughtsChatPanel';
import { ThoughtsMissionPanel } from '@/components/desktop/thoughts/ThoughtsMissionPanel';
import { buildAgentTargets } from '@/components/desktop/thoughts/utils';

interface OrchestratorTabProps {
  tabId: string;
  active: boolean;
  repoPath?: string | null;
  repoLabel?: string | null;
}

function permissionStorageKey(tabId: string): string {
  return `cortex-ide:orchestrator-permission:tab:${tabId}`;
}

function readStoredPermissionMode(tabId: string): ThoughtsChatPermissionMode {
  if (typeof window === 'undefined') return 'full';
  try {
    const raw = window.localStorage.getItem(permissionStorageKey(tabId));
    return raw === 'plan' ? 'plan' : 'full';
  } catch {
    return 'full';
  }
}

function persistPermissionMode(tabId: string, mode: ThoughtsChatPermissionMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(permissionStorageKey(tabId), mode);
  } catch {
    // ignore
  }
}

const HISTORY_OPEN_KEY = 'o8:orchestrator:history-open';
const MISSION_OPEN_KEY = 'o8:orchestrator:mission-open';

function readBooleanPref(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeBooleanPref(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore
  }
}

export function OrchestratorTab({ tabId, active, repoPath, repoLabel }: OrchestratorTabProps) {
  const data = useOrchestratorData();

  const [permissionMode, setPermissionMode] = useState<ThoughtsChatPermissionMode>(
    () => readStoredPermissionMode(tabId),
  );
  const [preferredRuntime, setPreferredRuntime] = useState<OrchestratorRuntime>(
    () => readOrchestratorRuntimePreference(),
  );
  const [chatChromeState, setChatChromeState] = useState<ThoughtsChatPanelChromeState>({
    activeTargetLabel: orchestratorRuntimeTone(readOrchestratorRuntimePreference()).label,
    waitingForReply: false,
    hasMessages: false,
    threadId: null,
  });
  const [historyOpen, setHistoryOpen] = useState(() => readBooleanPref(HISTORY_OPEN_KEY));
  const [missionOpen, setMissionOpen] = useState(() => readBooleanPref(MISSION_OPEN_KEY));
  const chatPanelRef = useRef<ThoughtsChatPanelHandle>(null);

  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);

  useEffect(() => {
    if (!active) return;
    const timeout = window.setTimeout(() => chatPanelRef.current?.focusInput(), 60);
    return () => window.clearTimeout(timeout);
  }, [active]);

  const agents = data?.agents ?? [];
  const sessionTargets = useMemo(
    () => buildAgentTargets(agents, preferredRuntime),
    [agents, preferredRuntime],
  );

  const handleTogglePermission = useCallback(() => {
    setPermissionMode((current) => {
      const next: ThoughtsChatPermissionMode = current === 'full' ? 'plan' : 'full';
      persistPermissionMode(tabId, next);
      return next;
    });
  }, [tabId]);

  const handleToggleHistory = useCallback(() => {
    setHistoryOpen((prev) => {
      const next = !prev;
      writeBooleanPref(HISTORY_OPEN_KEY, next);
      return next;
    });
  }, []);

  const handleToggleMission = useCallback(() => {
    setMissionOpen((prev) => {
      const next = !prev;
      writeBooleanPref(MISSION_OPEN_KEY, next);
      return next;
    });
  }, []);

  const handleSelectThread = useCallback((threadTabId: string) => {
    chatPanelRef.current?.loadThread(threadTabId);
    setTimeout(() => chatPanelRef.current?.focusInput(), 40);
  }, []);

  const handleNewConversation = useCallback(() => {
    chatPanelRef.current?.reset();
    setTimeout(() => chatPanelRef.current?.focusInput(), 30);
  }, []);

  const handleQuickAction = useCallback((prompt: string) => {
    chatPanelRef.current?.sendNow(prompt);
  }, []);

  const greeting = useMemo(() => timeOfDayGreeting(), []);
  // Orchestrator brain is always Claude Code — the target picker below
  // switches dispatch targets, not the orchestrator runtime itself.
  const runtimeLabel = orchestratorRuntimeTone('claude-code').label;

  const emptyStateNode = useMemo(
    () => (
      <OrchestratorEmptyState
        greeting={greeting}
        runtimeLabel={runtimeLabel}
        onActionClick={handleQuickAction}
      />
    ),
    [greeting, runtimeLabel, handleQuickAction],
  );

  const hasActiveSessions = agents.length > 0;
  const hasMessages = chatChromeState.hasMessages;

  const thoughtsBodyBackground = 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%)';
  const thoughtsElevatedSurface = 'var(--t-glass-elevated)';
  const thoughtsElevatedBorder = '1px solid var(--t-glass-border-strong)';
  const thoughtsElevatedShadow = 'var(--t-glass-shadow)';
  const thoughtsMutedGlass = 'var(--t-glass-muted-strong)';


  const isFullAccess = permissionMode === 'full';

  if (!data) {
    return (
      <div
        style={{
          flex: 1,
          display: active ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--t-chat-surface-bg, #ffffff)',
          color: 'var(--t-text-muted)',
          fontSize: 12,
        }}
      >
        Orchestrator data unavailable.
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--t-chat-surface-bg, #ffffff)',
      }}
    >

      {/* Plan-mode banner */}
      {!isFullAccess ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 7,
            paddingRight: 14,
            paddingBottom: 7,
            paddingLeft: 14,
            borderBottomWidth: '0.5px',
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
            background: 'var(--t-panel-hover)',
            color: 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Read-only mode — Claude will inspect but cannot modify files or run side-effecting commands.
        </div>
      ) : null}

      {/* Session visualizer — only when there are active sessions.
          Clicking a card opens that agent's live transcript in a workspace
          terminal tab instead of spilling the running output inline. */}
      {hasActiveSessions ? (
        <SessionVisualizer agents={agents} onSelectSession={data.onSelectSession} />
      ) : null}

      {/* 3-pane body: History | Chat | Mission */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
        }}
      >
        {/* Left: history sidebar */}
        <OrchestratorHistorySidebar
          open={historyOpen}
          currentThreadId={chatChromeState.threadId}
          onClose={handleToggleHistory}
          onSelectThread={handleSelectThread}
        />

        {/* Center: chat body */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}
        >
          {/* Inline History pill — matches the Assistant tab's floating
              history link. Positioned at the top-left of the chat area so
              it's discoverable but doesn't take a header slot. */}
          <button
            type="button"
            onClick={handleToggleHistory}
            title="Orchestrator history"
            style={{
              position: 'absolute',
              top: 10,
              left: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 24,
              paddingTop: 0,
              paddingRight: 9,
              paddingBottom: 0,
              paddingLeft: 8,
              borderRadius: 7,
              borderWidth: 0,
              background: historyOpen ? 'var(--t-accent-soft)' : 'transparent',
              color: historyOpen ? 'var(--t-accent)' : 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'background 120ms ease, color 120ms ease',
              zIndex: 2,
            }}
            onMouseEnter={(event) => {
              if (!historyOpen) {
                event.currentTarget.style.background = 'var(--t-bg-card)';
                event.currentTarget.style.color = 'var(--t-text-secondary)';
              }
            }}
            onMouseLeave={(event) => {
              if (!historyOpen) {
                event.currentTarget.style.background = 'transparent';
                event.currentTarget.style.color = 'var(--t-text-muted)';
              }
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
              <circle cx="12" cy="12" r="9" />
              <polyline points="12 7 12 12 15 14" />
            </svg>
            History
          </button>
          {hasMessages ? (
            <button
              type="button"
              onClick={handleNewConversation}
              title="New conversation"
              style={{
                position: 'absolute',
                top: 10,
                left: historyOpen ? 272 : 90,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderRadius: 7,
                borderWidth: 0,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                cursor: 'pointer',
                transition: 'left 200ms ease, color 120ms ease',
                zIndex: 2,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text-secondary)'; e.currentTarget.style.background = 'var(--t-bg-card)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; e.currentTarget.style.background = 'transparent'; }}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          ) : null}
          <ThoughtsChatPanel
            ref={chatPanelRef}
            open
            draftInjection={data.draftInjection}
            agents={agents}
            missionState={data.missionState}
            preferredRuntime={preferredRuntime}
            sessionTargets={sessionTargets}
            workspaceTargets={data.workspaceTargets ?? []}
            repoPath={repoPath ?? null}
            thoughtsBodyBackground={thoughtsBodyBackground}
            thoughtsElevatedSurface={thoughtsElevatedSurface}
            thoughtsElevatedBorder={thoughtsElevatedBorder}
            thoughtsElevatedShadow={thoughtsElevatedShadow}
            thoughtsMutedGlass={thoughtsMutedGlass}
            permissionMode={permissionMode}
            onTogglePermission={handleTogglePermission}
            missionOpen={missionOpen}
            onToggleMission={handleToggleMission}
            repoLabel={repoLabel}
            emptyStateOverride={emptyStateNode}
            onMissionStateChange={data.onMissionStateChange}
            onLaunchPacket={data.onLaunchPacket}
            onChromeChange={setChatChromeState}
          />
        </div>

        {/* Right: mission control sidebar */}
        <div
          style={{
            width: missionOpen ? 340 : 0,
            minWidth: missionOpen ? 340 : 0,
            borderLeftWidth: missionOpen ? 1 : 0,
            borderLeftStyle: 'solid',
            borderLeftColor: 'var(--t-divider-subtle)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            transition: 'width 200ms ease, min-width 200ms ease',
            flexShrink: 0,
            background: 'var(--t-chat-surface-bg, #ffffff)',
          }}
        >
          {missionOpen ? (
            <ThoughtsMissionPanel
              open
              visible
              missionState={data.missionState}
              workspaceTargets={data.workspaceTargets ?? []}
              preferredRuntime={preferredRuntime}
              sessionTargets={sessionTargets}
              thoughtsBodyBackground={thoughtsBodyBackground}
              thoughtsElevatedSurface={thoughtsElevatedSurface}
              thoughtsElevatedBorder={thoughtsElevatedBorder}
              thoughtsElevatedShadow={thoughtsElevatedShadow}
              thoughtsMutedGlass={thoughtsMutedGlass}
              onMissionStateChange={data.onMissionStateChange}
              onLaunchPacket={data.onLaunchPacket}
            />
          ) : null}
        </div>
      </div>
      <span style={{ display: 'none' }} aria-hidden data-chrome={chatChromeState.activeTargetLabel} />
    </div>
  );
}
