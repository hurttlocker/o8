'use client';

/**
 * SettingsPage — Thin shell that manages tab routing and GitHub state.
 *
 * All tab bodies live in `./settings/*.tsx`.
 * GitHub state (identity, gh CLI, device flow, broker status) is managed here
 * and passed to the single Git & PRs connection surface.
 */

import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import type {
  SettingsTab,
  GitHubAccount,
  GitHubBrokerStatus,
  GitHubDeviceFlowState,
  GitHubActionKind,
} from './settings/shared';
import { searchSettings, SETTINGS_SEARCH_REGISTRY } from './settings/settings-search';
import { useEntitlement } from '@/lib/entitlement/context';
import { isPaidPlan } from '@/lib/entitlement/flags';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  SettingsTabSectionHeader as SectionHeader,
  PlugIcon,
  KeyIcon,
  MobileIcon,
  LayersIcon,
  PaletteIcon,
  ActivityIcon,
  InfoIcon,
  SlidersIcon,
  CreditCardIcon,
  MicIcon,
  GitHubIcon,
  BrainIcon,
  SETTINGS_CONTENT_MAX_WIDTH,
  SETTINGS_WIDE_CONTENT_MAX_WIDTH,
} from './settings/shared';
import { SettingsNavItem } from './settings/SettingsNavItem';
import { useSettingsSectionNavigation } from './settings/useSettingsSectionNavigation';
import { GeneralTab } from './settings/GeneralTab';
import type { GitHubConnectionProps } from './settings/GitHubTab';
import { GitPrsTab } from './settings/GitPrsTab';
import { IndexingTab } from './settings/IndexingTab';
import { WorktreeRetentionSection } from './settings/WorktreeRetentionSection';
import { ModelsTab } from './settings/ModelsTab';
import { APIKeysTab } from './settings/APIKeysTab';
import { MCPTab } from './settings/MCPTab';
import { ConnectionsTab } from './settings/ConnectionsTab';
import { OperatorDefaultsTab } from './settings/OperatorDefaultsTab';
import { ProjectsPanel } from './settings/ProjectsPanel';
import { AppearanceTab } from './settings/AppearanceTab';
import { VoiceTab } from './settings/VoiceTab';
import { PermissionsTab } from './settings/PermissionsTab';
import { BillingTab } from './settings/BillingTab';
import { DiagnosticsTab } from './settings/DiagnosticsTab';
import { AboutTab } from './settings/AboutTab';
import { AnalyticsPage } from './AnalyticsPage';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { requestO8Capability } from '@/lib/auth/capabilities';

export type { SettingsTab } from './settings/shared';

function BackSettingsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z" />
    </svg>
  );
}

