'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeO8PanelToast } from '@/lib/events/o8-panel-focus';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { useOrchestratorTileBus } from './orchestrator-tile-bus';
import {
  ThoughtsChatPanel,
  type ThoughtsChatPanelChromeState,
  type ThoughtsChatPanelHandle,
  type ThoughtsChatPermissionMode,
} from './thoughts/ThoughtsChatPanel';
import type {
  FleetAgent,
  ThoughtsCardProps,
} from './thoughts/types';
import { buildAgentTargets } from './thoughts/utils';

/**
 * Tile-native container for the orchestrator chat.
 *
 * Replaces the floating ThoughtsCard. Lives inside a TileContainer leaf —
 * no drag/resize/position/z-index logic. Header carries:
 *   - Title:    "Orchestrator · claude-code · <repoName>"
 *   - Recents:  lightweight thread switcher (fast lane; full history in sibling tile)
 *   - Chip:     Full access ↔ Read-only permission toggle (per-tile, localStorage)
 *   - Close:    tile close button
 *
 * The permission chip is the single most important affordance. Clicking
 * it toggles between `'full'` (legacy --dangerously-skip-permissions) and
 * `'plan'` (--permission-mode plan). State is persisted per-tile.
 */

interface OrchestratorChatTileProps {
  tileId: string;
  onClose: () => void;
  agents?: FleetAgent[];
  draftInjection?: ThoughtsCardProps['draftInjection'];
  missionState: ThoughtsCardProps['missionState'];
  workspaceTargets?: ThoughtsCardProps['workspaceTargets'];
  onMissionStateChange: ThoughtsCardProps['onMissionStateChange'];
  onLaunchPacket?: ThoughtsCardProps['onLaunchPacket'];
  repoPath?: string | null;
  repoLabel?: string | null;
}

interface RecentThread {
  tabId: string;
  title: string;
  modifiedAt: string;
}

function permissionStorageKey(tileId: string): string {
  return `cortex-ide:orchestrator-permission:${tileId}`;
}

function readStoredPermissionMode(tileId: string): ThoughtsChatPermissionMode {
  if (typeof window === 'undefined') return 'full';
  try {
    const raw = window.localStorage.getItem(permissionStorageKey(tileId));
    return raw === 'plan' ? 'plan' : 'full';
  } catch {
    return 'full';
  }
}

function persistPermissionMode(tileId: string, mode: ThoughtsChatPermissionMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(permissionStorageKey(tileId), mode);
  } catch {
    // localStorage disabled / private mode — silent fallback to in-memory only
  }
}

