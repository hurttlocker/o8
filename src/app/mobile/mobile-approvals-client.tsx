'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '@/lib/theme/context';
import { MobileAuroraBg } from './mobile-aurora-bg';
import { AssistantChatView } from './mobile-assistant-chat-view';
import { ApprovalsView } from './mobile-approvals-approvals-view';
import { ChatListView } from './mobile-approvals-chat-list-view';
import { Sidebar } from './mobile-approvals-sidebar';
import {
  DEFAULT_MOBILE_CHAT_MODEL,
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  IconArrowLeft,
  IconHamburger,
  IconRefresh,
  MOBILE_CHAT_MODEL_STORAGE_KEY,
  POLL_INTERVAL,
  generateChatTabId,
  getMobilePalette,
  getModelOption,
  getStoredEffort,
  storeEffort,
  glassButtonStyle,
  mobileFontFamily,
  normalizeHistoryList,
  readStoredMobileModel,
  type ApprovalItem,
  type ChatHistoryRecord,
  type CliEffort,
  type MobileView,
} from './mobile-approvals-shared';
import { SettingsView } from './mobile-settings-view';
import {
  getMobileRepoLabel,
  normalizeMobileRepoList,
  readStoredMobileRepoPath,
  writeStoredMobileRepoPath,
  type MobileRepoOption,
} from './mobile-chat-repos';

function getWsToken() {
  if (typeof document === 'undefined') return null;
  return document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? null;
}

function getWsBridgeUrl(token: string) {
  if (typeof window === 'undefined') return null;

  const isTauri = window.location.protocol === 'tauri:' || Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (isTauri) {
    return `ws://127.0.0.1:3002/ws?token=${encodeURIComponent(token)}`;
  }

  // Use the same host:port as the page — Next.js rewrites /ws → ws-server:3002.
  // This avoids cross-port issues over Tailscale / remote networks.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostPort = window.location.host; // includes port if non-default
  return `${protocol}//${hostPort}/ws?token=${encodeURIComponent(token)}`;
}

const WS_RECONNECT_BASE_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 8_000;

function getReconnectDelayMs(attempt: number) {
  return Math.min(WS_RECONNECT_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), WS_RECONNECT_MAX_DELAY_MS);
}