function GearNavIcon({ size = 16 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CpuNavIcon({ size = 16 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </svg>
  );
}

function ShieldNavIcon({ size = 16 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function SearchNavIcon({ size = 13 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z" />
    </svg>
  );
}

// ── Main Settings Page ──

export function SettingsPage({ initialTab = 'general', onClose }: { initialTab?: SettingsTab; onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [openNavTab, setOpenNavTab] = useState<SettingsTab | null>(null);
  const { contentRef, navigate, notice } = useSettingsSectionNavigation(activeTab, setActiveTab);
  const { founder, plan } = useEntitlement();
  const auth = useO8Auth();
  const searchMatches = useMemo(
    () => searchSettings(SETTINGS_SEARCH_REGISTRY, searchQuery, { founder: Boolean(founder) }),
    [searchQuery, founder],
  );
  const searching = searchQuery.trim().length >= 2;
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [repoCount, setRepoCount] = useState(0);
  const [brokerStatus, setBrokerStatus] = useState<GitHubBrokerStatus | null>(null);
  const [deviceFlowEnabled, setDeviceFlowEnabled] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<GitHubDeviceFlowState | null>(null);
  const [actionBusy, setActionBusy] = useState<GitHubActionKind | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const githubStatusLoadedRef = useRef(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Fetch GitHub status when its owning tab is first shown.
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
    if (activeTab !== 'git-prs' || githubStatusLoadedRef.current) return;
    githubStatusLoadedRef.current = true;
    void loadGitHubStatus();
  }, [activeTab, loadGitHubStatus]);

  const runGitHubAction = useCallback(async (
    action: Extract<GitHubActionKind, 'logout' | 'login_token'>,
    payload: { user?: string; token?: string },
  ) => {
    setActionBusy(action);
    setActionNote(null);
    try {
      const res = await fetch('/api/panel/github-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'GitHub action failed');
      }
      setActionNote(data.note || 'GitHub settings updated.');
      await loadGitHubStatus();
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : 'GitHub action failed.');
    } finally {
      setActionBusy(null);
    }
  }, [loadGitHubStatus]);

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
        csrfToken: data.csrfToken,
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
        body: JSON.stringify({ action: 'poll', flowId, csrfToken: deviceFlow?.csrfToken }),
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
        await loadGitHubStatus();
      }
    } catch (error) {
      setDeviceFlow(null);
      setActionNote(error instanceof Error ? error.message : 'GitHub device login failed.');
    }
  }, [deviceFlow?.csrfToken, loadGitHubStatus]);

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

  const connectGitHub = useCallback(() => {
    requestO8Capability({
      capability: 'github.local',
      signedIn: auth.signedIn,
      onAccountRequired: auth.signIn,
      onReady: () => { void startDeviceFlow(); },
    });
  }, [auth, startDeviceFlow]);

  const githubConnection: GitHubConnectionProps = {
    auth,
    managedAppEntitled: isPaidPlan(plan),
    accounts,
    repoCount,
    broker: brokerStatus,
    loading,
    actionBusy,
    actionNote,
    onRefresh: () => { void loadGitHubStatus(true); },
    onDisconnect: (user: string) => { void runGitHubAction('logout', { user }); },
    onLoginWithToken: (token: string) => { void runGitHubAction('login_token', { token }); },
    deviceFlowEnabled,
    deviceFlow,
    onConnect: connectGitHub,
    onPollDeviceFlow: (flowId: string) => { void pollDeviceFlow(flowId); },
    onCancelDeviceFlow: (flowId: string) => { void cancelDeviceFlow(flowId); },
  };

  return (
    <div data-settings-shell style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--t-chat-surface-bg)' }}>
      <style>{`
        [data-settings-shell], [data-settings-shell] * {
          scrollbar-width: none !important;
        }
        [data-settings-shell]::-webkit-scrollbar,
        [data-settings-shell] *::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
      `}</style>
      {onClose ? (
        <header data-tauri-drag-region style={{ flexShrink: 0, paddingTop: 12, paddingRight: 24, paddingBottom: 12, paddingLeft: 24, borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
          <button
            type="button"
            aria-label="Back to workspace"
            title="Back to workspace"
            onClick={onClose}
            style={{
              gap: 8,
              fontFamily: APP_FONT_STACK,
              fontSize: 13,
              height: 34,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              background: 'var(--t-bg-card)',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms, border-color 120ms',
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = 'var(--t-panel-hover)';
              event.currentTarget.style.borderColor = 'var(--t-panel-border)';
              event.currentTarget.style.color = 'var(--t-text)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'var(--t-bg-card)';
              event.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
              event.currentTarget.style.color = 'var(--t-text-muted)';
            }}
          >
            <BackSettingsIcon />
            Back to workspace
          </button>
        </header>
      ) : null}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          paddingTop: 24,
          paddingRight: 24,
          paddingBottom: 24,
          paddingLeft: 24,
          background: 'var(--t-chat-surface-bg)',
          color: 'var(--t-chat-surface-text)',
          display: 'flex',
          gap: 28,
          fontFamily: APP_FONT_STACK,
          position: 'relative',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
        } as CSSProperties}
      >
        {/* Left sidebar — tab navigation */}
        <div style={{
          width: 228,
          flexShrink: 0,
          overflowY: 'auto', scrollbarWidth: 'none',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          borderRight: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          paddingRight: 4,
        }}>
          <div style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            color: RAMS_INK_QUIET,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            paddingTop: 16,
            paddingRight: 14,
            paddingBottom: 18,
            paddingLeft: 16,
          }}>
            Settings
          </div>
          {/* Sticky settings search (Cursor parity) — filters the row registry
              across every tab; a result jumps to its tab. */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginLeft: 10,
            marginRight: 10,
            marginBottom: 10,
            paddingLeft: 10,
            paddingRight: 10,
            height: 30,
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            background: 'var(--t-input-bg)',
            color: RAMS_INK_QUIET,
            flexShrink: 0,
          }}>
            <SearchNavIcon />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setSearchQuery('');
                }
                if (event.key === 'Enter' && searchMatches.length > 0) {
                  navigate(searchMatches[0].tab, searchMatches[0].group);
                  setSearchQuery('');
                }
              }}
              placeholder="Search settings"
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontFamily: APP_FONT_STACK,
                fontSize: 12.5,
                fontWeight: 300,
                letterSpacing: '-0.01em',
                color: 'var(--t-text)',
                padding: 0,
              }}
            />
          </div>
          {searching ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
              {searchMatches.length === 0 ? (
                <div style={{
                  fontFamily: APP_FONT_STACK,
                  fontSize: 12,
                  fontWeight: 300,
                  color: RAMS_INK_QUIET,
                  paddingTop: 10,
                  paddingLeft: 14,
                  paddingRight: 14,
                }}>
                  No settings match &ldquo;{searchQuery.trim()}&rdquo;
                </div>
              ) : searchMatches.map((match) => (
                <button
                  key={`${match.tab}:${match.group ?? ''}:${match.label}`}
                  type="button"
                  onClick={() => {
                    navigate(match.tab, match.group);
                    setSearchQuery('');
                  }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 2,
                    width: '100%',
                    paddingTop: 8,
                    paddingRight: 12,
                    paddingBottom: 8,
                    paddingLeft: 14,
                    borderRadius: 10,
                    borderWidth: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: APP_FONT_STACK,
                  }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{
                    fontSize: 13,
                    fontWeight: 400,
                    letterSpacing: '-0.01em',
                    color: 'var(--t-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}>
                    {match.label}
                  </span>
                  <span style={{
                    fontSize: 10.5,
                    fontWeight: 300,
                    letterSpacing: '-0.005em',
                    color: RAMS_INK_QUIET,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}>
                    {match.tabLabel}{match.group ? ` › ${match.group}` : ''}
                  </span>
                </button>
              ))}
            </div>
          ) : (
          <>
          <SectionHeader>General</SectionHeader>
          <SettingsNavItem label="General" icon={<GearNavIcon />} active={activeTab === 'general'} tab="general" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Appearance" icon={<PaletteIcon />} active={activeTab === 'appearance'} tab="appearance" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Voice" icon={<MicIcon />} active={activeTab === 'voice'} tab="voice" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Permissions" icon={<ShieldNavIcon />} active={activeTab === 'permissions'} tab="permissions" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />

          <SectionHeader>Agents</SectionHeader>
          <SettingsNavItem label="Dispatch" icon={<SlidersIcon />} active={activeTab === 'operator-defaults'} tab="operator-defaults" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Models & providers" icon={<CpuNavIcon />} active={activeTab === 'models'} tab="models" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />

          <SectionHeader>Workspace</SectionHeader>
          <SettingsNavItem label="Worktrees & storage" icon={<LayersIcon />} active={activeTab === 'worktrees'} tab="worktrees" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Projects" icon={<LayersIcon />} active={activeTab === 'projects'} tab="projects" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Git & PRs" icon={<GitHubIcon size={16} />} active={activeTab === 'git-prs'} tab="git-prs" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Indexing" icon={<BrainIcon />} active={activeTab === 'indexing'} tab="indexing" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />

          <SectionHeader>Connections</SectionHeader>
          {process.env.NEXT_PUBLIC_O8_SHOW_BYOK === '1' && (
            <SettingsNavItem label="API Keys" icon={<KeyIcon />} active={activeTab === 'api-keys'} tab="api-keys" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          )}
          <SettingsNavItem label="MCP" icon={<PlugIcon />} active={activeTab === 'mcp'} tab="mcp" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Mobile" icon={<MobileIcon />} active={activeTab === 'connections'} tab="connections" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />

          <SectionHeader>System</SectionHeader>
          <SettingsNavItem label="Plan & Billing" icon={<CreditCardIcon />} active={activeTab === 'billing'} tab="billing" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Analytics" icon={<ActivityIcon />} active={activeTab === 'analytics'} tab="analytics" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="Diagnostics" icon={<ActivityIcon />} active={activeTab === 'diagnostics'} tab="diagnostics" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          <SettingsNavItem label="About" icon={<InfoIcon />} active={activeTab === 'about'} tab="about" openTab={openNavTab} onOpen={setOpenNavTab} onNavigate={navigate} />
          </>
          )}
          {notice ? <p role="status" style={{ fontSize: 12, lineHeight: 1.4, padding: 10, color: 'var(--t-text-secondary)' }}>{notice}</p> : null}
        </div>

        {/* Center the actual tab width, not a wide frame around narrow cards.
            Tables and analytics retain a wider centered column. */}
        <div
          data-settings-content
          ref={contentRef}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto', scrollbarWidth: 'none',
            scrollPaddingTop: 8,
            display: 'grid',
            gridTemplateColumns: `minmax(0, ${activeTab === 'projects' || activeTab === 'analytics' ? SETTINGS_WIDE_CONTENT_MAX_WIDTH : SETTINGS_CONTENT_MAX_WIDTH}px)`,
            alignContent: 'start',
            justifyContent: 'center',
          }}
        >
          {activeTab === 'general' && (
            <GeneralTab onNavigateTab={setActiveTab} />
          )}
          {activeTab === 'api-keys' && (
            <APIKeysTab />
          )}
          {activeTab === 'mcp' && (
            <MCPTab />
          )}
          {activeTab === 'connections' && (
            <ConnectionsTab />
          )}
          {activeTab === 'operator-defaults' && (
            <OperatorDefaultsTab onNavigateTab={navigate} />
          )}
          {activeTab === 'worktrees' && <WorktreeRetentionSection />}
          {activeTab === 'projects' && (
            <ProjectsPanel />
          )}
          {activeTab === 'git-prs' && (
            <GitPrsTab {...githubConnection} />
          )}
          {activeTab === 'indexing' && (
            <IndexingTab />
          )}
          {activeTab === 'models' && (
            <ModelsTab onNavigateTab={navigate} />
          )}
          {activeTab === 'analytics' && (
            <AnalyticsPage embedded />
          )}
          {activeTab === 'appearance' && (
            <AppearanceTab />
          )}
          {activeTab === 'voice' && (
            <VoiceTab />
          )}
          {activeTab === 'permissions' && (
            <PermissionsTab />
          )}
          {activeTab === 'billing' && (
            <BillingTab />
          )}
          {activeTab === 'diagnostics' && (
            <DiagnosticsTab />
          )}
          {activeTab === 'about' && (
            <AboutTab />
          )}
        </div>
      </div>
    </div>
  );
}
