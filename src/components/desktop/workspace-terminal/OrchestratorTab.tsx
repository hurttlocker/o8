'use client';

/**
 * OrchestratorTab — full-workspace orchestrator surface inside a
 * WorkspaceTerminal tab. Header + four-pane layout:
 *
 *   ┌────────────────────────────────────────┐
 *   │ Header: History | Agents | Mission    │
 *   ├───────┬────────┬────────────────┬─────┤
 *   │History│ Agents │ Chat           │Mission
 *   │(260px)│(280px) │ ThoughtsChat   │(340px)
 *   └───────┴────────┴────────────────┴─────┘
 *
 * Both side panels are collapsed by default and toggle via the header
 * (History, Agents, Mission). This lets the orchestrator host
 * past-conversation browsing AND mission planning without ever leaving
 * the chat — no tab switching, no lost flow.
 *
 * Data deps come from OrchestratorDataContext (provided at the
 * dashboard level) so WorkspaceTerminal doesn't prop-drill them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ComparisonPicker } from '@/components/desktop/ComparisonPicker';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import { loadOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  OrchestratorEmptyState,
  timeOfDayGreeting,
} from '@/components/desktop/OrchestratorEmptyState';
import { OrchestratorHistorySidebar } from '@/components/desktop/OrchestratorHistorySidebar';
import { SessionVisualizer } from '@/components/desktop/SessionVisualizer';
import { UnifiedAgentsSidebar } from '@/components/desktop/UnifiedAgentsSidebar';
import { ContextMeter } from '@/components/desktop/orchestrator/ContextMeter';
import { ThreadsDropdown } from '@/components/desktop/orchestrator/ThreadsDropdown';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import {
  ThoughtsChatPanel,
  type ThoughtsChatPanelChromeState,
  type ThoughtsChatPanelHandle,
  type ThoughtsChatPermissionMode,
} from '@/components/desktop/thoughts/ThoughtsChatPanel';
import { ORCHESTRATOR_TOKEN_EVENT, type OrchestratorTokenUsageDetail } from '@/components/desktop/thoughts/useOrchestratorStream';
import { ThoughtsMissionPanel } from '@/components/desktop/thoughts/ThoughtsMissionPanel';
import { buildAgentTargets } from '@/components/desktop/thoughts/utils';
import { AgentTileLayout } from './AgentTileLayout';

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
const AGENTS_OPEN_KEY = 'o8:orchestrator:agents-open';
const MISSION_OPEN_KEY = 'o8:orchestrator:mission-open';
const USERS_THREE_ICON_PATH = 'M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1-7.37-4.89,8,8,0,0,1,0-6.22A8,8,0,0,1,192,112a24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.84,8,57,57,0,0,0-98.16,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z';

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

function isComparisonPacketComplete(packet: OrchestratorPacket): boolean {
  return packet.status === 'awaiting_review'
    || packet.status === 'released'
    || packet.status === 'archived'
    || packet.status === 'failed'
    || Boolean(packet.review);
}

function HeaderToggleButton({
  active,
  label,
  title,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        height: 28,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        flexShrink: 0,
        fontSize: 11.5,
        fontWeight: 500,
        letterSpacing: '-0.005em',
        transition: 'background 180ms ease, border-color 180ms ease, color 180ms ease',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.background = 'var(--t-bg-card)';
        event.currentTarget.style.borderColor = 'var(--t-border)';
        event.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.borderColor = 'var(--t-border)';
        event.currentTarget.style.color = 'var(--t-text-secondary)';
      }}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function ClockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function RocketIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function UsersThreeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d={USERS_THREE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

function PlusIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
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
    messageCount: 0,
    orchestratorBusyState: null,
  });
  const [contextUsage, setContextUsage] = useState({ tokenCount: 0, runningTotal: 0 });
  const [exportState, setExportState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [historyOpen, setHistoryOpen] = useState(() => readBooleanPref(HISTORY_OPEN_KEY));
  const [agentsOpen, setAgentsOpen] = useState(() => readBooleanPref(AGENTS_OPEN_KEY));
  const [missionOpen, setMissionOpen] = useState(() => readBooleanPref(MISSION_OPEN_KEY));
  const [tiledSessions, setTiledSessions] = useState<string[]>([]);
  const [tileDockExpanded, setTileDockExpanded] = useState(true);
  const chatPanelRef = useRef<ThoughtsChatPanelHandle>(null);
  const autoTiledComparisonGroupIdRef = useRef<string | null>(null);

  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);

  useEffect(() => {
    if (!active) return;
    const timeout = window.setTimeout(() => chatPanelRef.current?.focusInput(), 60);
    return () => window.clearTimeout(timeout);
  }, [active]);

  useEffect(() => {
    setContextUsage({ tokenCount: 0, runningTotal: 0 });
    const handleTokenUsage = (event: Event) => {
      const detail = (event as CustomEvent<OrchestratorTokenUsageDetail>).detail;
      if (!detail || detail.repoPath !== (repoPath ?? null)) return;
      setContextUsage({ tokenCount: detail.tokenCount, runningTotal: detail.runningTotal });
    };
    window.addEventListener(ORCHESTRATOR_TOKEN_EVENT, handleTokenUsage);
    return () => window.removeEventListener(ORCHESTRATOR_TOKEN_EVENT, handleTokenUsage);
  }, [repoPath]);

  const agents = useMemo(() => data?.agents ?? [], [data?.agents]);
  const comparisonGroups = useMemo(() => {
    const missionState = data?.missionState;
    if (!missionState) {
      return [] as Array<{ groupId: string; packets: OrchestratorPacket[] }>;
    }

    return (missionState.activeComparisonGroups ?? [])
      .map((groupId) => ({
        groupId,
        packets: missionState.packets.filter((packet) => packet.comparisonGroupId === groupId),
      }))
      .filter((group) => group.packets.length > 0);
  }, [data?.missionState]);
  const readyComparisonGroups = useMemo(
    () => comparisonGroups.filter((group) => group.packets.every(isComparisonPacketComplete)),
    [comparisonGroups],
  );
  const sessionTargets = useMemo(
    () => buildAgentTargets(agents, preferredRuntime),
    [agents, preferredRuntime],
  );
  const isTiled = tiledSessions.length > 1;

  useEffect(() => {
    const activeSessions = new Set(
      agents.map((agent) => agent.sessionKey).filter((sessionKey): sessionKey is string => Boolean(sessionKey)),
    );
    setTiledSessions((current) => {
      const next = current.filter((sessionKey) => activeSessions.has(sessionKey));
      return next.length === current.length ? current : next;
    });
  }, [agents]);

  useEffect(() => {
    if (!isTiled) return;
    setTileDockExpanded(true);
  }, [isTiled]);

  useEffect(() => {
    const activeGroupIds = comparisonGroups.map((group) => group.groupId);
    if (
      autoTiledComparisonGroupIdRef.current
      && !activeGroupIds.includes(autoTiledComparisonGroupIdRef.current)
    ) {
      autoTiledComparisonGroupIdRef.current = null;
    }

    const nextAutoTileGroup = comparisonGroups.find((group) => (
      group.groupId !== autoTiledComparisonGroupIdRef.current
      && group.packets.length > 1
      && group.packets.every((packet) => Boolean(packet.lane?.sessionKey))
    ));
    if (!nextAutoTileGroup) {
      return;
    }

    const sessionKeys = nextAutoTileGroup.packets
      .map((packet) => packet.lane?.sessionKey ?? null)
      .filter((sessionKey): sessionKey is string => Boolean(sessionKey));
    if (sessionKeys.length !== nextAutoTileGroup.packets.length) {
      return;
    }

    autoTiledComparisonGroupIdRef.current = nextAutoTileGroup.groupId;
    setTiledSessions(sessionKeys);
    console.log(`[best-of-n] Auto-tiled comparison group ${nextAutoTileGroup.groupId}`);
  }, [comparisonGroups]);

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

  const handleToggleAgents = useCallback(() => {
    setAgentsOpen((prev) => {
      const next = !prev;
      writeBooleanPref(AGENTS_OPEN_KEY, next);
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

  const handleToggleTileSession = useCallback((sessionKey: string) => {
    setTiledSessions((current) => {
      if (current.includes(sessionKey)) {
        return current.filter((key) => key !== sessionKey);
      }
      const appended = [...current, sessionKey];
      return appended.length > 4 ? appended.slice(appended.length - 4) : appended;
    });
  }, []);

  const handleCloseTileSession = useCallback((sessionKey: string) => {
    setTiledSessions((current) => current.filter((key) => key !== sessionKey));
  }, []);

  const handleClearTiles = useCallback(() => {
    setTiledSessions([]);
  }, []);

  const handleToggleTileDock = useCallback(() => {
    setTileDockExpanded((current) => !current);
  }, []);

  const handleSelectThread = useCallback((threadTabId: string) => {
    chatPanelRef.current?.loadThread(threadTabId);
    setTimeout(() => chatPanelRef.current?.focusInput(), 40);
  }, []);

  const handleNewConversation = useCallback(async () => {
    try {
      const response = await fetch('/api/orchestrator/reset-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(repoPath ? { repoPath } : {}),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? 'Unable to reset orchestrator session.');
      }

      chatPanelRef.current?.reset();
      setTimeout(() => chatPanelRef.current?.focusInput(), 30);
    } catch (error) {
      console.error('[orchestrator] Failed to reset orchestrator conversation.', error);
    }
  }, [repoPath]);

  const handleQuickAction = useCallback((prompt: string) => {
    chatPanelRef.current?.sendNow(prompt);
  }, []);

  const handleDismissComparisonGroup = useCallback((groupId: string) => {
    if (!data) {
      return;
    }

    data.onMissionStateChange((current) => ({
      ...current,
      activeComparisonGroups: (current.activeComparisonGroups ?? []).filter((candidate) => candidate !== groupId),
    }));
  }, [data]);

  const handlePickComparisonWinner = useCallback(async (packetId: string) => {
    try {
      const response = await fetch('/api/orchestrator/comparison-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        result?: { merged?: boolean; note?: string };
        error?: { message?: string };
      } | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Unable to pick the comparison winner.');
      }

      if (payload.result?.merged === false) {
        console.warn('[best-of-n] Comparison winner selected but merge did not complete.', payload.result?.note);
      }

      await loadOrchestratorMissionState();
    } catch (error) {
      console.error('[best-of-n] Failed to pick comparison winner.', error);
    }
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

  const handleHeaderCopyMarkdown = useCallback(async () => {
    const ok = await chatPanelRef.current?.copyAsMarkdown?.();
    if (ok === false) {
      setExportState('error');
      setTimeout(() => setExportState('idle'), 1400);
    } else {
      setExportState('copying');
      setTimeout(() => setExportState('copied'), 120);
      setTimeout(() => setExportState('idle'), 1600);
    }
  }, []);

  const thoughtsBodyBackground = 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%)';
  const thoughtsElevatedSurface = 'var(--t-glass-elevated)';
  const thoughtsElevatedBorder = '1px solid var(--t-glass-border-strong)';
  const thoughtsElevatedShadow = 'var(--t-glass-shadow)';
  const thoughtsMutedGlass = 'var(--t-glass-muted-strong)';
  const headerChipStyle = {
    height: 26, paddingTop: 0, paddingRight: 9, paddingBottom: 0, paddingLeft: 9, borderRadius: 8, borderWidth: 1, borderStyle: 'solid',
    borderColor: 'var(--t-border)', color: 'var(--t-text-muted)', display: 'inline-flex', alignItems: 'center',
    fontSize: 12, fontWeight: 500, fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
  } as const;


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

  const thoughtsChatPanel = (
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
      showInlineExport={false}
      footerMeterSlot={(
        <ContextMeter
          tokenCount={contextUsage.tokenCount}
          runningTotal={contextUsage.runningTotal}
          onClick={() => { console.info('[orchestrator] Context inspector is not wired yet.'); }}
        />
      )}
      onMissionStateChange={data.onMissionStateChange}
      onLaunchPacket={data.onLaunchPacket}
      onChromeChange={setChatChromeState}
    />
  );

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, paddingTop: 3, paddingRight: 12, paddingBottom: 3, paddingLeft: 12, borderBottomWidth: '0.5px', borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)', background: 'transparent', flexShrink: 0, justifyContent: 'flex-end' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {hasMessages ? (
            <button
              type="button"
              onClick={() => { void handleHeaderCopyMarkdown(); }}
              aria-label="Copy thread as Markdown"
              title={exportState === 'copied' ? 'Copied' : 'Copy thread as Markdown'}
              style={{
                ...headerChipStyle,
                background: 'transparent',
                gap: 6,
                cursor: 'pointer',
                flexShrink: 0,
                borderColor: exportState === 'copied' ? 'var(--t-accent-border)' : 'var(--t-border)',
                color: exportState === 'copied' ? 'var(--t-accent)' : 'var(--t-text-muted)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>{exportState === 'copied' ? 'Copied' : 'Copy'}</span>
            </button>
          ) : null}
          <ThreadsDropdown historyOpen={historyOpen} agentsOpen={agentsOpen} missionOpen={missionOpen} onToggleHistory={handleToggleHistory} onToggleAgents={handleToggleAgents} onToggleMission={handleToggleMission} />

          {hasMessages ? (
            <button
              type="button"
              onClick={handleNewConversation}
              aria-label="New orchestrator conversation"
              title="New orchestrator conversation"
              style={{
                background: 'transparent',
                gap: 6,
                cursor: 'pointer',
                flexShrink: 0,
                ...headerChipStyle,
              }}
            >
              <PlusIcon size={13} />
              <span>New</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Session visualizer — only when there are active sessions.
          Clicking a card opens that agent's live transcript in a workspace
          terminal tab instead of spilling the running output inline. */}
      {hasActiveSessions ? (
        <SessionVisualizer
          agents={agents}
          tiledSessions={tiledSessions}
          onSelectSession={data.onSelectSession}
          onToggleTileSession={handleToggleTileSession}
          onClearTiles={handleClearTiles}
        />
      ) : null}

      {readyComparisonGroups.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
            background: 'var(--t-chat-surface-bg, #ffffff)',
          }}
        >
          {readyComparisonGroups.map((group) => (
            <ComparisonPicker
              key={group.groupId}
              groupId={group.groupId}
              packets={group.packets}
              onPickWinner={handlePickComparisonWinner}
              onDismiss={() => handleDismissComparisonGroup(group.groupId)}
            />
          ))}
        </div>
      ) : null}

      {/* 4-pane body: History | Agents | Chat | Mission */}
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
          onSelectArchivedLane={data.onSelectSession
            ? (sessionKey) => data.onSelectSession?.(sessionKey)
            : undefined}
        />

        <UnifiedAgentsSidebar
          open={agentsOpen}
          agents={agents}
          onClose={handleToggleAgents}
          onSelectSession={data.onSelectSession}
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
          {isTiled ? (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <AgentTileLayout
                sessions={tiledSessions}
                agents={agents}
                onCloseSession={handleCloseTileSession}
              />
              <div
                style={{
                  height: tileDockExpanded ? 232 : 160,
                  minHeight: tileDockExpanded ? 232 : 160,
                  display: 'flex',
                  flexDirection: 'column',
                  borderTopWidth: 1,
                  borderTopStyle: 'solid',
                  borderTopColor: 'var(--t-divider-subtle)',
                  background: 'var(--t-bg-card)',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    height: 44,
                    minHeight: 44,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    paddingTop: 0,
                    paddingRight: 12,
                    paddingBottom: 0,
                    paddingLeft: 16,
                    borderBottomWidth: 1,
                    borderBottomStyle: 'solid',
                    borderBottomColor: 'var(--t-border)',
                    background: 'var(--t-panel)',
                  }}
                >
                  <div
                    style={{
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--t-text)',
                        letterSpacing: '-0.01em',
                      }}
                    >
                      Orchestrator chat
                    </div>
                    <div
                      style={{
                        fontSize: 10.5,
                        fontWeight: 500,
                        color: 'var(--t-text-secondary)',
                      }}
                    >
                      Send follow-ups here while monitoring live agent panes.
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={tileDockExpanded ? 'Collapse orchestrator chat dock' : 'Expand orchestrator chat dock'}
                    title={tileDockExpanded ? 'Collapse chat dock' : 'Expand chat dock'}
                    onClick={handleToggleTileDock}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      borderWidth: 0,
                      background: 'transparent',
                      color: 'var(--t-text-secondary)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = 'var(--t-bg-card)';
                      event.currentTarget.style.color = 'var(--t-text)';
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = 'transparent';
                      event.currentTarget.style.color = 'var(--t-text-secondary)';
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      {tileDockExpanded ? <path d="M18 14l-6-6-6 6" /> : <path d="M6 10l6 6 6-6" />}
                    </svg>
                  </button>
                </div>
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                  }}
                >
                  {thoughtsChatPanel}
                </div>
              </div>
            </div>
          ) : thoughtsChatPanel}
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