export function MobileApprovalsClient({
  initialApprovals,
  appVersion,
}: {
  initialApprovals: ApprovalItem[];
  appVersion: string;
}) {
  const { themeId, setTheme } = useTheme();
  const palette = useMemo(() => getMobilePalette(themeId), [themeId]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState<MobileView>('chat');
  const [approvals, setApprovals] = useState<ApprovalItem[]>(initialApprovals);
  const [resolving, setResolving] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTabId, setCurrentTabId] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<ChatHistoryRecord[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState(readStoredMobileModel);
  const [repoOptions, setRepoOptions] = useState<MobileRepoOption[]>([]);
  const [selectedRepoPath, setSelectedRepoPath] = useState<string | null>(readStoredMobileRepoPath);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [effortLevel, setEffortLevel] = useState<CliEffort | null>(getStoredEffort);
  const reconnectAttemptRef = useRef(0);

  const selectedModel = useMemo(
    () => getModelOption(selectedModelId) ?? getModelOption(DEFAULT_MOBILE_CHAT_MODEL)!,
    [selectedModelId],
  );
  const selectedRepoLabel = useMemo(
    () => getMobileRepoLabel(selectedRepoPath, repoOptions),
    [repoOptions, selectedRepoPath],
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/approvals?status=pending', { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json() as { approvals?: ApprovalItem[] };
        setApprovals(data.approvals ?? []);
        setError(null);
      }
    } catch {
      setError('Unable to reach server');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadRecentConversations = useCallback(async () => {
    setRecentLoading(true);
    try {
      const response = await fetch('/api/v2/chat-history/list', { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to load conversations');
      const data = await response.json();
      setRecentConversations(normalizeHistoryList(data));
    } catch {
      setRecentConversations([]);
    } finally {
      setRecentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeView === 'chat' && !currentTabId) {
      void loadRecentConversations();
    }
  }, [activeView, currentTabId, loadRecentConversations]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/v2/repos', { cache: 'no-store' });
        if (!response.ok) throw new Error('Failed to load repositories');
        const data = await response.json();
        const nextRepos = normalizeMobileRepoList(data);
        if (cancelled) return;

        setRepoOptions(nextRepos);
        setSelectedRepoPath((current) => {
          if (!current) return current;
          return nextRepos.some((repo) => repo.localPath === current) ? current : null;
        });
      } catch {
        if (!cancelled) {
          setRepoOptions([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeStoredMobileRepoPath(selectedRepoPath);
  }, [selectedRepoPath]);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;
    let cancelled = false;

    const token = getWsToken();
    const url = token ? getWsBridgeUrl(token) : null;

    if (!url) {
      setConnectionStatus('disconnected');
      return undefined;
    }

    const connect = () => {
      if (cancelled) return;
      socket = new WebSocket(url);

      socket.onopen = () => {
        if (cancelled) return;
        const shouldRefreshApprovals = reconnectAttemptRef.current > 0;
        if (shouldRefreshApprovals) {
          console.info(`[mobile-ws] Reconnected after ${reconnectAttemptRef.current} attempt${reconnectAttemptRef.current === 1 ? '' : 's'}; polling approvals immediately`);
        }
        reconnectAttemptRef.current = 0;
        setConnectionStatus('connected');
        if (shouldRefreshApprovals) {
          void refresh();
        }
      };

      socket.onerror = () => {
        if (!cancelled) {
          setConnectionStatus('disconnected');
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnectionStatus('disconnected');
        reconnectAttemptRef.current += 1;
        const reconnectDelayMs = getReconnectDelayMs(reconnectAttemptRef.current);
        console.info(`[mobile-ws] Connection closed; retry ${reconnectAttemptRef.current} in ${reconnectDelayMs}ms`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs);
      };
    };

    connect();

    return () => {
      cancelled = true;
      reconnectAttemptRef.current = 0;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [refresh]);

  const handleResolve = useCallback(async (id: string, action: 'approve' | 'reject', strategy?: string) => {
    setResolving({ id, action });
    try {
      const payload: Record<string, string> = { action, id };
      if (strategy) payload.strategy = strategy;
      const response = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        setApprovals((previous) => previous.filter((approval) => approval.id !== id));
        setError(null);
      } else {
        const data = await response.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Failed to resolve approval');
      }
    } catch {
      setError('Unable to reach server');
    }
    setResolving(null);
  }, []);

  const handleNavigate = useCallback((view: MobileView) => {
    setActiveView(view);
    if (view === 'chat') {
      setCurrentTabId(null);
    }
  }, []);

  const handleThemeChange = useCallback((nextTheme: 'light' | 'dark') => {
    setTheme(nextTheme);
  }, [setTheme]);

  const handleModelChange = useCallback((modelId: string) => {
    if (!getModelOption(modelId)) return;
    setSelectedModelId(modelId);
    try {
      window.localStorage.setItem(MOBILE_CHAT_MODEL_STORAGE_KEY, modelId);
    } catch {
      // Ignore local storage failures on constrained browsers.
    }
  }, []);

  const handleEffortChange = useCallback((effort: CliEffort | null) => {
    setEffortLevel(effort);
    storeEffort(effort);
  }, []);

  const handleRepoChange = useCallback((repoPath: string | null) => {
    setSelectedRepoPath(repoPath);
  }, []);

  const pendingCount = useMemo(
    () => approvals.filter((a) => {
      if (a.status !== 'pending') return false;
      if (a.source === 'runtime' || a.continuation?.kind === 'runtime') return false;
      if (a.source === 'llm-chat' && a.risk === 'low') return false;
      return true;
    }).length,
    [approvals],
  );
  const inConversation = activeView === 'chat' && currentTabId !== null;
  const viewTitle = activeView === 'settings'
    ? 'Settings'
    : activeView === 'approvals'
      ? 'Approvals'
      : inConversation
        ? recentConversations.find((conversation) => conversation.tabId === currentTabId)?.title ?? 'Chat'
        : 'Chats';

  return (
    <div
      style={{
        position: 'relative',
        height: '100dvh',
        minHeight: '100dvh',
        maxHeight: '100dvh',
        overflow: 'hidden',
        backgroundColor: palette.rootBackground,
        color: palette.rootText,
        fontFamily: mobileFontFamily(),
        letterSpacing: MOBILE_BODY_TRACKING,
        WebkitFontSmoothing: 'antialiased',
      } as CSSProperties}
    >
      {palette.isDark ? <MobileAuroraBg /> : null}

      <div style={{ position: 'relative', zIndex: 1, height: '100%', padding: '0 16px', display: 'flex', flexDirection: 'column' }}>
        <Sidebar
          open={sidebarOpen}
          activeView={activeView}
          approvalCount={pendingCount}
          selectedModelLabel={selectedModel.label}
          connectionStatus={connectionStatus}
          onNavigate={handleNavigate}
          onClose={() => setSidebarOpen(false)}
          palette={palette}
        />

        <div
          style={{
            paddingTop: 'max(env(safe-area-inset-top, 0px), 16px)',
            paddingBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            position: 'relative',
            zIndex: 5,
          } as CSSProperties}
        >
          {inConversation ? (
            <button
              onClick={() => setCurrentTabId(null)}
              style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS }}
              aria-label="Back to chats"
            >
              <IconArrowLeft fill={palette.iconFill} />
            </button>
          ) : (
            <button
              onClick={() => setSidebarOpen(true)}
              style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS, position: 'relative' }}
              aria-label="Menu"
            >
              <IconHamburger fill={palette.iconFill} />
              {pendingCount > 0 && activeView !== 'approvals' ? (
                <span
                  style={{
                    position: 'absolute',
                    top: 5,
                    right: 5,
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    backgroundColor: palette.danger,
                  }}
                />
              ) : null}
            </button>
          )}

          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: 'center',
                color: palette.rootText,
              }}
            >
              {viewTitle}
            </div>
            {inConversation ? (
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.01em',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: palette.subduedText,
                }}
              >
                {selectedRepoLabel}
              </div>
            ) : null}
          </div>

          {activeView === 'approvals' ? (
            <button
              onClick={() => {
                void refresh();
              }}
              style={{ ...glassButtonStyle(44, 'neutral', true, palette), borderRadius: MOBILE_CARD_RADIUS }}
              aria-label="Refresh"
            >
              <IconRefresh fill={palette.iconFill} />
            </button>
          ) : (
            <div style={{ width: 44, flexShrink: 0 }} />
          )}
        </div>

        {error ? (
          <div
            style={{
              backgroundColor: palette.dangerSoft,
              border: `1px solid ${palette.dangerBorder}`,
              borderRadius: MOBILE_CARD_RADIUS,
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 13,
              color: palette.rootText,
            }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {activeView === 'approvals' ? (
            <ApprovalsView approvals={approvals} onResolve={handleResolve} resolving={resolving} palette={palette} />
          ) : null}

          {activeView === 'chat' && !currentTabId ? (
            <ChatListView
              conversations={recentConversations}
              loading={recentLoading}
              onSelect={setCurrentTabId}
              onNewChat={() => {
                setCurrentTabId(generateChatTabId());
              }}
              onRefresh={() => {
                void loadRecentConversations();
              }}
              palette={palette}
            />
          ) : null}

          {activeView === 'chat' && currentTabId ? (
            <AssistantChatView
              currentTabId={currentTabId}
              onTabIdChange={setCurrentTabId}
              onConversationSaved={() => {
                void loadRecentConversations();
              }}
              selectedModel={selectedModel}
              repoPath={selectedRepoPath}
              repoOptions={repoOptions}
              onRepoPathChange={handleRepoChange}
              onRepoPathLoaded={handleRepoChange}
              palette={palette}
            />
          ) : null}

          {activeView === 'settings' ? (
            <SettingsView
              themeId={themeId}
              onThemeChange={handleThemeChange}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              effortLevel={effortLevel}
              onEffortChange={handleEffortChange}
              connectionStatus={connectionStatus}
              appVersion={appVersion}
              palette={palette}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
