'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '@/lib/theme/context';
import { MobileAuroraBg } from './mobile-aurora-bg';
import { ApprovalsView } from './mobile-approvals-approvals-view';
import { ChatListView } from './mobile-approvals-chat-list-view';
import { ChatView } from './mobile-approvals-chat-view';
import { Sidebar } from './mobile-approvals-sidebar';
import {
  DEFAULT_MOBILE_CHAT_MODEL,
  IconArrowLeft,
  IconHamburger,
  IconRefresh,
  MOBILE_CHAT_MODEL_STORAGE_KEY,
  POLL_INTERVAL,
  generateChatTabId,
  getMobilePalette,
  getModelOption,
  glassButtonStyle,
  isGovernanceApproval,
  mobileFontFamily,
  normalizeHistoryList,
  readStoredMobileModel,
  type ApprovalItem,
  type ChatHistoryRecord,
  type MobileView,
} from './mobile-approvals-shared';
import { SettingsView } from './mobile-settings-view';

function getWsToken() {
  if (typeof document === 'undefined') return null;
  return document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? null;
}

function getWsBridgeUrl(token: string) {
  if (typeof window === 'undefined') return null;

  const isTauri = window.location.protocol === 'tauri:' || Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const host = isTauri ? '127.0.0.1' : window.location.hostname || '127.0.0.1';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  return `${protocol}//${host}:3002/ws?token=${encodeURIComponent(token)}`;
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
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTabId, setCurrentTabId] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<ChatHistoryRecord[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState(readStoredMobileModel);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('disconnected');

  const selectedModel = useMemo(
    () => getModelOption(selectedModelId) ?? getModelOption(DEFAULT_MOBILE_CHAT_MODEL)!,
    [selectedModelId],
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
    if (!sidebarOpen) return;
    void loadRecentConversations();
  }, [loadRecentConversations, sidebarOpen]);

  useEffect(() => {
    if (activeView === 'chat' && !currentTabId) {
      void loadRecentConversations();
    }
  }, [activeView, currentTabId, loadRecentConversations]);

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
        if (!cancelled) {
          setConnectionStatus('connected');
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
        reconnectTimer = setTimeout(connect, 2500);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const handleResolve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setResolving(id);
    try {
      const response = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });

      if (response.ok) {
        setApprovals((previous) => previous.filter((approval) => approval.id !== id));
      } else {
        const data = await response.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Failed to resolve approval');
      }
    } catch {
      setError('Unable to reach server');
    }
    setResolving(null);
  }, []);

  const handleSelectConversation = useCallback((tabId: string) => {
    setCurrentTabId(tabId);
    setActiveView('chat');
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

  const governanceCount = useMemo(
    () => approvals.filter((approval) => approval.status === 'pending' && isGovernanceApproval(approval)).length,
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
        height: '100%',
        overflow: 'hidden',
        backgroundColor: palette.rootBackground,
        color: palette.rootText,
        fontFamily: mobileFontFamily(),
        WebkitFontSmoothing: 'antialiased',
      } as CSSProperties}
    >
      <MobileAuroraBg themeId={themeId} />

      <div style={{ position: 'relative', zIndex: 1, height: '100%', padding: '0 16px', display: 'flex', flexDirection: 'column' }}>
        <Sidebar
          open={sidebarOpen}
          activeView={activeView}
          approvalCount={governanceCount}
          currentTabId={currentTabId}
          recentConversations={recentConversations}
          recentLoading={recentLoading}
          onNavigate={setActiveView}
          onSelectConversation={handleSelectConversation}
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
              style={{ ...glassButtonStyle(40, 'neutral', true, palette), borderRadius: 14 }}
              aria-label="Back to chats"
            >
              <IconArrowLeft fill={palette.iconFill} />
            </button>
          ) : (
            <button
              onClick={() => setSidebarOpen(true)}
              style={{ ...glassButtonStyle(40, 'neutral', true, palette), borderRadius: 14, position: 'relative' }}
              aria-label="Menu"
            >
              <IconHamburger fill={palette.iconFill} />
              {governanceCount > 0 && activeView !== 'approvals' ? (
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
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'center',
              color: palette.rootText,
            }}
          >
            {viewTitle}
          </div>

          {activeView === 'approvals' ? (
            <button
              onClick={() => {
                void refresh();
              }}
              style={{ ...glassButtonStyle(40, 'neutral', true, palette), borderRadius: 14 }}
              aria-label="Refresh"
            >
              <IconRefresh fill={palette.iconFill} />
            </button>
          ) : (
            <div style={{ width: 40, flexShrink: 0 }} />
          )}
        </div>

        {error ? (
          <div
            style={{
              backgroundColor: palette.dangerSoft,
              border: `1px solid ${palette.dangerBorder}`,
              borderRadius: 14,
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
            <ChatView
              currentTabId={currentTabId}
              onTabIdChange={setCurrentTabId}
              onConversationSaved={() => {
                void loadRecentConversations();
              }}
              selectedModel={selectedModel}
              palette={palette}
            />
          ) : null}

          {activeView === 'settings' ? (
            <SettingsView
              themeId={themeId}
              onThemeChange={handleThemeChange}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
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