function OrchestratorChatTileBase({
  tileId,
  onClose,
  agents = [],
  draftInjection,
  missionState,
  workspaceTargets = [],
  onMissionStateChange,
  onLaunchPacket,
  repoPath: repoPathProp,
  repoLabel,
}: OrchestratorChatTileProps) {
  const [permissionMode, setPermissionMode] = useState<ThoughtsChatPermissionMode>(
    () => readStoredPermissionMode(tileId),
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
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [recents, setRecents] = useState<RecentThread[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(false);
  const [pivotToast, setPivotToast] = useState<string | null>(null);
  const chatPanelRef = useRef<ThoughtsChatPanelHandle>(null);
  const orchestratorBus = useOrchestratorTileBus();

  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);

  // Publish this tile's chat handle on the orchestrator bus so sibling
  // tiles (history, mission) can drive the chat without prop-drilling.
  const registerChatHandle = orchestratorBus.registerChatHandle;
  useEffect(() => {
    registerChatHandle(chatPanelRef.current);
    return () => registerChatHandle(null);
  }, [registerChatHandle]);

  // Tool-call write cards publish a pivot request when the user clicks
  // "View in Changes". If the right O8 panel is closed, the dashboard
  // emits a toast for us to render inline. 3.5-second auto-dismiss.
  useEffect(() => {
    const unsubscribe = subscribeO8PanelToast((toast) => {
      setPivotToast(toast.message);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!pivotToast) return;
    const timer = window.setTimeout(() => setPivotToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [pivotToast]);

  useEffect(() => {
    const timeout = window.setTimeout(() => chatPanelRef.current?.focusInput(), 60);
    return () => window.clearTimeout(timeout);
  }, []);

  const sessionTargets = useMemo(
    () => buildAgentTargets(agents, preferredRuntime),
    [agents, preferredRuntime],
  );

  const handleTogglePermission = useCallback(() => {
    setPermissionMode((current) => {
      const next: ThoughtsChatPermissionMode = current === 'full' ? 'plan' : 'full';
      persistPermissionMode(tileId, next);
      return next;
    });
  }, [tileId]);

  const fetchRecents = useCallback(async () => {
    setRecentsLoading(true);
    try {
      const res = await fetch('/api/v2/chat-history/list');
      if (!res.ok) return;
      const data = await res.json() as {
        conversations?: Array<{ tabId: string; title?: string; modifiedAt: string }>;
      };
      const thoughts = (data.conversations ?? [])
        .filter((c) => c.tabId.startsWith('thoughts-'))
        .slice(0, 5)
        .map((c) => ({ tabId: c.tabId, title: c.title ?? 'Untitled', modifiedAt: c.modifiedAt }));
      setRecents(thoughts);
    } catch {
      // silent — recents is best-effort
    } finally {
      setRecentsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (recentsOpen) void fetchRecents();
  }, [recentsOpen, fetchRecents]);

  const handleSelectRecent = useCallback((tabId: string) => {
    chatPanelRef.current?.loadThread(tabId);
    setRecentsOpen(false);
  }, []);

  const thoughtsBodyBackground = 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%)';
  const thoughtsElevatedSurface = 'var(--t-glass-elevated)';
  const thoughtsElevatedBorder = '1px solid var(--t-glass-border-strong)';
  const thoughtsElevatedShadow = 'var(--t-glass-shadow)';
  const thoughtsMutedGlass = 'var(--t-glass-muted-strong)';

  const titleParts = ['Orchestrator', 'claude-code'];
  if (repoLabel) titleParts.push(repoLabel);
  const title = titleParts.join(' · ');

  const isFullAccess = permissionMode === 'full';
  const chipLabel = isFullAccess ? 'Full access' : 'Read-only';
  const chipTooltip = isFullAccess
    ? 'Claude can edit code and run commands. Click to switch to read-only.'
    : 'Claude can inspect but not modify. Click to arm for full access.';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: 'var(--t-bg)',
      }}
    >
      {/* Tile header — title + recents + permission chip + close */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 14,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          background: 'var(--t-panel)',
          minHeight: 44,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={title}
        >
          {title}
        </div>

        {/* Recents dropdown — fast-lane thread switcher */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setRecentsOpen((v) => !v)}
            title="Recent conversations"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              height: 28,
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-btn-secondary-border)',
              background: recentsOpen ? 'var(--t-panel-hover)' : 'transparent',
              color: 'var(--t-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Recents
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {recentsOpen ? (
            <div
              style={{
                position: 'absolute',
                top: 32,
                right: 0,
                minWidth: 260,
                maxWidth: 340,
                borderRadius: 10,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider-subtle)',
                background: 'var(--t-panel-raised)',
                boxShadow: 'var(--t-glass-shadow)',
                zIndex: 10,
                overflow: 'hidden',
              }}
            >
              {recentsLoading ? (
                <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--t-text-muted)' }}>
                  Loading…
                </div>
              ) : recents.length === 0 ? (
                <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--t-text-muted)' }}>
                  No recent conversations.
                </div>
              ) : (
                recents.map((thread) => (
                  <button
                    key={thread.tabId}
                    type="button"
                    onClick={() => handleSelectRecent(thread.tabId)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      paddingTop: 9,
                      paddingRight: 12,
                      paddingBottom: 9,
                      paddingLeft: 12,
                      borderWidth: 0,
                      borderBottomWidth: 1,
                      borderBottomStyle: 'solid',
                      borderBottomColor: 'var(--t-divider-subtle)',
                      background: 'transparent',
                      color: 'var(--t-text)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {thread.title}
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {/* Permission chip — the "armed/safe" toggle */}
        <button
          type="button"
          onClick={handleTogglePermission}
          title={chipTooltip}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            paddingTop: 0,
            paddingRight: 10,
            paddingBottom: 0,
            paddingLeft: 10,
            borderRadius: 999,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: isFullAccess
              ? 'rgba(239, 68, 68, 0.35)'
              : 'var(--t-btn-secondary-border)',
            background: isFullAccess
              ? 'rgba(239, 68, 68, 0.10)'
              : 'var(--t-panel-hover)',
            color: isFullAccess ? '#b91c1c' : 'var(--t-text-secondary)',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: isFullAccess ? '#ef4444' : 'var(--t-text-faint)',
            }}
          />
          {chipLabel}
        </button>

        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          title="Close"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Chat body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {pivotToast ? (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 5,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 7,
              paddingRight: 14,
              paddingBottom: 7,
              paddingLeft: 14,
              borderRadius: 999,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              background: 'var(--t-panel-raised)',
              boxShadow: 'var(--t-glass-shadow)',
              color: 'var(--t-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <span style={{ color: 'var(--t-text-faint)' }}>→</span>
            {pivotToast}
          </div>
        ) : null}
        <ThoughtsChatPanel
          ref={chatPanelRef}
          open
          draftInjection={draftInjection}
          agents={agents}
          missionState={missionState}
          preferredRuntime={preferredRuntime}
          sessionTargets={sessionTargets}
          workspaceTargets={workspaceTargets}
          repoPath={repoPathProp ?? null}
          thoughtsBodyBackground={thoughtsBodyBackground}
          thoughtsElevatedSurface={thoughtsElevatedSurface}
          thoughtsElevatedBorder={thoughtsElevatedBorder}
          thoughtsElevatedShadow={thoughtsElevatedShadow}
          thoughtsMutedGlass={thoughtsMutedGlass}
          permissionMode={permissionMode}
          onMissionStateChange={onMissionStateChange}
          onLaunchPacket={onLaunchPacket}
          onChromeChange={setChatChromeState}
        />
      </div>
      {/* chatChromeState currently unused at the tile level — reserved for
          future header affordances (message count, active target). */}
      <span style={{ display: 'none' }} aria-hidden data-chrome={chatChromeState.activeTargetLabel} />
    </div>
  );
}

export const OrchestratorChatTile = memo(OrchestratorChatTileBase);
