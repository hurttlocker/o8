'use client';

/**
 * SettingsPage — Thin shell that manages tab routing and GitHub state.
 *
 * All tab bodies live in `./settings/*.tsx`.
 * GitHub state (accounts, repos, deviceFlow, brokerStatus) is managed here
 * and passed as props to GitHubTab because it requires cross-tab persistence.
 */

import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import type {
  SettingsTab,
  GitHubAccount,
  GitHubRepo,
  GitHubBrokerStatus,
  GitHubDeviceFlowState,
  GitHubActionKind,
} from './settings/shared';
import {
  TabButton,
  PlugIcon,
  KeyIcon,
  PaletteIcon,
  ActivityIcon,
  InfoIcon,
} from './settings/shared';
import { GitHubTab } from './settings/GitHubTab';
import { APIKeysTab } from './settings/APIKeysTab';
import { MCPTab } from './settings/MCPTab';
import { AppearanceTab } from './settings/AppearanceTab';
import { DiagnosticsTab } from './settings/DiagnosticsTab';
import { AboutTab } from './settings/AboutTab';

export type { SettingsTab } from './settings/shared';

// ── Main Settings Page ──

export function SettingsPage({ initialTab = 'connectors' }: { initialTab?: SettingsTab }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoCount, setRepoCount] = useState(0);
  const [brokerStatus, setBrokerStatus] = useState<GitHubBrokerStatus | null>(null);
  const [deviceFlowEnabled, setDeviceFlowEnabled] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<GitHubDeviceFlowState | null>(null);
  const [actionBusy, setActionBusy] = useState<GitHubActionKind | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Fetch GitHub status on mount
  const loadGitHubStatus = useCallback(async (showRefreshState = false) => {
    try {
      if (showRefreshState) {
        setActionBusy('refresh');
        setActionNote(null);
      }
      const res = await fetch('/api/panel/github-status');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      // API returns { authenticated, username, repos } — map to accounts array
      if (data.authenticated && data.username) {
        setAccounts([{
          login: data.username,
          name: data.username,
          avatarUrl: `https://github.com/${data.username}.png`,
          active: true,
          scopes: ['repo', 'read:org'],
          protocol: 'https',
        }]);
      } else if (data.accounts) {
        setAccounts(data.accounts);
      } else {
        setAccounts([]);
      }
      const nextRepos = Array.isArray(data.repos) ? data.repos : [];
      setRepos(nextRepos);
      setRepoCount(Array.isArray(data.repos) ? data.repos.length : Number(data.repos ?? 0));
      setBrokerStatus(data.broker ?? null);
      setDeviceFlowEnabled(Boolean(data.deviceFlowEnabled ?? true));
    } catch {
      setActionNote('Unable to refresh GitHub status right now.');
    } finally {
      setLoading(false);
      if (showRefreshState) setActionBusy(null);
    }
  }, []);

  useEffect(() => {
    void loadGitHubStatus();
  }, [loadGitHubStatus]);

  const runGitHubAction = useCallback(async (
    action: Extract<GitHubActionKind, 'switch' | 'logout' | 'login_token'>,
    payload: { user?: string; token?: string },
  ) => {
    setActionBusy(action);
    setActionNote(null);
    try {
      const res = await fetch('/api/panel/github-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'GitHub action failed');
      }
      setActionNote(data.note || 'GitHub settings updated.');
      const refreshRes = await fetch('/api/panel/github-status');
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        setAccounts(refreshData.accounts || []);
        const nextRepos = Array.isArray(refreshData.repos) ? refreshData.repos : [];
        setRepos(nextRepos);
        setRepoCount(Array.isArray(refreshData.repos) ? refreshData.repos.length : Number(refreshData.repos ?? 0));
        setBrokerStatus(refreshData.broker ?? null);
      }
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : 'GitHub action failed.');
    } finally {
      setActionBusy(null);
    }
  }, []);

  const startDeviceFlow = useCallback(async () => {
    setActionBusy('login_device');
    setActionNote(null);
    try {
      const res = await fetch('/api/panel/github-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Unable to start GitHub device login.');
      }
      setDeviceFlow({
        flowId: data.flowId,
        userCode: data.userCode,
        verificationUri: data.verificationUri,
        verificationUriComplete: data.verificationUriComplete,
        expiresAt: data.expiresAt,
        expiresInMinutes: data.expiresInMinutes,
        nextPollInMs: data.nextPollInMs,
        note: data.note,
      });
      setActionNote('GitHub device login started. Open GitHub, approve access, and this panel will finish the local sign-in.');
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : 'Unable to start GitHub device login.');
    } finally {
      setActionBusy(null);
    }
  }, []);

  const pollDeviceFlow = useCallback(async (flowId: string) => {
    try {
      const res = await fetch('/api/panel/github-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'poll', flowId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'GitHub device login failed.');
      }

      if (data.status === 'pending') {
        setDeviceFlow((current) => current?.flowId === flowId ? {
          ...current,
          expiresAt: data.expiresAt ?? current.expiresAt,
          expiresInMinutes: data.expiresInMinutes ?? current.expiresInMinutes,
          nextPollInMs: data.nextPollInMs ?? current.nextPollInMs,
          note: data.note ?? current.note,
          verificationUri: data.verificationUri ?? current.verificationUri,
          verificationUriComplete: data.verificationUriComplete ?? current.verificationUriComplete,
        } : current);
        return;
      }

      setDeviceFlow(null);
      setActionNote(data.note || 'GitHub device login finished.');

      if (data.status === 'complete') {
        await loadGitHubStatus(true);
      }
    } catch (error) {
      setDeviceFlow(null);
      setActionNote(error instanceof Error ? error.message : 'GitHub device login failed.');
    }
  }, [loadGitHubStatus]);

  const cancelDeviceFlow = useCallback(async (flowId: string) => {
    setActionBusy('cancel_device');
    try {
      const res = await fetch('/api/panel/github-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', flowId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Unable to cancel GitHub device login.');
      }
      setDeviceFlow(null);
      setActionNote(data.note || 'GitHub device login cancelled.');
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : 'Unable to cancel GitHub device login.');
    } finally {
      setActionBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!deviceFlow?.flowId) return;
    const timeout = window.setTimeout(() => {
      void pollDeviceFlow(deviceFlow.flowId);
    }, Math.max(1000, deviceFlow.nextPollInMs));
    return () => window.clearTimeout(timeout);
  }, [deviceFlow, pollDeviceFlow]);

  return (
    <div
      className="hide-scrollbar"
      style={{
        height: '100%',
        overflow: 'auto',
        padding: 24,
        background: 'var(--t-bg-gradient)',
        display: 'flex',
        gap: 20,
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        WebkitOverflowScrolling: 'touch',
      } as CSSProperties}
    >
      {/* Left sidebar — tab navigation */}
      <div style={{
        width: 200,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--t-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          padding: '8px 14px',
          marginBottom: 4,
        }}>
          Settings
        </div>
        <TabButton label="Connectors" icon={<PlugIcon />} active={activeTab === 'connectors'} onClick={() => setActiveTab('connectors')} />
        <TabButton label="API Keys" icon={<KeyIcon />} active={activeTab === 'api-keys'} onClick={() => setActiveTab('api-keys')} />
        <TabButton label="MCP" icon={<PlugIcon />} active={activeTab === 'mcp'} onClick={() => setActiveTab('mcp')} />
        <TabButton label="Appearance" icon={<PaletteIcon />} active={activeTab === 'appearance'} onClick={() => setActiveTab('appearance')} />
        <TabButton label="Diagnostics" icon={<ActivityIcon />} active={activeTab === 'diagnostics'} onClick={() => setActiveTab('diagnostics')} />
        <TabButton label="About" icon={<InfoIcon />} active={activeTab === 'about'} onClick={() => setActiveTab('about')} />
      </div>

      {/* Right content — full width */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {activeTab === 'connectors' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <GitHubTab
              accounts={accounts}
              repos={repos}
              repoCount={repoCount}
              broker={brokerStatus}
              loading={loading}
              actionBusy={actionBusy}
              actionNote={actionNote}
              onRefresh={() => { void loadGitHubStatus(true); }}
              onSwitchAccount={(user) => { void runGitHubAction('switch', { user }); }}
              onDisconnect={(user) => { void runGitHubAction('logout', { user }); }}
              onLoginWithToken={(token) => { void runGitHubAction('login_token', { token }); }}
              deviceFlowEnabled={deviceFlowEnabled}
              deviceFlow={deviceFlow}
              onStartDeviceFlow={() => { void startDeviceFlow(); }}
              onPollDeviceFlow={(flowId) => { void pollDeviceFlow(flowId); }}
              onCancelDeviceFlow={(flowId) => { void cancelDeviceFlow(flowId); }}
            />
          </div>
        )}
        {activeTab === 'api-keys' && (
          <APIKeysTab />
        )}
        {activeTab === 'mcp' && (
          <MCPTab />
        )}
        {activeTab === 'appearance' && (
          <AppearanceTab />
        )}
        {activeTab === 'diagnostics' && (
          <DiagnosticsTab />
        )}
        {activeTab === 'about' && (
          <AboutTab />
        )}
      </div>
    </div>
  );
}
