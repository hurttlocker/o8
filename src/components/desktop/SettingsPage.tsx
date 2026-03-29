'use client';

/**
 * SettingsPage — Full workspace settings panel.
 *
 * First tab: GitHub connection status + account management.
 * Future tabs: Slack, Linear, Vault config, Agent defaults, etc.
 */

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import packageJson from '../../../package.json';
import { useTheme } from '@/lib/theme/context';
import { formatModelLabel } from '@/lib/format';
import {
  readNavRailHoverExpandEnabled,
  subscribeNavRailHoverExpandEnabled,
  writeNavRailHoverExpandEnabled,
} from '@/lib/appearance/nav-rail';
import {
  appendOpenClawBetaQuery,
  type OpenClawIntegrationMode,
  type OpenClawIntegrationStatus,
  readOpenClawBetaStatus,
  readOpenClawBetaEnabled,
  refreshOpenClawBetaStatus,
  setOpenClawBetaMode,
  subscribeOpenClawBetaEnabled,
  subscribeOpenClawBetaStatus,
} from '@/lib/connectors/openclaw-beta';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
  writeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

// ── Types ──

interface GitHubAccount {
  login: string;
  name: string;
  avatarUrl: string;
  active: boolean;
  scopes: string[];
  protocol: string;
}

interface GitHubRepo {
  nameWithOwner: string;
  isPrivate: boolean;
  updatedAt: string;
}

interface GitHubBrokerStatus {
  configured: boolean;
  appId: string | null;
  privateKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  publicBaseUrlConfigured: boolean;
  webhookUrl: string | null;
  productionWebhookReady: boolean;
  installationReachable: boolean;
  installationId: number | null;
  installationAccount: string | null;
  probeRepo: string | null;
  tokenReady: boolean;
  authSource: 'github-app' | 'local-gh' | 'none';
  note: string;
}

interface GitHubDeviceFlowState {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  expiresInMinutes: number;
  nextPollInMs: number;
  note?: string;
}

type GitHubActionKind = 'refresh' | 'switch' | 'logout' | 'login_token' | 'login_device' | 'cancel_device';

export type SettingsTab = 'connectors' | 'agents' | 'api-keys' | 'memory' | 'appearance' | 'diagnostics' | 'about';

interface OpenClawGatewayStatus {
  connected: boolean;
  gatewayUrl: string;
  version: string;
  agentCount?: number;
  platform?: string;
  nodeVersion?: string;
  mode?: string;
  uptime?: string | null;
}

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';

function normalizeVersion(value?: string | null, fallback = '—') {
  if (!value) return fallback;
  const trimmed = String(value).replace(/^cortex\s+/i, '').trim();
  if (!trimmed || trimmed === 'unknown') return fallback;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

async function fetchOpenClawGatewayStatus(): Promise<OpenClawGatewayStatus | null> {
  try {
    const res = await fetch('/api/panel/status');
    if (!res.ok) throw new Error('Failed to fetch OpenClaw status');
    const data = await res.json();
    return {
      connected: Boolean(data.connected),
      gatewayUrl: data.gatewayUrl || '127.0.0.1:18789',
      version: data.version || 'unknown',
      agentCount: data.agentCount ?? 0,
      platform: data.platform || '',
      nodeVersion: data.nodeVersion || '',
      mode: data.mode || 'local',
      uptime: data.uptime || null,
    };
  } catch {
    return null;
  }
}

function useOpenClawBetaEnabledState() {
  const [enabled, setEnabled] = useState(() => readOpenClawBetaEnabled());

  useEffect(() => {
    void refreshOpenClawBetaStatus().then((status) => setEnabled(status.effective_enabled));
    return subscribeOpenClawBetaEnabled(setEnabled);
  }, []);

  return [enabled, setEnabled] as const;
}

function useOpenClawBetaStatusState() {
  const [status, setStatus] = useState<OpenClawIntegrationStatus>(() => readOpenClawBetaStatus());

  useEffect(() => {
    void refreshOpenClawBetaStatus().then(setStatus);
    return subscribeOpenClawBetaStatus(setStatus);
  }, []);

  return [status, setStatus] as const;
}

// ── SVG Icons ──

function GitHubIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/>
      <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/>
      <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/>
      <circle cx="6.5" cy="12" r="0.5" fill="currentColor"/>
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/>
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396"/>
      <path d="M19.938 10.5a4 4 0 0 1 .585.396"/>
      <path d="M6 18a4 4 0 0 1-1.967-.516"/>
      <path d="M19.967 17.484A4 4 0 0 1 18 18"/>
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 22v-5"/>
      <path d="M9 8V2"/>
      <path d="M15 8V2"/>
      <path d="M18 8v5a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V8z"/>
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>
  );
}

// ── Settings Tab Button ──

function TabButton({ label, icon, active, onClick }: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '10px 14px',
        borderRadius: 10,
        border: active ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid transparent',
        background: active ? THEME_ACCENT_SOFT : 'transparent',
        color: active ? THEME_ACCENT : 'var(--t-text-secondary)',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 120ms, color 120ms, border-color 120ms, box-shadow 120ms',
        boxShadow: active ? `0 10px 24px ${THEME_ACCENT_RING}` : 'none',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Scope Badge ──

function ScopeBadge({ scope }: { scope: string }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 6,
      fontSize: 10,
      fontWeight: 600,
      background: THEME_ACCENT_SOFT,
      color: THEME_ACCENT,
      letterSpacing: '0.01em',
    }}>
      {scope}
    </span>
  );
}

function ScopeDiagnostic({
  title,
  status,
  detail,
}: {
  title: string;
  status: 'ready' | 'partial' | 'missing';
  detail: string;
}) {
  const tone = status === 'ready'
    ? { bg: 'rgba(34, 197, 94, 0.08)', border: 'rgba(34, 197, 94, 0.16)', text: '#166534', pill: '#22c55e', label: 'Ready' }
    : status === 'partial'
      ? { bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.18)', text: '#92400e', pill: '#f59e0b', label: 'Partial' }
      : { bg: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.16)', text: '#991b1b', pill: '#ef4444', label: 'Missing' };

  return (
    <div style={{
      padding: 12,
      borderRadius: 10,
      background: tone.bg,
      border: `1px solid ${tone.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{title}</span>
        <span style={{
          padding: '2px 7px',
          borderRadius: 999,
          background: `${tone.pill}22`,
          color: tone.text,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.01em',
          marginLeft: 'auto',
        }}>
          {tone.label}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.45 }}>
        {detail}
      </div>
    </div>
  );
}

function GitHubAvatar({
  avatarUrl,
  login,
  size,
}: {
  avatarUrl?: string;
  login: string;
  size: number;
}) {
  const [failed, setFailed] = useState(false);

  if (!avatarUrl || failed) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        border: '1px solid rgba(37, 99, 235, 0.18)',
        background: 'rgba(37, 99, 235, 0.08)',
        color: '#2563eb',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <GitHubIcon size={Math.max(14, Math.floor(size * 0.48))} />
      </div>
    );
  }

  return (
    <Image
      src={avatarUrl}
      alt={login}
      width={size}
      height={size}
      unoptimized
      onError={() => setFailed(true)}
      style={{
        borderRadius: size / 2,
        border: '2px solid rgba(37, 99, 235, 0.2)',
        flexShrink: 0,
      }}
    />
  );
}

function QuickLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        padding: '7px 12px',
        borderRadius: 8,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel)',
        color: 'var(--t-text-secondary)',
        fontSize: 11,
        fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      {label}
    </a>
  );
}

// ── GitHub Tab Content ──

function ChevronDownIcon({ rotated }: { rotated?: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      style={{ display: 'block', flexShrink: 0, transition: 'transform 200ms', transform: rotated ? 'rotate(180deg)' : 'rotate(0)' }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

function GitHubTab({
  accounts,
  repos,
  repoCount,
  broker,
  loading,
  actionBusy,
  actionNote,
  onRefresh,
  onSwitchAccount,
  onDisconnect,
  onLoginWithToken,
  deviceFlowEnabled,
  deviceFlow,
  onStartDeviceFlow,
  onPollDeviceFlow,
  onCancelDeviceFlow,
}: {
  accounts: GitHubAccount[];
  repos: GitHubRepo[];
  repoCount: number;
  broker: GitHubBrokerStatus | null;
  loading: boolean;
  actionBusy?: GitHubActionKind | null;
  actionNote?: string | null;
  onRefresh?: () => void;
  onSwitchAccount?: (user: string) => void;
  onDisconnect?: (user: string) => void;
  onLoginWithToken?: (token: string) => void;
  deviceFlowEnabled?: boolean;
  deviceFlow?: GitHubDeviceFlowState | null;
  onStartDeviceFlow?: () => void;
  onPollDeviceFlow?: (flowId: string) => void;
  onCancelDeviceFlow?: (flowId: string) => void;
}) {
  const [expanded, setExpanded] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem('settings:github-expanded') === '1';
    } catch {
      return false;
    }
  });
  const [reposExpanded, setReposExpanded] = useState(false);
  const [patToken, setPatToken] = useState('');
  const [commandCopied, setCommandCopied] = useState(false);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const browserLoginCommand = 'gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key';

  async function copyBrowserLoginCommand() {
    try {
      await navigator.clipboard.writeText(browserLoginCommand);
      setCommandCopied(true);
      window.setTimeout(() => setCommandCopied(false), 1500);
    } catch {
      setCommandCopied(false);
    }
  }

  async function copyDeviceCode() {
    if (!deviceFlow?.userCode) return;
    try {
      await navigator.clipboard.writeText(deviceFlow.userCode);
      setDeviceCodeCopied(true);
      window.setTimeout(() => setDeviceCodeCopied(false), 1500);
    } catch {
      setDeviceCodeCopied(false);
    }
  }

  // Only show active accounts
  const activeAccounts = accounts.filter(a => a.active);
  const activeAccount = activeAccounts[0];
  const inactiveAccounts = accounts.filter(a => !a.active);
  const connected = !!activeAccount;
  const activeScopes = new Set(activeAccount?.scopes ?? []);
  const hasRepo = activeScopes.has('repo');
  const hasWorkflow = activeScopes.has('workflow');
  const hasReadOrg = activeScopes.has('read:org');
  const hasProject = activeScopes.has('project');
  const diagnostics: Array<{ title: string; status: 'ready' | 'partial' | 'missing'; detail: string }> = [
    {
      title: 'Repo access',
      status: hasRepo ? 'ready' : 'missing',
      detail: hasRepo
        ? 'Private and public repository operations are available through the local GitHub CLI session.'
        : 'Missing `repo`. Private repository access and most operator GitHub actions will be blocked.',
    },
    {
      title: 'Issues & PRs',
      status: hasRepo ? 'ready' : 'missing',
      detail: hasRepo
        ? 'Issue, pull request, and review lanes have the scope they need.'
        : 'Issue and pull-request workflows depend on `repo` scope for private repos.',
    },
    {
      title: 'Workflow runs',
      status: hasWorkflow ? 'ready' : hasRepo ? 'partial' : 'missing',
      detail: hasWorkflow
        ? 'GitHub Actions workflow visibility and updates are available.'
        : hasRepo
          ? 'Repository access is present, but `workflow` is missing so Actions-specific operations may be limited.'
          : 'No workflow diagnostics yet because base repository scope is also missing.',
    },
    {
      title: 'Org visibility',
      status: hasReadOrg ? 'ready' : 'missing',
      detail: hasReadOrg
        ? 'Organization and team visibility is available for org-backed repos and routing.'
        : 'Missing `read:org`. Organization membership and team-derived visibility can be incomplete.',
    },
    {
      title: 'Projects',
      status: hasProject ? 'ready' : 'partial',
      detail: hasProject
        ? 'GitHub Projects integrations can build on this auth state.'
        : 'Missing `project`. Core repo workflows still work, but future project-board integrations will need more scope.',
    },
  ];
  const quickLinks = activeAccount ? [
    { label: 'Profile', href: `https://github.com/${activeAccount.login}` },
    { label: 'Repositories', href: `https://github.com/${activeAccount.login}?tab=repositories` },
    { label: 'Issues', href: 'https://github.com/issues' },
    { label: 'Pull Requests', href: 'https://github.com/pulls' },
    { label: 'Developer Settings', href: 'https://github.com/settings/developers' },
  ] : [];
  const diagnosticsReadyCount = diagnostics.filter((item) => item.status === 'ready').length;

  useEffect(() => {
    try {
      localStorage.setItem('settings:github-expanded', expanded ? '1' : '0');
    } catch {
      // noop
    }
  }, [expanded]);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
        Checking GitHub connection...
      </div>
    );
  }

  const modernView = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 10, padding: 16 }}>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: 0,
              border: 'none',
              background: 'transparent',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            {activeAccount
              ? <GitHubAvatar avatarUrl={activeAccount.avatarUrl} login={activeAccount.login} size={40} />
              : <GitHubAvatar login="github" size={40} />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)' }}>GitHub</span>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px',
                  borderRadius: 999,
                  background: connected ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                  color: connected ? '#22c55e' : '#ef4444',
                  fontSize: 11,
                  fontWeight: 700,
                }}>
                  {connected && <CheckCircleIcon />}
                  {connected ? 'Connected' : 'Not Connected'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 4, lineHeight: 1.45 }}>
                {connected && activeAccount
                  ? `${activeAccount.login} • ${repoCount} repos • ${diagnosticsReadyCount}/${diagnostics.length} diagnostics ready`
                  : 'Source control, issues, pull requests, and local GitHub CLI auth'}
              </div>
            </div>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading || actionBusy === 'refresh'}
              style={{
                padding: '7px 12px',
                borderRadius: 8,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-panel)',
                color: 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: loading || actionBusy === 'refresh' ? 'default' : 'pointer',
                opacity: loading || actionBusy === 'refresh' ? 0.55 : 1,
              }}
            >
              {actionBusy === 'refresh' ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              style={{
                padding: '7px 12px',
                borderRadius: 8,
                border: '1px solid var(--t-panel-border)',
                background: expanded ? 'rgba(37, 99, 235, 0.06)' : 'var(--t-panel)',
                color: expanded ? '#2563eb' : 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
              }}
            >
              {expanded ? 'Minimize' : 'Expand'}
              <ChevronDownIcon rotated={expanded} />
            </button>
          </div>
        </div>

        {actionNote && (
          <div style={{
            margin: '0 16px 12px',
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(37, 99, 235, 0.06)',
            border: '1px solid rgba(37, 99, 235, 0.12)',
            color: 'var(--t-text-secondary)',
            fontSize: 12,
            lineHeight: 1.45,
          }}>
            {actionNote}
          </div>
        )}

        {!expanded && (
          <div style={{ padding: '0 16px 16px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {connected && activeAccount ? (
              <>
                <span style={{ padding: '4px 9px', borderRadius: 999, background: 'var(--t-bg-subtle)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600 }}>{activeAccount.login}</span>
                <span style={{ padding: '4px 9px', borderRadius: 999, background: 'var(--t-bg-subtle)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600 }}>{repoCount} repos</span>
                <span style={{
                  padding: '4px 9px',
                  borderRadius: 999,
                  background: diagnosticsReadyCount === diagnostics.length ? 'rgba(34, 197, 94, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                  color: diagnosticsReadyCount === diagnostics.length ? '#166534' : '#92400e',
                  fontSize: 11,
                  fontWeight: 700,
                }}>
                  {diagnosticsReadyCount}/{diagnostics.length} ready
                </span>
              </>
            ) : (
              <span style={{ padding: '4px 9px', borderRadius: 999, background: 'rgba(245, 158, 11, 0.08)', color: '#92400e', fontSize: 11, fontWeight: 600 }}>
                Expand to connect GitHub
              </span>
            )}
          </div>
        )}

        {expanded && (
          <div style={{
            padding: '0 16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            borderTop: '1px solid var(--t-divider-subtle)',
          }}>
            {activeAccount && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14 }}>
                <GitHubAvatar avatarUrl={activeAccount.avatarUrl} login={activeAccount.login} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)' }}>{activeAccount.login}</span>
                    {activeAccount.name && <span style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{activeAccount.name}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 3 }}>
                    Protocol: {activeAccount.protocol} · {activeAccount.scopes.length} scopes · {repoCount} repositories
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                    {activeAccount.scopes.map((s) => <ScopeBadge key={s} scope={s} />)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => activeAccount && onDisconnect?.(activeAccount.login)}
                  disabled={!activeAccount || actionBusy === 'logout'}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(239, 68, 68, 0.18)',
                    background: 'rgba(239, 68, 68, 0.04)',
                    color: '#b91c1c',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: !activeAccount || actionBusy === 'logout' ? 'default' : 'pointer',
                    opacity: !activeAccount || actionBusy === 'logout' ? 0.6 : 1,
                  }}
                >
                  {actionBusy === 'logout' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            )}

            {activeAccount && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {quickLinks.map((item) => (
                  <QuickLink key={item.label} href={item.href} label={item.label} />
                ))}
              </div>
            )}

            {activeAccount && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                {diagnostics.map((item) => (
                  <ScopeDiagnostic key={item.title} title={item.title} status={item.status} detail={item.detail} />
                ))}
              </div>
            )}

            {!connected && (
              <div style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.18)',
                color: 'var(--t-text-secondary)',
                fontSize: 12,
                lineHeight: 1.45,
              }}>
                Use the recommended device login below for the best local flow, or fall back to <code style={{ background: 'var(--t-divider-subtle)', padding: '1px 4px', borderRadius: 4 }}>gh auth login --web</code> in a terminal if you prefer the raw CLI path.
              </div>
            )}

            {broker && (
              <div style={{
                padding: 14,
                borderRadius: 12,
                background: 'var(--t-bg-subtle)',
                border: '1px solid var(--t-panel-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>GitHub App Broker</div>
                    <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 4, lineHeight: 1.45 }}>
                      {broker.note}
                    </div>
                  </div>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 9px',
                    borderRadius: 999,
                    background: broker.tokenReady ? 'rgba(34, 197, 94, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                    color: broker.tokenReady ? '#166534' : '#92400e',
                    fontSize: 11,
                    fontWeight: 700,
                  }}>
                    {broker.tokenReady ? 'Broker Ready' : 'Needs Config'}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                  <ScopeDiagnostic
                    title="App key"
                    status={broker.privateKeyConfigured ? 'ready' : 'missing'}
                    detail={broker.privateKeyConfigured ? `GitHub App ${broker.appId ?? 'unknown'} can sign installation token requests.` : 'Missing GitHub App private key.'}
                  />
                  <ScopeDiagnostic
                    title="Installation"
                    status={broker.installationReachable ? 'ready' : 'missing'}
                    detail={broker.installationReachable
                      ? `Installation ${broker.installationId ?? 'unknown'} is reachable for ${broker.probeRepo ?? 'the probe repo'}.`
                      : `Unable to reach an installation for ${broker.probeRepo ?? 'the configured repo scope'}.`}
                  />
                  <ScopeDiagnostic
                    title="Webhook secret"
                    status={broker.webhookSecretConfigured ? 'ready' : 'missing'}
                    detail={broker.webhookSecretConfigured ? 'Webhook signature verification can be enforced.' : 'Set GITHUB_APP_WEBHOOK_SECRET before enabling production webhooks.'}
                  />
                  <ScopeDiagnostic
                    title="Production URL"
                    status={broker.publicBaseUrlConfigured ? 'ready' : 'missing'}
                    detail={broker.publicBaseUrlConfigured
                      ? `Webhook target resolves to ${broker.webhookUrl ?? 'the configured public URL'}.`
                      : 'Set CORTEX_IDE_PUBLIC_BASE_URL once the production URL exists.'}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {broker.installationReachable && broker.installationAccount ? (
                    <a
                      href={`https://github.com/settings/installations/${broker.installationId ?? ''}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '7px 12px',
                        borderRadius: 8,
                        border: '1px solid var(--t-panel-border)',
                        background: 'var(--t-panel)',
                        color: 'var(--t-text-secondary)',
                        fontSize: 11,
                        fontWeight: 600,
                        textDecoration: 'none',
                      }}
                    >
                      Installation Settings
                    </a>
                  ) : null}
                  <a
                    href="https://github.com/settings/apps/cortex-dev-agent"
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '7px 12px',
                      borderRadius: 8,
                      border: '1px solid var(--t-panel-border)',
                      background: 'var(--t-panel)',
                      color: 'var(--t-text-secondary)',
                      fontSize: 11,
                      fontWeight: 600,
                      textDecoration: 'none',
                    }}
                  >
                    Open App Settings
                  </a>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
              <div style={{ padding: 14, borderRadius: 12, background: 'var(--t-bg-subtle)', border: '1px solid var(--t-panel-border)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)', marginBottom: 6 }}>Recommended: Device Login</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45, marginBottom: 10 }}>
                  Best fit for Cortex&apos;s local `gh` flow. Sign in through GitHub in your browser, then let this panel complete the local CLI login automatically.
                </div>
                {!deviceFlow && (
                  <>
                    <button
                      type="button"
                      onClick={onStartDeviceFlow}
                      disabled={!deviceFlowEnabled || actionBusy === 'login_device'}
                      style={{
                        padding: '8px 14px',
                        borderRadius: 8,
                        border: 'none',
                        background: !deviceFlowEnabled || actionBusy === 'login_device' ? 'var(--t-divider-subtle)' : 'var(--t-text)',
                        color: !deviceFlowEnabled || actionBusy === 'login_device' ? 'var(--t-text-faint)' : '#fff',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: !deviceFlowEnabled || actionBusy === 'login_device' ? 'default' : 'pointer',
                      }}
                    >
                      {actionBusy === 'login_device' ? 'Starting…' : 'Start Device Login'}
                    </button>
                    <div style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45, marginTop: 10 }}>
                      {deviceFlowEnabled
                        ? 'This opens a GitHub device code flow and finishes by feeding the returned token into the local GitHub CLI.'
                        : 'Requires `GITHUB_OAUTH_CLIENT_ID` plus device flow enabled on the GitHub OAuth app for this install.'}
                    </div>
                  </>
                )}
                {deviceFlow && (
                  <>
                    <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--t-panel)', border: '1px solid var(--t-panel-border)' }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Enter This Code</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t-text)', letterSpacing: '0.14em', fontFamily: '"SF Mono", Menlo, monospace' }}>
                        {deviceFlow.userCode}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 8, lineHeight: 1.45 }}>
                        {deviceFlow.note || 'Waiting for approval in GitHub…'} Expires in about {deviceFlow.expiresInMinutes} minute(s).
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <button type="button" onClick={() => window.open(deviceFlow.verificationUriComplete || deviceFlow.verificationUri, '_blank', 'noopener,noreferrer')} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        Open GitHub
                      </button>
                      <button type="button" onClick={() => { void copyDeviceCode(); }} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        {deviceCodeCopied ? 'Copied' : 'Copy Code'}
                      </button>
                      <button type="button" onClick={() => onPollDeviceFlow?.(deviceFlow.flowId)} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        Poll Now
                      </button>
                      <button
                        type="button"
                        onClick={() => onCancelDeviceFlow?.(deviceFlow.flowId)}
                        disabled={actionBusy === 'cancel_device'}
                        style={{
                          padding: '7px 12px',
                          borderRadius: 8,
                          border: '1px solid rgba(239, 68, 68, 0.18)',
                          background: 'rgba(239, 68, 68, 0.04)',
                          color: '#b91c1c',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: actionBusy === 'cancel_device' ? 'default' : 'pointer',
                          opacity: actionBusy === 'cancel_device' ? 0.6 : 1,
                        }}
                      >
                        {actionBusy === 'cancel_device' ? 'Cancelling…' : 'Cancel'}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: 'var(--t-bg-subtle)', border: '1px solid var(--t-panel-border)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)', marginBottom: 6 }}>Browser Login</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45, marginBottom: 10 }}>
                  This keeps auth local through the GitHub CLI. Run the web login command in your terminal, finish the browser flow, then refresh this panel.
                </div>
                <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--t-panel)', border: '1px solid var(--t-panel-border)', fontSize: 11, color: 'var(--t-text-secondary)', fontFamily: '"SF Mono", Menlo, monospace', lineHeight: 1.5, wordBreak: 'break-all' }}>
                  {browserLoginCommand}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" onClick={() => { void copyBrowserLoginCommand(); }} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                    {commandCopied ? 'Copied' : 'Copy Command'}
                  </button>
                </div>
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: 'var(--t-bg-subtle)', border: '1px solid var(--t-panel-border)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)', marginBottom: 6 }}>PAT Login</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45, marginBottom: 10 }}>
                  Paste a GitHub Personal Access Token and let <code style={{ background: 'var(--t-divider-subtle)', padding: '1px 4px', borderRadius: 4 }}>gh auth login --with-token</code> store it locally through the GitHub CLI.
                </div>
                <input
                  type="password"
                  value={patToken}
                  onChange={(event) => setPatToken(event.target.value)}
                  placeholder="ghp_... or github_pat_..."
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--t-panel-border)',
                    background: 'var(--t-panel)',
                    color: 'var(--t-text)',
                    fontSize: 12,
                    outline: 'none',
                    marginBottom: 10,
                  }}
                />
                <button
                  type="button"
                  onClick={() => onLoginWithToken?.(patToken)}
                  disabled={!patToken.trim() || actionBusy === 'login_token'}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    border: 'none',
                    background: !patToken.trim() || actionBusy === 'login_token' ? 'var(--t-divider-subtle)' : 'var(--t-text)',
                    color: !patToken.trim() || actionBusy === 'login_token' ? 'var(--t-text-faint)' : '#fff',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: !patToken.trim() || actionBusy === 'login_token' ? 'default' : 'pointer',
                  }}
                >
                  {actionBusy === 'login_token' ? 'Connecting…' : 'Connect with PAT'}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                type="button"
                onClick={() => setReposExpanded(v => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '12px 14px',
                  border: '1px solid var(--t-panel-border)',
                  borderRadius: 12,
                  background: 'var(--t-bg-subtle)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--t-text)',
                }}
              >
                <span>Repositories ({repoCount})</span>
                <ChevronDownIcon rotated={reposExpanded} />
              </button>
              {reposExpanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto', padding: '2px 2px 0' }}>
                  {repos.map((repo) => (
                    <a
                      key={repo.nameWithOwner}
                      href={`https://github.com/${repo.nameWithOwner}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '9px 10px',
                        borderRadius: 10,
                        border: '1px solid var(--t-panel-border)',
                        background: 'var(--t-panel)',
                        textDecoration: 'none',
                      }}
                    >
                      <div style={{ color: repo.isPrivate ? '#f59e0b' : '#22c55e' }}>
                        {repo.isPrivate ? <LockIcon /> : <GlobeIcon />}
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--t-text)', flex: 1 }}>
                        {repo.nameWithOwner}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
                        {repo.updatedAt}
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </div>

            {inactiveAccounts.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Other Accounts
                </div>
                {inactiveAccounts.map((account) => (
                  <div
                    key={account.login}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: 12,
                      borderRadius: 10,
                      background: 'var(--t-bg-subtle)',
                      border: '1px solid var(--t-panel-border)',
                    }}
                  >
                    <GitHubAvatar avatarUrl={account.avatarUrl} login={account.login} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>{account.login}</div>
                      <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2 }}>
                        {account.protocol} · {account.scopes.length} scopes
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        onClick={() => onSwitchAccount?.(account.login)}
                        disabled={actionBusy === 'switch'}
                        style={{
                          padding: '7px 12px',
                          borderRadius: 8,
                          border: '1px solid var(--t-panel-border)',
                          background: 'var(--t-panel)',
                          color: 'var(--t-text-secondary)',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: actionBusy === 'switch' ? 'default' : 'pointer',
                          opacity: actionBusy === 'switch' ? 0.55 : 1,
                        }}
                      >
                        {actionBusy === 'switch' ? 'Switching…' : 'Make Active'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDisconnect?.(account.login)}
                        disabled={actionBusy === 'logout'}
                        style={{
                          padding: '7px 12px',
                          borderRadius: 8,
                          border: '1px solid rgba(239, 68, 68, 0.18)',
                          background: 'rgba(239, 68, 68, 0.04)',
                          color: '#b91c1c',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: actionBusy === 'logout' ? 'default' : 'pointer',
                          opacity: actionBusy === 'logout' ? 0.55 : 1,
                        }}
                      >
                        {actionBusy === 'logout' ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return modernView;
}

// ── About / Connection Cards ──

function OpenClawConnectionCard() {
  const [status, setStatus] = useState<OpenClawGatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [integrationStatus, setIntegrationStatus] = useOpenClawBetaStatusState();
  const [modeBusy, setModeBusy] = useState<OpenClawIntegrationMode | null>(null);

  useEffect(() => {
    let active = true;

    void (async () => {
      const next = await fetchOpenClawGatewayStatus();
      if (!active) return;
      setStatus(next);
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, []);

  const connected = status?.connected ?? false;
  const gatewayUrl = status?.gatewayUrl || '127.0.0.1:18789';
  const modeLabel = status?.mode === 'tailscale' ? 'Tailscale' : 'Local';
  const effectiveEnabled = integrationStatus.effective_enabled;
  const selectorMode = integrationStatus.mode;
  const statusLabel = !effectiveEnabled ? 'Disabled' : connected ? 'Connected' : 'Disconnected';
  const envOverride = integrationStatus.source === 'env' || integrationStatus.from === 'env';

  const handleModeChange = useCallback(async (mode: OpenClawIntegrationMode) => {
    setModeBusy(mode);
    try {
      const next = await setOpenClawBetaMode(mode);
      setIntegrationStatus(next);
    } catch (error) {
      setIntegrationStatus((current) => ({
        ...current,
        error: error instanceof Error ? error.message : `Unable to set OpenClaw mode to ${mode}.`,
      }));
    } finally {
      setModeBusy(null);
    }
  }, [setIntegrationStatus]);

  return (
    <div style={{
      background: 'var(--t-panel)',
      borderRadius: 14,
      border: '1px solid var(--t-panel-border)',
      boxShadow: 'var(--t-panel-shadow)',
      padding: 18,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          display: 'grid',
          placeItems: 'center',
          background: connected ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
          fontSize: 20,
          flexShrink: 0,
        }}>
          🦞
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)' }}>OpenClaw Connector</span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              borderRadius: 999,
              background: 'rgba(245, 158, 11, 0.12)',
              color: '#b45309',
              fontSize: 11,
              fontWeight: 700,
            }}>
              Beta
            </span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              borderRadius: 999,
              background: !effectiveEnabled ? 'rgba(148, 163, 184, 0.14)' : connected ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
              color: !effectiveEnabled ? '#475569' : connected ? '#166534' : '#b91c1c',
              fontSize: 11,
              fontWeight: 700,
            }}>
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: !effectiveEnabled ? '#94a3b8' : connected ? '#22c55e' : '#ef4444',
                boxShadow: effectiveEnabled && connected ? '0 0 10px rgba(34, 197, 94, 0.35)' : 'none',
              }} />
              {statusLabel}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 4, lineHeight: 1.45 }}>
            {loading
              ? 'Checking gateway connection…'
              : !effectiveEnabled
                ? selectorMode === 'disabled'
                  ? 'Cortex integration gate is disabled. OpenClaw-dependent memory behavior is off.'
                  : 'Auto mode is currently not effective because OpenClaw is not configured.'
                : connected
                  ? `Version ${normalizeVersion(status?.version, 'unknown')} · ${modeLabel} mode`
                  : 'Gateway not reachable. Run `openclaw gateway start`.'}
          </div>
        </div>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: 4,
          borderRadius: 12,
          border: '1px solid var(--t-panel-border)',
          background: 'var(--t-panel-hover)',
          flexShrink: 0,
        }}>
          {([
            { mode: 'auto', label: 'Auto' },
            { mode: 'enabled', label: 'On' },
            { mode: 'disabled', label: 'Off' },
          ] as Array<{ mode: OpenClawIntegrationMode; label: string }>).map((option) => {
            const active = selectorMode === option.mode;
            const busy = modeBusy === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                onClick={() => { void handleModeChange(option.mode); }}
                disabled={busy}
                style={{
                  minWidth: 54,
                  padding: '7px 10px',
                  borderRadius: 9,
                  border: 'none',
                  background: active ? THEME_ACCENT_SOFT : 'transparent',
                  color: active ? THEME_ACCENT : 'var(--t-text-secondary)',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Loading OpenClaw gateway details…</div>
      ) : !effectiveEnabled ? (
        <div style={{
          padding: 12,
          borderRadius: 10,
          background: 'rgba(148, 163, 184, 0.08)',
          border: '1px solid rgba(148, 163, 184, 0.18)',
          color: 'var(--t-text-secondary)',
          fontSize: 12,
          lineHeight: 1.5,
        }}>
          OpenClaw is excluded from runtime inventory, session pickers, analytics, and agent surfaces while the Cortex gate is not effectively enabled.
          <div style={{ marginTop: 8, color: 'var(--t-text-muted)' }}>
            Gateway status: {connected ? `reachable at ${gatewayUrl}` : `not connected (${gatewayUrl})`}
          </div>
          <div style={{ marginTop: 6, color: 'var(--t-text-muted)' }}>
            Cortex mode: <strong>{selectorMode}</strong>{integrationStatus.source ? ` · source ${integrationStatus.source}` : ''}{integrationStatus.from ? ` · from ${integrationStatus.from}` : ''}
          </div>
        </div>
      ) : connected ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
        }}>
          {[
            { label: 'Version', value: normalizeVersion(status?.version) },
            { label: 'Gateway Mode', value: modeLabel },
            { label: 'Cortex Gate', value: selectorMode },
            { label: 'Gateway URL', value: gatewayUrl },
            { label: 'Effective Enabled', value: integrationStatus.effective_enabled ? 'Yes' : 'No' },
          ].map((item) => (
            <div key={item.label} style={{
              padding: 12,
              borderRadius: 10,
              background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
              border: '1px solid var(--t-panel-border)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>{item.value}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{
          padding: 12,
          borderRadius: 10,
          background: 'rgba(239, 68, 68, 0.04)',
          border: '1px solid rgba(239, 68, 68, 0.12)',
          color: 'var(--t-text-secondary)',
          fontSize: 12,
          lineHeight: 1.5,
        }}>
          Gateway not reachable. Run <code style={{ fontSize: 11, background: 'rgba(15, 23, 42, 0.06)', padding: '2px 5px', borderRadius: 4 }}>openclaw gateway start</code>.
          <div style={{ marginTop: 8, color: 'var(--t-text-muted)' }}>Expected endpoint: {gatewayUrl}</div>
        </div>
      )}

      {integrationStatus.error || envOverride ? (
        <div style={{
          padding: 12,
          borderRadius: 10,
          background: envOverride ? 'rgba(59, 130, 246, 0.08)' : 'rgba(239, 68, 68, 0.08)',
          border: envOverride ? '1px solid rgba(59, 130, 246, 0.16)' : '1px solid rgba(239, 68, 68, 0.18)',
          color: envOverride ? '#1d4ed8' : '#b91c1c',
          fontSize: 12,
          lineHeight: 1.5,
        }}>
          {integrationStatus.error
            ? integrationStatus.error
            : `OpenClaw mode is currently influenced by environment precedence (${integrationStatus.source ?? 'env'}${integrationStatus.from ? ` / ${integrationStatus.from}` : ''}).`}
        </div>
      ) : null}
    </div>
  );
}

function AboutTab() {
  const [gatewayStatus, setGatewayStatus] = useState<OpenClawGatewayStatus | null>(null);
  const [cortexVersion, setCortexVersion] = useState('');
  const [openClawBetaEnabled] = useOpenClawBetaEnabledState();
  const isProduction = process.env.NODE_ENV === 'production';
  const [platform] = useState(() => {
    if (typeof navigator !== 'undefined' && navigator.platform) return navigator.platform;
    return '—';
  });

  useEffect(() => {
    let active = true;

    void (async () => {
      const [gatewayResult, cortexResult] = await Promise.allSettled([
        openClawBetaEnabled ? fetchOpenClawGatewayStatus() : Promise.resolve<OpenClawGatewayStatus | null>(null),
        fetch('/api/v2/cortex/config'),
      ]);

      if (!active) return;

      if (gatewayResult.status === 'fulfilled') {
        setGatewayStatus(gatewayResult.value);
      }

      if (cortexResult.status === 'fulfilled' && cortexResult.value.ok) {
        try {
          const data = await cortexResult.value.json();
          if (active) {
            setCortexVersion(data.version || '');
          }
        } catch {
          // noop
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [openClawBetaEnabled]);

  const systemInfo = [
    { label: 'Platform', value: platform !== '—' ? platform : gatewayStatus?.platform || '—' },
    { label: 'Node.js', value: gatewayStatus?.nodeVersion ? normalizeVersion(gatewayStatus.nodeVersion) : '—' },
    { label: 'Cortex Memory', value: cortexVersion ? normalizeVersion(cortexVersion) : '—' },
  ];
  if (openClawBetaEnabled) {
    systemInfo.splice(2, 0, {
      label: 'OpenClaw',
      value: gatewayStatus?.connected ? normalizeVersion(gatewayStatus.version) : 'Not connected',
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
        padding: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <h3 style={{ fontSize: 22, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>Cortex IDE</h3>
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            padding: '4px 9px',
            borderRadius: 999,
            background: 'rgba(37, 99, 235, 0.08)',
            color: '#2563eb',
          }}>
            {normalizeVersion(packageJson.version)}
          </span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--t-text-secondary)', margin: '0 0 18px', lineHeight: 1.5 }}>
          Built with Next.js + Tauri · Powered by Cortex Memory
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
        }}>
          {systemInfo.map((item) => (
            <div key={item.label} style={{
              padding: 14,
              borderRadius: 12,
              background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
              border: '1px solid var(--t-panel-border)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginBottom: 6 }}>{item.label}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
        padding: 24,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', marginBottom: 6 }}>Links</div>
        <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
          Project resources and release surfaces.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {[
            { label: 'GitHub', href: 'https://github.com/hurttlocker/cortex-ide' },
            { label: 'Docs', href: 'https://github.com/hurttlocker/cortex-ide/tree/main/docs' },
            { label: 'Releases', href: 'https://github.com/hurttlocker/cortex-ide/releases/latest' },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                color: 'var(--t-text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>

      {!isProduction && (
        <div style={{
          background: 'var(--t-panel)',
          borderRadius: 14,
          border: '1px dashed rgba(239, 68, 68, 0.3)',
          padding: 24,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', marginBottom: 4 }}>Developer Tools</div>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted)', margin: '0 0 14px' }}>Visible only in non-production builds.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              onClick={async () => {
                await fetch('/api/setup/config', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ setupComplete: false, completedAt: null }),
                });
                window.location.href = '/dashboard';
              }}
              style={{
                padding: '8px 14px', borderRadius: 10,
                border: '1px solid rgba(37, 99, 235, 0.3)',
                background: 'rgba(37, 99, 235, 0.06)',
                color: '#2563eb', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              ▸ Run Setup Wizard
            </button>
            <button
              type="button"
              onClick={async () => {
                const res = await fetch('/api/setup/detect');
                const data = await res.json();
                alert(JSON.stringify(data, null, 2));
              }}
              style={{
                padding: '8px 14px', borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                color: 'var(--t-text)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              }}
            >
              ▸ View Detection
            </button>
            <button
              type="button"
              onClick={async () => {
                const res = await fetch('/api/cortex/seed/status');
                const data = await res.json();
                alert(JSON.stringify(data, null, 2));
              }}
              style={{
                padding: '8px 14px', borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                color: 'var(--t-text)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              }}
            >
              ▸ Seed Status
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Agent Types ──

interface FleetAgent {
  id: string;
  name: string;
  squadId: string;
  runtime: string;
  model: string;
  primaryModel?: string;
  heartbeatModel?: string;
  status: string;
  currentTask?: string;
  context?: { usedPercent: number; trend: string };
  heartbeatInterval?: number;
  sessionKey?: string;
}

interface FleetSquad {
  id: string;
  name: string;
  status: string;
  throughputLabel: string;
  liveSessions: number;
  members: string[];
}

// ── Status Dot ──

function StatusDot({ status }: { status: string }) {
  const color = status === 'running' ? '#22c55e'
    : status === 'reviewing' ? '#3b82f6'
    : status === 'idle' ? '#9ca3af'
    : status === 'error' ? '#ef4444'
    : '#f59e0b';
  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: 4,
      background: color,
      flexShrink: 0,
    }} />
  );
}

// ── Context Bar ──

function ContextBar({ percent, trend }: { percent: number; trend: string }) {
  const barColor = percent > 70 ? '#ef4444' : percent > 50 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{
        flex: 1,
        height: 6,
        borderRadius: 3,
        background: 'var(--t-divider)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${percent}%`,
          height: '100%',
          borderRadius: 3,
          background: barColor,
          transition: 'width 300ms ease',
        }} />
      </div>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-secondary)', minWidth: 32, textAlign: 'right' }}>
        {percent}%
      </span>
      {trend === 'rising' && (
        <span style={{ fontSize: 9, color: '#f59e0b' }}>↑</span>
      )}
    </div>
  );
}

// ── Agent Card ──

function AgentCard({ agent, isOpenClaw, onEdit, onKill, killing }: {
  agent: FleetAgent;
  isOpenClaw: boolean;
  onEdit?: (agent: FleetAgent) => void;
  onKill?: (agent: FleetAgent) => void;
  killing?: boolean;
}) {
  const shortModel = formatModelLabel(agent.model);

  const shortName = agent.name
    .replace('OpenClaw ', '')
    .replace(' session', '')
    .replace('This chat', 'Main Chat');

  const shortId = agent.id.split(':').slice(-1)[0]?.slice(0, 12) || agent.id;

  // Derive heartbeat from agent ID (gateway config doesn't expose via API yet)
  const heartbeatLabel = agent.id.startsWith('agent:main:') ? '2h'
    : agent.id.startsWith('agent:hawk:') ? '3h'
    : agent.id.startsWith('agent:ace:') ? '4h'
    : null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '14px 16px',
      borderRadius: 12,
      background: 'var(--t-panel)',
      border: '1px solid var(--t-panel-border)',
      boxShadow: 'var(--t-panel-shadow)',
      transition: 'box-shadow 120ms',
    }}>
      {/* Status + Icon */}
      <div style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        display: 'grid',
        placeItems: 'center',
        background: isOpenClaw ? 'rgba(37, 99, 235, 0.06)' : 'var(--t-hover)',
        color: isOpenClaw ? '#2563eb' : 'var(--t-text-secondary)',
        fontSize: 14,
        fontWeight: 700,
        flexShrink: 0,
      }}>
        {agent.runtime === 'openclaw' ? '🏴' : agent.runtime === 'codex' ? '⌨️' : '🤖'}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <StatusDot status={agent.status} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>{shortName}</span>
          <span style={{
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 7px',
            borderRadius: 5,
            background: agent.status === 'running' ? 'rgba(34, 197, 94, 0.08)' : 'var(--t-divider-subtle)',
            color: agent.status === 'running' ? '#22c55e' : 'var(--t-text-muted)',
          }}>
            {agent.status}
          </span>
        </div>
        {agent.primaryModel || agent.heartbeatModel ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t-text-faint)', minWidth: 58 }}>Primary</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>{formatModelLabel(agent.primaryModel || agent.model)}</span>
            </div>
            {agent.heartbeatModel && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t-text-faint)', minWidth: 58 }}>Heartbeat</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{formatModelLabel(agent.heartbeatModel)}</span>
                {heartbeatLabel && (
                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'var(--t-divider-subtle)', color: 'var(--t-text-muted)' }}>every {heartbeatLabel}</span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>
            <span style={{ fontWeight: 600, color: 'var(--t-text-secondary)' }}>{shortModel}</span>
            <span>·</span>
            <span style={{ fontFamily: '"SF Mono", monospace', fontSize: 10 }}>{shortId}</span>
          </div>
        )}
      </div>

      {/* Context bar */}
      {agent.context && (
        <div style={{ width: 140 }}>
          <ContextBar percent={agent.context.usedPercent} trend={agent.context.trend} />
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {isOpenClaw && onEdit && (
          <button
            type="button"
            onClick={() => onEdit(agent)}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel)',
              color: 'var(--t-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background 120ms',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--t-panel)'; }}
          >
            Configure
          </button>
        )}
        {!isOpenClaw && onKill && (
          <button
            type="button"
            onClick={() => onKill(agent)}
            disabled={killing}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: killing ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid rgba(239, 68, 68, 0.2)',
              background: killing ? 'rgba(239, 68, 68, 0.08)' : 'var(--t-panel)',
              color: '#ef4444',
              fontSize: 11,
              fontWeight: 600,
              cursor: killing ? 'wait' : 'pointer',
              transition: 'all 120ms',
              opacity: killing ? 0.7 : 1,
            }}
            onMouseEnter={(e) => {
              if (!killing) {
                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.4)';
              }
            }}
            onMouseLeave={(e) => {
              if (!killing) {
                e.currentTarget.style.background = 'var(--t-panel)';
                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.2)';
              }
            }}
          >
            {killing ? 'Killing…' : 'Kill'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Edit Modal ──

function AgentEditModal({ agent, onClose, onSave }: {
  agent: FleetAgent;
  onClose: () => void;
  onSave: (agentId: string, changes: { model?: string }) => void;
}) {
  const [model, setModel] = useState(agent.model);
  const [saving, setSaving] = useState(false);

  const modelOptions = [
    { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'anthropic/claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { value: 'openai-codex/gpt-5.4', label: 'Codex 5.4' },
    { value: 'openai-codex/gpt-5.3-codex', label: 'Codex 5.3' },
    { value: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { value: 'google/gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ];

  const handleSave = async () => {
    setSaving(true);
    onSave(agent.id, { model });
    setSaving(false);
    onClose();
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      display: 'grid',
      placeItems: 'center',
      background: 'rgba(0,0,0,0.3)',
      backdropFilter: 'blur(8px)',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 18,
        padding: 28,
        width: 420,
        maxWidth: '90vw',
        boxShadow: 'var(--t-panel-shadow)',
      }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--t-text)', margin: '0 0 4px' }}>
          Configure Agent
        </h3>
        <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '0 0 20px' }}>
          {agent.id}
        </p>

        {/* Model selector */}
        <label style={{ display: 'block', marginBottom: 16 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', display: 'block', marginBottom: 6 }}>
            Model
          </span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-input-border)',
              background: 'var(--t-panel)',
              fontSize: 13,
              color: 'var(--t-text)',
              cursor: 'pointer',
              appearance: 'none',
              WebkitAppearance: 'none',
            }}
          >
            {modelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
            {/* Include current model if not in list */}
            {!modelOptions.find(o => o.value === agent.model) && (
              <option value={agent.model}>{agent.model} (current)</option>
            )}
          </select>
        </label>

        {/* Read-only configured models */}
        {(agent.primaryModel || agent.heartbeatModel) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {agent.primaryModel && (
              <div>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)', display: 'block', marginBottom: 4 }}>
                  Primary Model
                </span>
                <div style={{
                  padding: '8px 12px', borderRadius: 10,
                  background: 'var(--t-hover)', border: '1px solid var(--t-panel-border)',
                  fontSize: 13, color: 'var(--t-text-muted)',
                }}>{formatModelLabel(agent.primaryModel)}</div>
              </div>
            )}
            {agent.heartbeatModel && (
              <div>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)', display: 'block', marginBottom: 4 }}>
                  Heartbeat Model
                </span>
                <div style={{
                  padding: '8px 12px', borderRadius: 10,
                  background: 'var(--t-hover)', border: '1px solid var(--t-panel-border)',
                  fontSize: 13, color: 'var(--t-text-muted)',
                }}>{formatModelLabel(agent.heartbeatModel)}</div>
              </div>
            )}
            <p style={{ fontSize: 10, color: 'var(--t-text-faint)', margin: 0 }}>
              Configured via openclaw.json
            </p>
          </div>
        )}

        {/* Info */}
        <div style={{
          padding: 12,
          borderRadius: 10,
          background: 'rgba(37, 99, 235, 0.04)',
          border: '1px solid rgba(37, 99, 235, 0.08)',
          fontSize: 11,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.5,
          marginBottom: 20,
        }}>
          Model changes take effect on the next session or after a restart.
          This uses the OpenClaw <code style={{ background: 'var(--t-divider-subtle)', padding: '1px 4px', borderRadius: 3 }}>session_status</code> model override.
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{
            padding: '8px 16px', borderRadius: 10, border: '1px solid var(--t-btn-secondary-border)',
            background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || model === agent.model}
            style={{
              padding: '8px 20px', borderRadius: 10, border: 'none',
              background: model !== agent.model ? '#2563eb' : '#d1d5db',
              color: '#fff', fontSize: 12, fontWeight: 600, cursor: model !== agent.model ? 'pointer' : 'default',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Agents Tab ──

function AgentsTab() {
  const [squads, setSquads] = useState<FleetSquad[]>([]);
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState<FleetAgent | null>(null);
  const [openClawBetaEnabled] = useOpenClawBetaEnabledState();
  const [orchestratorRuntime, setOrchestratorRuntime] = useState<OrchestratorRuntime>(() => readOrchestratorRuntimePreference());

  const fetchFleet = useCallback(async () => {
    try {
      const res = await fetch(appendOpenClawBetaQuery('/api/openclaw/fleet', openClawBetaEnabled));
      if (!res.ok) return;
      const data = await res.json();
      setSquads(data.squads || []);
      setAgents(data.agents || []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [openClawBetaEnabled]);

  useEffect(() => { fetchFleet(); }, [fetchFleet]);
  useEffect(() => { setLoading(true); }, [openClawBetaEnabled]);
  useEffect(() => subscribeOrchestratorRuntimePreference(setOrchestratorRuntime), []);

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(fetchFleet, 30000);
    return () => clearInterval(timer);
  }, [fetchFleet]);

  useEffect(() => {
    if (!openClawBetaEnabled && editingAgent?.runtime === 'openclaw') {
      setEditingAgent(null);
    }
  }, [editingAgent, openClawBetaEnabled]);

  const handleSave = useCallback(async (agentId: string, changes: { model?: string }) => {
    if (!changes.model) return;
    try {
      const sessionKey = agentId;
      await fetch('/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKey,
          action: 'session_status',
          model: changes.model,
        }),
      });
      setTimeout(fetchFleet, 1000);
    } catch { /* silent */ }
  }, [fetchFleet]);

  const [killingId, setKillingId] = useState<string | null>(null);

  const handleKill = useCallback(async (agent: FleetAgent) => {
    setKillingId(agent.id);
    try {
      const res = await fetch('/api/openclaw/kill-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKey: agent.sessionKey || agent.id,
        }),
      });
      const result = await res.json();
      if (result.success) {
        // Instant removal — don't wait for re-fetch
        setAgents(prev => prev.filter(a => a.id !== agent.id));
      }
      // Re-fetch after process has time to die (500ms), then again at 2s for confirmation
      setTimeout(fetchFleet, 500);
      setTimeout(fetchFleet, 2000);
    } catch { /* silent */ }
    finally { setTimeout(() => setKillingId(null), 500); }
  }, [fetchFleet]);

  const handleOrchestratorRuntimeChange = useCallback((runtime: OrchestratorRuntime) => {
    setOrchestratorRuntime(runtime);
    writeOrchestratorRuntimePreference(runtime);
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading agent fleet...
      </div>
    );
  }

  // Group agents by squad
  const squadMap = new Map(squads.map(s => [s.id, s]));
  const grouped = new Map<string, FleetAgent[]>();
  for (const agent of agents) {
    const key = agent.squadId || 'ungrouped';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(agent);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 20,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Orchestrator Runtime
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            `Cmd+J` mission control defaults new packets and live interventions to this CLI runtime. OpenClaw is excluded from Thoughts orchestration.
          </p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          {([
            { id: 'codex' as const, label: 'Codex', detail: 'Default planner runtime for packet launches and intervention lanes.' },
            { id: 'claude-code' as const, label: 'Claude Code', detail: 'Use Claude Code as the default orchestrator lane when Thoughts opens new work.' },
          ]).map((option) => {
            const active = orchestratorRuntime === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => handleOrchestratorRuntimeChange(option.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: '14px 15px',
                  borderRadius: 12,
                  border: active ? `1.5px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
                  background: active ? THEME_ACCENT_SOFT : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                  cursor: 'pointer',
                  textAlign: 'left',
                  boxShadow: active ? `0 10px 24px ${THEME_ACCENT_RING}` : 'none',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                  {option.label}
                </span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>
                  {option.detail}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {!openClawBetaEnabled && (
        <div style={{
          padding: '12px 14px',
          borderRadius: 12,
          background: 'rgba(148, 163, 184, 0.08)',
          border: '1px solid rgba(148, 163, 184, 0.18)',
          color: 'var(--t-text-secondary)',
          fontSize: 12,
          lineHeight: 1.5,
        }}>
          OpenClaw beta is off. This tab is showing Codex and Claude Code agents only.
        </div>
      )}

      {/* Summary bar */}
      <div style={{
        display: 'flex',
        gap: 16,
        padding: '14px 20px',
        borderRadius: 14,
        background: 'var(--t-panel)',
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t-text)' }}>{agents.length}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Agents</div>
        </div>
        <div style={{ width: 1, background: 'var(--t-divider)' }} />
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#22c55e' }}>
            {agents.filter(a => a.status === 'running').length}
          </div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Running</div>
        </div>
        <div style={{ width: 1, background: 'var(--t-divider)' }} />
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#3b82f6' }}>{squads.length}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Squads</div>
        </div>
        {openClawBetaEnabled && (
          <>
            <div style={{ width: 1, background: 'var(--t-divider)' }} />
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#f59e0b' }}>
                {agents.filter(a => a.runtime === 'openclaw').length}
              </div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>OpenClaw</div>
            </div>
          </>
        )}
      </div>

      {/* Agent groups */}
      {Array.from(grouped.entries()).map(([squadId, members]) => {
        const squad = squadMap.get(squadId);
        return (
          <div key={squadId}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 10,
              paddingLeft: 4,
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                {squad?.name || squadId}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)',
                padding: '1px 8px', borderRadius: 5,
                background: 'var(--t-divider-subtle)',
              }}>
                {members.length}
              </span>
              {squad && (
                <span style={{ fontSize: 10, color: 'var(--t-text-faint)', marginLeft: 'auto' }}>
                  {squad.throughputLabel}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {members.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isOpenClaw={agent.runtime === 'openclaw'}
                  onEdit={agent.runtime === 'openclaw' ? setEditingAgent : undefined}
                  onKill={agent.runtime !== 'openclaw' ? handleKill : undefined}
                  killing={killingId === agent.id}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Edit modal */}
      {editingAgent && (
        <AgentEditModal
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

// ── Theme Preview Card ──

function ThemePreviewCard({ theme, active, onSelect }: {
  theme: import('@/lib/theme/themes').ThemeTokens;
  active: boolean;
  onSelect: () => void;
}) {
  const p = theme.preview;

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        position: 'relative',
        width: 200,
        padding: 0,
        border: active ? `2px solid ${THEME_ACCENT}` : '2px solid var(--t-panel-border)',
        borderRadius: 16,
        background: 'var(--t-panel-translucent)',
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'border-color 200ms, box-shadow 200ms, transform 200ms',
        boxShadow: active ? `0 0 0 3px ${THEME_ACCENT_RING}` : 'var(--t-panel-shadow)',
      }}
    >
      {/* Mini dashboard preview */}
      <div style={{
        height: 120,
        background: p.bg,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        {/* Title bar */}
        <div style={{
          height: 10,
          borderRadius: 3,
          background: p.titlebar,
          display: 'flex',
          alignItems: 'center',
          padding: '0 4px',
          gap: 2,
        }}>
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#ef4444', opacity: 0.7 }} />
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#f59e0b', opacity: 0.7 }} />
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#22c55e', opacity: 0.7 }} />
        </div>
        {/* Body */}
        <div style={{ flex: 1, display: 'flex', gap: 3 }}>
          {/* Nav rail */}
          <div style={{
            width: 14,
            borderRadius: 3,
            background: p.nav,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '4px 0',
            gap: 3,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: 2, background: p.accent, opacity: 0.6 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
          </div>
          {/* Left panel */}
          <div style={{
            width: 44,
            borderRadius: 3,
            background: p.panel,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}>
            <div style={{ height: 4, width: '70%', borderRadius: 1, background: p.text, opacity: 0.3 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.6 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.4 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.3 }} />
          </div>
          {/* Center workspace */}
          <div style={{
            flex: 1,
            borderRadius: 3,
            background: p.bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div style={{ width: 16, height: 16, borderRadius: 3, border: `1px solid ${p.textMuted}40`, opacity: 0.3 }} />
          </div>
          {/* Right panel (chat) */}
          <div style={{
            width: 44,
            borderRadius: 3,
            background: p.panel,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            gap: 3,
          }}>
            <div style={{ height: 6, width: '80%', borderRadius: 2, background: p.accent, opacity: 0.25, alignSelf: 'flex-end' }} />
            <div style={{ height: 8, width: '60%', borderRadius: 2, background: p.textMuted, opacity: 0.15 }} />
            <div style={{ height: 10, borderRadius: 3, background: p.bg, opacity: 0.5 }} />
          </div>
        </div>
      </div>

      {/* Label */}
      <div style={{
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div>
          <div style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--t-text)',
            textAlign: 'left',
          }}>
            {theme.name}
          </div>
          <div style={{
            fontSize: 11,
            color: 'var(--t-text-muted)',
            textAlign: 'left',
            marginTop: 1,
          }}>
            {theme.description}
          </div>
        </div>
        {active && (
          <div style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            background: THEME_ACCENT,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        )}
      </div>
    </button>
  );
}

// ── Appearance Tab ──

// ── API Keys Tab ──

interface ProviderKeyInfo {
  id: string;
  label: string;
  envVar: string;
  placeholder: string;
  docsUrl: string;
  configured: boolean;
  maskedKey: string | null;
}

function APIKeysTab() {
  const [providers, setProviders] = useState<ProviderKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ provider: string; type: 'success' | 'error'; message: string } | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/keys');
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const res = await fetch('/api/v2/keys');
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          if (active) setProviders(data.providers);
        }
      } catch {
        // ignore
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const handleSave = useCallback(async (providerId: string) => {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/v2/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, key: keyInput.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeedback({ provider: providerId, type: 'success', message: 'Key saved — active immediately' });
        setEditingProvider(null);
        setKeyInput('');
        void loadKeys();
      } else {
        setFeedback({ provider: providerId, type: 'error', message: data.error || 'Failed to save' });
      }
    } catch {
      setFeedback({ provider: providerId, type: 'error', message: 'Network error' });
    }
    setSaving(false);
    setTimeout(() => setFeedback(null), 4000);
  }, [keyInput, loadKeys]);

  const handleRemove = useCallback(async (providerId: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/v2/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (res.ok) {
        setFeedback({ provider: providerId, type: 'success', message: 'Key removed' });
        void loadKeys();
      }
    } catch { /* ignore */ }
    setSaving(false);
    setTimeout(() => setFeedback(null), 4000);
  }, [loadKeys]);

  if (loading) {
    return (
      <div style={{ paddingTop: 32, paddingLeft: 32, paddingRight: 32, color: '#94a3b8', fontSize: 13 }}>
        Loading API keys...
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 32, paddingLeft: 32, paddingRight: 32, paddingBottom: 32, maxWidth: 640 }}>
      <div style={{ fontSize: 20, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
        API Keys
      </div>
      <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 24, lineHeight: '1.5' }}>
        Add your API keys to use models in the Chat panel. Keys are stored locally and never leave your machine.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {providers.map((p) => {
          const isEditing = editingProvider === p.id;
          const fb = feedback?.provider === p.id ? feedback : null;

          return (
            <div
              key={p.id}
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                paddingTop: 16,
                paddingBottom: 16,
                paddingLeft: 20,
                paddingRight: 20,
                background: '#fafafa',
                transition: 'border-color 150ms',
              }}
            >
              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: isEditing ? 12 : 0 }}>
                <div style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: p.configured ? '#ecfdf5' : '#f8fafc',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {p.configured ? (
                    <CheckCircleIcon />
                  ) : (
                    <KeyIcon />
                  )}
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: '#0f172a' }}>{p.label}</div>
                  {p.configured && p.maskedKey && !isEditing && (
                    <div style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>
                      {p.maskedKey}
                    </div>
                  )}
                  {!p.configured && !isEditing && (
                    <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 2 }}>Not configured</div>
                  )}
                </div>

                {/* Action buttons */}
                {!isEditing && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => { setEditingProvider(p.id); setKeyInput(''); }}
                      style={{
                        paddingTop: 6,
                        paddingBottom: 6,
                        paddingLeft: 12,
                        paddingRight: 12,
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                        background: 'white',
                        color: '#3b82f6',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: 'pointer',
                        fontFamily: '-apple-system, system-ui, sans-serif',
                        transition: 'background 100ms',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget).style.background = '#f8fafc'; }}
                      onMouseLeave={(e) => { (e.currentTarget).style.background = 'white'; }}
                    >
                      {p.configured ? 'Update' : 'Add Key'}
                    </button>
                    {p.configured && (
                      <button
                        type="button"
                        onClick={() => { void handleRemove(p.id); }}
                        disabled={saving}
                        style={{
                          paddingTop: 6,
                          paddingBottom: 6,
                          paddingLeft: 12,
                          paddingRight: 12,
                          border: '1px solid #fecaca',
                          borderRadius: 8,
                          background: 'white',
                          color: '#ef4444',
                          fontSize: 12,
                          fontWeight: 500,
                          cursor: 'pointer',
                          fontFamily: '-apple-system, system-ui, sans-serif',
                          transition: 'background 100ms',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget).style.background = '#fef2f2'; }}
                        onMouseLeave={(e) => { (e.currentTarget).style.background = 'white'; }}
                      >
                        Remove
                      </button>
                    )}
                    <a
                      href={p.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        paddingTop: 6,
                        paddingBottom: 6,
                        paddingLeft: 10,
                        paddingRight: 10,
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                        background: 'white',
                        color: '#94a3b8',
                        fontSize: 12,
                        textDecoration: 'none',
                        cursor: 'pointer',
                        transition: 'background 100ms',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget).style.background = '#f8fafc'; }}
                      onMouseLeave={(e) => { (e.currentTarget).style.background = 'white'; }}
                    >
                      Get key ↗
                    </a>
                  </div>
                )}
              </div>

              {/* Editing input */}
              {isEditing && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(p.id); if (e.key === 'Escape') setEditingProvider(null); }}
                    placeholder={p.placeholder}
                    autoFocus
                    style={{
                      flex: 1,
                      paddingTop: 8,
                      paddingBottom: 8,
                      paddingLeft: 12,
                      paddingRight: 12,
                      border: '1px solid #cbd5e1',
                      borderRadius: 8,
                      background: 'white',
                      fontSize: 13,
                      fontFamily: 'ui-monospace, monospace',
                      color: '#0f172a',
                      outline: 'none',
                    }}
                    onFocus={(e) => { (e.currentTarget).style.borderColor = '#3b82f6'; (e.currentTarget).style.boxShadow = '0 0 0 3px rgba(59,130,246,0.1)'; }}
                    onBlur={(e) => { (e.currentTarget).style.borderColor = '#cbd5e1'; (e.currentTarget).style.boxShadow = 'none'; }}
                  />
                  <button
                    type="button"
                    onClick={() => { void handleSave(p.id); }}
                    disabled={!keyInput.trim() || saving}
                    style={{
                      paddingTop: 8,
                      paddingBottom: 8,
                      paddingLeft: 16,
                      paddingRight: 16,
                      border: 'none',
                      borderRadius: 8,
                      background: keyInput.trim() ? '#3b82f6' : '#e2e8f0',
                      color: keyInput.trim() ? 'white' : '#94a3b8',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: keyInput.trim() ? 'pointer' : 'default',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                      transition: 'background 150ms',
                    }}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingProvider(null); setKeyInput(''); }}
                    style={{
                      paddingTop: 8,
                      paddingBottom: 8,
                      paddingLeft: 12,
                      paddingRight: 12,
                      border: '1px solid #e2e8f0',
                      borderRadius: 8,
                      background: 'white',
                      color: '#64748b',
                      fontSize: 13,
                      cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Feedback */}
              {fb && (
                <div style={{
                  marginTop: 8,
                  paddingTop: 6,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 6,
                  background: fb.type === 'success' ? '#ecfdf5' : '#fef2f2',
                  color: fb.type === 'success' ? '#059669' : '#dc2626',
                  fontSize: 12,
                  fontWeight: 500,
                }}>
                  {fb.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{
        marginTop: 24,
        paddingTop: 16,
        borderTop: '1px solid #f1f5f9',
        fontSize: 12,
        color: '#cbd5e1',
        lineHeight: '1.5',
      }}>
        Keys are written to <code style={{ background: '#f8fafc', paddingTop: 2, paddingBottom: 2, paddingLeft: 4, paddingRight: 4, borderRadius: 4, fontSize: 11 }}>.env.local</code> and take effect immediately — no restart needed.
        In the cloud version, keys will be encrypted and stored in your account.
      </div>
    </div>
  );
}

// ── Cortex Memory Tab ──

interface CortexConfig {
  embedModel: string;
  enrichModel: string;
  classifyModel: string;
  expandModel: string;
  llmProvider: string;
  llmApiKey: string;
  llmApiKeySet: boolean;
  configPath: string;
  dbPath: string;
  sourceBoostCount: number;
  recallEnabled?: boolean;
  recallMaxResults?: number;
  recallTokenBudget?: number;
  recallMinConfidence?: number;
}

interface CortexStats {
  memories: number;
  facts: number;
  sources: number;
  storageMb: string;
  avgConfidence: string;
  embeddings: number;
  embedCoverage: string;
  factsByType: Record<string, number>;
  confidenceDistribution: Record<string, number>;
  growth: Record<string, number>;
}

interface ConflictFact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  lastSeen?: string;
  factType?: string;
}

interface ConflictPair {
  factA: ConflictFact;
  factB: ConflictFact;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readConflictString(record: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function readConflictNumber(record: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;

    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function normalizeNestedConflictFact(value: unknown): ConflictFact | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = readConflictNumber(record, ['ID', 'id']);
  const subject = readConflictString(record, ['Subject', 'subject']);
  const predicate = readConflictString(record, ['Predicate', 'predicate']);
  const object = readConflictString(record, ['Object', 'object']);

  if (!id || !subject || !predicate || !object) return null;

  return {
    id,
    subject,
    predicate,
    object,
    confidence: readConflictNumber(record, ['Confidence', 'confidence'], 0),
    source: readConflictString(record, ['Source', 'source', 'SourceQuote', 'sourceQuote'], 'unknown'),
    lastSeen: readConflictString(record, ['LastReinforced', 'lastSeen', 'last_seen', 'CreatedAt', 'created_at']) || undefined,
    factType: readConflictString(record, ['FactType', 'factType', 'fact_type']) || undefined,
  };
}

function normalizeFlatConflictFact(record: Record<string, unknown>, prefix: 'fact_a' | 'fact_b'): ConflictFact | null {
  const id = readConflictNumber(record, [`${prefix}_id`, `${prefix}Id`]);
  const subject = readConflictString(record, [`${prefix}_subject`, `${prefix}Subject`]);
  const predicate = readConflictString(record, [`${prefix}_predicate`, `${prefix}Predicate`]);
  const object = readConflictString(record, [`${prefix}_object`, `${prefix}Object`]);

  if (!id || !subject || !predicate || !object) return null;

  return {
    id,
    subject,
    predicate,
    object,
    confidence: readConflictNumber(record, [`${prefix}_confidence`, `${prefix}Confidence`], 0),
    source: readConflictString(record, [`${prefix}_source`, `${prefix}_source_quote`, `${prefix}Source`, `${prefix}SourceQuote`], 'unknown'),
    lastSeen: readConflictString(record, [`${prefix}_last_seen`, `${prefix}_last_reinforced`, `${prefix}LastSeen`, `${prefix}LastReinforced`, `${prefix}_created_at`]) || undefined,
    factType: readConflictString(record, [`${prefix}_fact_type`, `${prefix}FactType`]) || undefined,
  };
}

function parseConflictPairs(result: unknown): ConflictPair[] {
  if (!Array.isArray(result)) return [];

  return result.flatMap((entry): ConflictPair[] => {
    const record = asRecord(entry);
    if (!record) return [];

    const factA =
      normalizeNestedConflictFact(record['fact1']) ??
      normalizeNestedConflictFact(record['factA']) ??
      normalizeFlatConflictFact(record, 'fact_a');

    const factB =
      normalizeNestedConflictFact(record['fact2']) ??
      normalizeNestedConflictFact(record['factB']) ??
      normalizeFlatConflictFact(record, 'fact_b');

    return factA && factB ? [{ factA, factB }] : [];
  });
}

function formatConflictDate(value?: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      paddingRight: 16,
      background: 'var(--t-bg-card, #f8fafc)',
      borderRadius: 12,
      border: '1px solid var(--t-border, #e2e8f0)',
    }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--t-text, #0f172a)', letterSpacing: '-0.02em' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--t-text-muted, #94a3b8)', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function CortexMemoryTab() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<CortexConfig | null>(null);
  const [stats, setStats] = useState<CortexStats | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [healthy, setHealthy] = useState(false);
  const [doctorSummary, setDoctorSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictPair[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [resolving, setResolving] = useState<number | null>(null);
  const [conflictsChecked, setConflictsChecked] = useState(false);
  const [conflictError, setConflictError] = useState('');
  const [conflictToast, setConflictToast] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/cortex/config');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setConfig(data.config || null);
      setStats(data.stats || null);
      setOllamaModels(data.ollamaModels || []);
      setVersion(data.version || 'unknown');
      setHealthy(data.healthy ?? false);
      setDoctorSummary(data.doctorSummary || '');
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const saveConfig = useCallback(async (updates: Partial<CortexConfig>) => {
    setSaving(true);
    setSaveNote('');
    try {
      const res = await fetch('/api/v2/cortex/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveNote('Saved');
      setTimeout(() => setSaveNote(''), 2000);
      void loadConfig();
    } catch {
      setSaveNote('Error saving');
    } finally {
      setSaving(false);
    }
  }, [loadConfig]);

  useEffect(() => {
    if (!conflictToast) return;
    const timeout = setTimeout(() => setConflictToast(''), 2200);
    return () => clearTimeout(timeout);
  }, [conflictToast]);

  const checkConflicts = useCallback(async () => {
    setConflictsChecked(true);
    setConflictsLoading(true);
    setConflictError('');

    try {
      const params = new URLSearchParams({ command: 'conflicts --json --limit 20' });
      const res = await fetch(`/api/v2/cortex/action?${params.toString()}`, {
        method: 'GET',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({} as { ok?: boolean; result?: unknown; error?: string }));

      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Unable to load conflicts');
      }

      setConflicts(parseConflictPairs(data.result));
    } catch (err) {
      setConflicts([]);
      setConflictError(err instanceof Error ? err.message : 'Unable to load conflicts');
    } finally {
      setConflictsLoading(false);
    }
  }, []);

  const resolveConflict = useCallback(async (keepId: number, dropId: number) => {
    setResolving(keepId);
    setConflictError('');

    try {
      const keepRes = await fetch('/api/v2/cortex/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `fact keep ${keepId}` }),
      });
      const keepData = await keepRes.json().catch(() => ({} as { ok?: boolean; error?: string }));
      if (!keepRes.ok || keepData.ok === false) {
        throw new Error(keepData.error || 'Failed to keep fact');
      }

      const dropRes = await fetch('/api/v2/cortex/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `fact drop ${dropId}` }),
      });
      const dropData = await dropRes.json().catch(() => ({} as { ok?: boolean; error?: string }));
      if (!dropRes.ok || dropData.ok === false) {
        throw new Error(dropData.error || 'Failed to drop fact');
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 220));
      setConflicts((current) => current.filter((pair) => (
        pair.factA.id !== keepId
        && pair.factB.id !== keepId
        && pair.factA.id !== dropId
        && pair.factB.id !== dropId
      )));
      setConflictToast('✓ Resolved');
      void loadConfig();
    } catch (err) {
      setConflictError(err instanceof Error ? err.message : 'Unable to resolve conflict');
    } finally {
      setResolving(null);
    }
  }, [loadConfig]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--t-text-muted, #94a3b8)' }}>
        Loading Cortex configuration…
      </div>
    );
  }

  const recallEnabled = config?.recallEnabled ?? true;
  const recallMaxResults = config?.recallMaxResults ?? 7;
  const recallTokenBudget = config?.recallTokenBudget ?? 800;
  const recallMinConfidence = config?.recallMinConfidence ?? 0.3;

  return (
    <div style={{
      paddingTop: 32,
      paddingBottom: 32,
      paddingLeft: 40,
      paddingRight: 40,
      maxWidth: 680,
      fontFamily: '-apple-system, system-ui, sans-serif',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--t-text, #0f172a)', margin: 0 }}>
            Cortex Memory
          </h2>
          <span style={{
            fontSize: 11,
            paddingTop: 2,
            paddingBottom: 2,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 6,
            background: healthy ? 'rgba(52,211,153,0.1)' : 'rgba(239,68,68,0.1)',
            color: healthy ? '#10b981' : '#ef4444',
            fontWeight: 600,
          }}>
            {healthy ? '● Healthy' : '● Unhealthy'}
          </span>
          {version && (
            <span style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>v{version.replace('cortex ', '')}</span>
          )}
        </div>
        <p style={{ fontSize: 13, color: 'var(--t-text-muted, #94a3b8)', margin: 0, lineHeight: '1.5' }}>
          Persistent memory engine with hybrid search, fact extraction, and confidence decay.
          {doctorSummary && ` ${doctorSummary}`}
        </p>
      </div>

      {/* Stats Grid */}
      {stats && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          marginBottom: 32,
        }}>
          <StatCard label="Memories" value={stats.memories} />
          <StatCard label="Facts" value={stats.facts} sub={`${stats.sources} sources`} />
          <StatCard label="Storage" value={`${stats.storageMb} MB`} />
          <StatCard
            label="Embeddings"
            value={`${stats.embedCoverage}%`}
            sub={`${stats.embeddings.toLocaleString()} / ${stats.memories.toLocaleString()}`}
          />
        </div>
      )}

      {/* Confidence Distribution */}
      {stats?.confidenceDistribution && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 12 }}>
            Confidence Distribution
          </div>
          <div style={{ display: 'flex', gap: 2, height: 8, borderRadius: 4, overflow: 'hidden' }}>
            {(() => {
              const dist = stats.confidenceDistribution;
              const total = (dist.high || 0) + (dist.medium || 0) + (dist.low || 0);
              if (total === 0) return null;
              return (
                <>
                  <div style={{ flex: (dist.high || 0) / total, background: '#10b981', borderRadius: '4px 0 0 4px' }} title={`High: ${dist.high}`} />
                  <div style={{ flex: (dist.medium || 0) / total, background: '#f59e0b' }} title={`Medium: ${dist.medium}`} />
                  <div style={{ flex: (dist.low || 0) / total, background: '#ef4444', borderRadius: '0 4px 4px 0' }} title={`Low: ${dist.low}`} />
                </>
              );
            })()}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            {[
              { label: 'High', color: '#10b981', count: stats.confidenceDistribution.high },
              { label: 'Medium', color: '#f59e0b', count: stats.confidenceDistribution.medium },
              { label: 'Low', color: '#ef4444', count: stats.confidenceDistribution.low },
            ].map(b => (
              <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: b.color }} />
                <span style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>
                  {b.label}: {(b.count || 0).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fact Types */}
      {stats?.factsByType && Object.keys(stats.factsByType).length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 12 }}>
            Fact Types
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(stats.factsByType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <span key={type} style={{
                  fontSize: 12,
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 8,
                  background: 'var(--t-bg-card, #f8fafc)',
                  border: '1px solid var(--t-border, #e2e8f0)',
                  color: 'var(--t-text, #0f172a)',
                }}>
                  {type} <span style={{ color: 'var(--t-text-muted, #94a3b8)', fontWeight: 600 }}>{count.toLocaleString()}</span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* LLM Provider + API Key */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 4 }}>
          LLM Provider
        </div>
        <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 16px', lineHeight: '1.4' }}>
          Cortex uses an LLM for fact extraction, enrichment, and classification. Configure your provider and API key.
        </p>

        {/* Provider selector */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            Provider
          </label>
          <select
            value={config?.llmProvider || ''}
            onChange={(e) => void saveConfig({ llmProvider: e.target.value })}
            disabled={saving}
            style={{
              width: '100%',
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 13,
              outline: 'none',
            }}
          >
            <option value="">— Select provider —</option>
            <option value="openrouter">OpenRouter (recommended — access all models)</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="google">Google AI</option>
            <option value="ollama">Ollama (local, no key needed)</option>
          </select>
        </div>

        {/* API Key */}
        {config?.llmProvider && config.llmProvider !== 'ollama' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
              API Key
              {config.llmApiKeySet && (
                <span style={{
                  marginLeft: 8,
                  fontSize: 10,
                  paddingTop: 2,
                  paddingBottom: 2,
                  paddingLeft: 6,
                  paddingRight: 6,
                  borderRadius: 4,
                  background: 'rgba(52,211,153,0.1)',
                  color: '#10b981',
                }}>
                  ✓ Configured
                </span>
              )}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKeyInput || (showApiKey ? '' : config.llmApiKey)}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={config.llmApiKeySet ? 'Enter new key to replace' : `Enter ${config.llmProvider} API key`}
                style={{
                  flex: 1,
                  paddingTop: 10,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 10,
                  border: '1px solid var(--t-border, #e2e8f0)',
                  background: 'var(--t-bg, white)',
                  color: 'var(--t-text, #0f172a)',
                  fontSize: 13,
                  fontFamily: 'ui-monospace, monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                style={{
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 10,
                  border: '1px solid var(--t-border, #e2e8f0)',
                  background: 'var(--t-bg, white)',
                  color: 'var(--t-text-muted, #94a3b8)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {showApiKey ? 'Hide' : 'Show'}
              </button>
              {apiKeyInput && (
                <button
                  type="button"
                  onClick={() => {
                    void saveConfig({ llmApiKey: apiKeyInput });
                    setApiKeyInput('');
                  }}
                  disabled={saving}
                  style={{
                    paddingTop: 8,
                    paddingBottom: 8,
                    paddingLeft: 16,
                    paddingRight: 16,
                    borderRadius: 10,
                    border: 'none',
                    background: '#3b82f6',
                    color: 'white',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', marginTop: 6 }}>
              {config.llmProvider === 'openrouter' && (
                <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  Get an OpenRouter API key →
                </a>
              )}
              {config.llmProvider === 'anthropic' && (
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  Get an Anthropic API key →
                </a>
              )}
              {config.llmProvider === 'openai' && (
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  Get an OpenAI API key →
                </a>
              )}
              {config.llmProvider === 'google' && (
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  Get a Google AI API key →
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Configuration Section */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 16 }}>
          Models
        </div>

        {/* Embedding Model */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            Embedding Model
          </label>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 6px', lineHeight: '1.4' }}>
            Local Ollama model for semantic search embeddings. Requires Ollama running.
          </p>
          <select
            value={config?.embedModel || ''}
            onChange={(e) => void saveConfig({ embedModel: e.target.value })}
            disabled={saving}
            style={{
              width: '100%',
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 13,
              fontFamily: 'ui-monospace, monospace',
              outline: 'none',
            }}
          >
            <option value="">— Not configured —</option>
            {/* Common embedding models */}
            <option value="ollama/nomic-embed-text">ollama/nomic-embed-text (recommended)</option>
            <option value="ollama/mxbai-embed-large">ollama/mxbai-embed-large</option>
            <option value="ollama/all-minilm">ollama/all-minilm</option>
            <option value="ollama/snowflake-arctic-embed">ollama/snowflake-arctic-embed</option>
            {/* Show any installed Ollama models that aren't already listed */}
            {ollamaModels
              .filter(m => !['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed'].some(k => m.includes(k)))
              .map(m => (
                <option key={m} value={`ollama/${m}`}>ollama/{m} (installed)</option>
              ))
            }
          </select>
        </div>

        {/* Enrichment Model — for fact extraction (Phase B) */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            Enrichment Model
          </label>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 6px', lineHeight: '1.4' }}>
            LLM used for fact extraction and enrichment during imports. Runs through your configured LLM provider.
          </p>
          <input
            type="text"
            value={config?.enrichModel || ''}
            onChange={(e) => setConfig(prev => prev ? { ...prev, enrichModel: e.target.value } : prev)}
            onBlur={(e) => void saveConfig({ enrichModel: e.target.value })}
            placeholder="e.g. openrouter/x-ai/grok-4.1-fast"
            disabled={saving}
            style={{
              width: '100%',
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 13,
              fontFamily: 'ui-monospace, monospace',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Classification Model */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            Classification Model
          </label>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 6px', lineHeight: '1.4' }}>
            LLM used for reclassifying fact types. Cheaper model recommended.
          </p>
          <input
            type="text"
            value={config?.classifyModel || ''}
            onChange={(e) => setConfig(prev => prev ? { ...prev, classifyModel: e.target.value } : prev)}
            onBlur={(e) => void saveConfig({ classifyModel: e.target.value })}
            placeholder="e.g. openrouter/deepseek/deepseek-v3.2"
            disabled={saving}
            style={{
              width: '100%',
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 13,
              fontFamily: 'ui-monospace, monospace',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {saveNote && (
          <div style={{
            fontSize: 12,
            color: saveNote === 'Saved' ? '#10b981' : '#ef4444',
            marginTop: 8,
          }}>
            {saveNote}
          </div>
        )}
      </div>

      {/* Paths */}
      {config && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 12 }}>
            Paths
          </div>
          <div style={{ fontSize: 12, color: 'var(--t-text-muted, #94a3b8)', lineHeight: '1.8' }}>
            <div><span style={{ fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Config:</span> {config.configPath}</div>
            <div><span style={{ fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Database:</span> {config.dbPath}</div>
          </div>
        </div>
      )}

      {/* Growth (24h / 7d) */}
      {stats?.growth && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 12 }}>
            Growth
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <StatCard label="Memories (24h)" value={`+${stats.growth.memories_24h || 0}`} />
            <StatCard label="Memories (7d)" value={`+${stats.growth.memories_7d || 0}`} />
            <StatCard label="Facts (24h)" value={`+${stats.growth.facts_24h || 0}`} />
            <StatCard label="Facts (7d)" value={`+${stats.growth.facts_7d || 0}`} />
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 4 }}>
          Maintenance
        </div>
        <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 12px', lineHeight: '1.4' }}>
          Run maintenance tasks to keep your memory healthy and search quality high.
        </p>
        <div style={{
          marginBottom: 12,
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid rgba(245, 158, 11, 0.2)',
          background: 'rgba(245, 158, 11, 0.08)',
          color: 'var(--t-text-secondary, #64748b)',
          fontSize: 11,
          lineHeight: 1.45,
        }}>
          <strong style={{ color: 'var(--t-text, #0f172a)' }}>Cleanup is destructive.</strong> It permanently removes garbage memories and headless facts, which can change recall and search results until they are rebuilt.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[
            { id: 'cleanup', label: 'Cleanup', desc: 'Remove garbage memories and headless facts', cmd: 'cleanup' },
            { id: 'lifecycle', label: 'Lifecycle', desc: 'Apply decay, promote, and conflict resolution policies', cmd: 'lifecycle run' },
            { id: 'conflicts', label: 'Find Conflicts', desc: 'Detect contradictory facts', cmd: 'conflicts --limit 10' },
            { id: 'optimize', label: 'Optimize DB', desc: 'VACUUM and ANALYZE the database', cmd: 'optimize' },
          ].map((action) => {
              const isCleanup = action.id === 'cleanup';
              return (
              <button
                key={action.id}
                type="button"
                title={isCleanup ? 'Permanently removes garbage memories and headless facts.' : action.desc}
                disabled={actionRunning !== null}
                onClick={async () => {
                  if (isCleanup) {
                    const confirmed = window.confirm(
                      'Cleanup permanently removes garbage memories and headless facts.\n\nThis is destructive and cannot be undone. It can change recall and search results until memory is rebuilt.\n\nContinue?',
                    );
                    if (!confirmed) return;
                  }
                  setActionRunning(action.id);
                  try {
                    const res = await fetch('/api/v2/cortex/action', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: action.cmd }),
                  });
                  if (res.ok) {
                    setSaveNote(`${action.label} complete`);
                    setTimeout(() => setSaveNote(''), 3000);
                    void loadConfig();
                  }
                } catch { /* ignore */ }
                setActionRunning(null);
              }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 14,
                  paddingRight: 14,
                  borderRadius: 10,
                  border: isCleanup ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid var(--t-border, #e2e8f0)',
                  background: actionRunning === action.id
                    ? 'var(--t-bg-card, #f8fafc)'
                    : isCleanup
                      ? 'rgba(254, 242, 242, 0.92)'
                      : 'var(--t-bg, white)',
                  color: isCleanup ? '#b91c1c' : 'var(--t-text, #0f172a)',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: actionRunning ? 'wait' : 'pointer',
                  transition: 'all 150ms',
                  opacity: actionRunning && actionRunning !== action.id ? 0.5 : 1,
                }}
              >
                {actionRunning === action.id ? '⏳' : '▸'} {action.label}
              </button>
              );
          })}
        </div>
        {saveNote && (
          <div style={{ fontSize: 12, color: '#10b981', marginTop: 8, fontWeight: 500 }}>
            ✓ {saveNote}
          </div>
        )}
      </div>

      {/* Conflicts */}
      <div style={{ marginBottom: 32, position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)' }}>
              Conflicts
            </div>
            {conflictsChecked && (
              <span style={{
                fontSize: 11,
                fontWeight: 700,
                paddingTop: 2,
                paddingBottom: 2,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 999,
                background: conflicts.length > 0 ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
                color: conflicts.length > 0 ? '#dc2626' : '#16a34a',
              }}>
                {conflicts.length}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void checkConflicts()}
            disabled={conflictsLoading || resolving !== null}
            style={{
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 14,
              paddingRight: 14,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 12,
              fontWeight: 600,
              cursor: conflictsLoading || resolving !== null ? 'wait' : 'pointer',
              opacity: conflictsLoading || resolving !== null ? 0.7 : 1,
            }}
          >
            {conflictsLoading ? 'Checking…' : 'Check Conflicts'}
          </button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 12px', lineHeight: '1.4' }}>
          Review contradictory facts and decide which version Cortex should keep.
        </p>

        {conflictError && (
          <div style={{
            fontSize: 12,
            color: '#dc2626',
            marginBottom: 12,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 10,
            border: '1px solid rgba(239,68,68,0.12)',
            background: 'rgba(239,68,68,0.04)',
          }}>
            {conflictError}
          </div>
        )}

        {!conflictsChecked && !conflictsLoading && (
          <div style={{
            paddingTop: 14,
            paddingBottom: 14,
            paddingLeft: 16,
            paddingRight: 16,
            borderRadius: 12,
            border: '1px dashed var(--t-border, #e2e8f0)',
            background: 'rgba(148,163,184,0.03)',
            color: 'var(--t-text-muted, #94a3b8)',
            fontSize: 12,
          }}>
            Run a fresh scan to inspect up to 20 contradictory fact pairs.
          </div>
        )}

        {conflictsLoading && (
          <div style={{
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            borderRadius: 12,
            border: '1px solid var(--t-border, #e2e8f0)',
            background: 'var(--t-bg-card, #f8fafc)',
            color: 'var(--t-text-muted, #94a3b8)',
            fontSize: 12,
          }}>
            Scanning Cortex for contradictory facts…
          </div>
        )}

        {conflictsChecked && !conflictsLoading && conflicts.length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--t-text-muted)' }}>
            <span style={{ fontSize: 13 }}>No conflicts found — your knowledge base is consistent ✓</span>
          </div>
        )}

        {conflictsChecked && !conflictsLoading && conflicts.length > 0 && (
          <div>
            {conflicts.map((pair) => {
              const pairKey = `${pair.factA.id}-${pair.factB.id}`;
              const pairResolving = resolving === pair.factA.id || resolving === pair.factB.id;
              const subject = pair.factA.subject || pair.factB.subject;
              const predicate = pair.factA.predicate || pair.factB.predicate;

              return (
                <div
                  key={pairKey}
                  style={{
                    padding: 16,
                    borderRadius: 12,
                    border: '1px solid var(--t-border, #e2e8f0)',
                    background: 'var(--t-bg-card, #f8fafc)',
                    marginBottom: 12,
                    opacity: pairResolving ? 0 : 1,
                    transform: pairResolving ? 'translateY(-8px) scale(0.98)' : 'translateY(0) scale(1)',
                    transition: 'opacity 180ms ease, transform 180ms ease',
                    pointerEvents: pairResolving ? 'none' : 'auto',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', marginBottom: 12 }}>
                    <span style={{ color: '#2563eb' }}>{subject}</span>
                    <span style={{ color: 'var(--t-text-muted)', margin: '0 6px' }}>→</span>
                    <span>{predicate}</span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    {[
                      { fact: pair.factA, other: pair.factB, side: 'A' },
                      { fact: pair.factB, other: pair.factA, side: 'B' },
                    ].map(({ fact, other, side }) => {
                      const keepBusy = resolving === fact.id;
                      const otherBusy = resolving === other.id;

                      return (
                        <div
                          key={`${pairKey}-${side}`}
                          style={{
                            padding: 12,
                            borderRadius: 10,
                            border: '1px solid var(--t-border, #e2e8f0)',
                            background: 'var(--t-bg, white)',
                          }}
                        >
                          <div style={{
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            color: 'var(--t-text-muted, #94a3b8)',
                            marginBottom: 8,
                          }}>
                            Fact {side}
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 8, lineHeight: '1.45' }}>
                            &quot;{fact.object}&quot;
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--t-text-muted, #94a3b8)', display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                            <span>Confidence: {(fact.confidence * 100).toFixed(0)}%</span>
                            <span>·</span>
                            <span>Source: {fact.source}</span>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--t-text-muted, #94a3b8)', display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                            <span>Last seen: {formatConflictDate(fact.lastSeen)}</span>
                            <span>·</span>
                            <span>ID: {fact.id}</span>
                            {fact.factType ? (
                              <>
                                <span>·</span>
                                <span>Type: {fact.factType}</span>
                              </>
                            ) : null}
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              onClick={() => void resolveConflict(fact.id, other.id)}
                              disabled={resolving !== null}
                              style={{
                                flex: 1,
                                padding: '6px 0',
                                borderRadius: 8,
                                border: '1px solid rgba(34,197,94,0.3)',
                                background: 'rgba(34,197,94,0.06)',
                                color: '#16a34a',
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: resolving !== null ? 'wait' : 'pointer',
                                opacity: resolving !== null ? 0.7 : 1,
                              }}
                            >
                              {keepBusy ? 'Resolving…' : 'Keep this'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void resolveConflict(other.id, fact.id)}
                              disabled={resolving !== null}
                              style={{
                                padding: '6px 10px',
                                borderRadius: 8,
                                border: '1px solid rgba(239,68,68,0.2)',
                                background: 'transparent',
                                color: '#dc2626',
                                fontSize: 11,
                                fontWeight: 500,
                                cursor: resolving !== null ? 'wait' : 'pointer',
                                opacity: resolving !== null ? 0.7 : 1,
                              }}
                            >
                              {otherBusy ? 'Keeping other…' : 'Drop'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {conflictToast && (
          <div style={{
            position: 'fixed',
            right: 24,
            bottom: 24,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 14,
            borderRadius: 12,
            border: '1px solid rgba(34,197,94,0.18)',
            background: 'rgba(15,23,42,0.94)',
            color: '#dcfce7',
            fontSize: 12,
            fontWeight: 600,
            boxShadow: '0 18px 40px rgba(15,23,42,0.18)',
            zIndex: 40,
          }}>
            {conflictToast}
          </div>
        )}
      </div>

      {/* Chat Memory Settings */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 4 }}>
          Chat Memory
        </div>
        <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 12px', lineHeight: '1.4' }}>
          When enabled, the LLM chat searches Cortex for relevant memories before each message and injects them as context.
          The model remembers decisions, preferences, and project details across conversations.
        </p>
        <div style={{
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          paddingRight: 16,
          borderRadius: 12,
          border: '1px solid var(--t-border, #e2e8f0)',
          background: 'var(--t-bg-card, #f8fafc)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Memory Recall</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Search Cortex before each LLM request</div>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setConfig(prev => prev ? { ...prev, recallEnabled: !recallEnabled } : prev);
                  void saveConfig({ recallEnabled: !recallEnabled });
                }}
                aria-pressed={recallEnabled}
                style={{
                  width: 36,
                  height: 20,
                  borderRadius: 10,
                  border: 'none',
                  background: recallEnabled ? '#3b82f6' : '#cbd5e1',
                  position: 'relative',
                  cursor: saving ? 'default' : 'pointer',
                  transition: 'background 150ms',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                <div style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: 'white',
                  position: 'absolute',
                  top: 2,
                  left: recallEnabled ? 18 : 2,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  transition: 'left 150ms',
                }} />
              </button>
            </div>
            <div style={{ height: 1, background: 'var(--t-border, #e2e8f0)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Max Results</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Top N facts injected per request</div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', fontFamily: 'ui-monospace, monospace' }}>{recallMaxResults}</span>
            </div>
            <div style={{ height: 1, background: 'var(--t-border, #e2e8f0)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Token Budget</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Max tokens used for memory context</div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', fontFamily: 'ui-monospace, monospace' }}>{recallTokenBudget}</span>
            </div>
            <div style={{ height: 1, background: 'var(--t-border, #e2e8f0)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Min Confidence</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Facts below this score are excluded</div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', fontFamily: 'ui-monospace, monospace' }}>{recallMinConfidence}</span>
            </div>
            {config?.sourceBoostCount != null && config.sourceBoostCount > 0 && (
              <>
                <div style={{ height: 1, background: 'var(--t-border, #e2e8f0)' }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Source Boost Rules</div>
                    <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Custom source weighting configured</div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', fontFamily: 'ui-monospace, monospace' }}>{config.sourceBoostCount}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Getting Started / Setup Guide */}
      {(!stats || !config?.llmApiKeySet) && (
        <div style={{
          marginBottom: 32,
          paddingTop: 20,
          paddingBottom: 20,
          paddingLeft: 20,
          paddingRight: 20,
          borderRadius: 12,
          border: '1px dashed var(--t-border, #e2e8f0)',
          background: 'rgba(59,130,246,0.02)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 8 }}>
            Getting Started
          </div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--t-text-muted, #94a3b8)', lineHeight: '1.8' }}>
            <li style={{ color: config?.llmApiKeySet ? '#10b981' : undefined }}>
              {config?.llmApiKeySet ? '✓' : '→'} Configure an LLM provider and API key above
            </li>
            <li style={{ color: config?.embedModel ? '#10b981' : undefined }}>
              {config?.embedModel ? '✓' : '→'} Install Ollama and pull an embedding model: <code style={{ fontSize: 11, background: 'var(--t-bg-card, #f1f5f9)', paddingTop: 1, paddingBottom: 1, paddingLeft: 4, paddingRight: 4, borderRadius: 3 }}>ollama pull nomic-embed-text</code>
            </li>
            <li>
              → Import your first memories: <code style={{ fontSize: 11, background: 'var(--t-bg-card, #f1f5f9)', paddingTop: 1, paddingBottom: 1, paddingLeft: 4, paddingRight: 4, borderRadius: 3 }}>cortex import ~/notes --extract</code>
            </li>
            <li>
              → Chat with memory — Cortex automatically recalls relevant facts
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}

// ── Diagnostics Tab — Cortex Doctor ──

interface DiagnosticTool {
  id: string;
  detected: boolean;
  version?: string;
  path?: string;
}

function DiagnosticsTab() {
  const [tools, setTools] = useState<DiagnosticTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const runDiagnostics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/detect');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { tools?: DiagnosticTool[] };
      setTools(data.tools ?? []);
      setLastChecked(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run diagnostics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void runDiagnostics(); }, [runDiagnostics]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>Diagnostics</div>
          <div style={{ fontSize: 12, color: 'var(--t-text-muted)', marginTop: 2 }}>
            {lastChecked ? `Last checked at ${lastChecked}` : 'Runtime and tool health'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { void runDiagnostics(); }}
          disabled={loading}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 8,
            border: `1px solid ${THEME_ACCENT_BORDER}`,
            background: THEME_ACCENT_SOFT,
            color: THEME_ACCENT,
            fontSize: 12,
            fontWeight: 600,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Checking...' : 'Re-run'}
        </button>
      </div>

      {error ? (
        <div style={{
          padding: '12px 16px',
          borderRadius: 10,
          background: 'rgba(239, 68, 68, 0.06)',
          border: '1px solid rgba(239, 68, 68, 0.15)',
          color: '#ef4444',
          fontSize: 13,
        }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tools.map((tool) => (
          <div key={tool.id} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderRadius: 10,
            background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
            border: '1px solid var(--t-divider-subtle, rgba(148, 163, 184, 0.10))',
          }}>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: tool.detected ? '#22c55e' : '#ef4444',
              flexShrink: 0,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>{tool.id}</div>
              {tool.path ? (
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tool.path}
                </div>
              ) : null}
            </div>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: tool.detected ? 'var(--t-text-secondary)' : '#ef4444',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              {tool.detected ? (tool.version ?? 'detected') : 'not found'}
            </div>
          </div>
        ))}
        {!loading && tools.length === 0 && !error ? (
          <div style={{ fontSize: 13, color: 'var(--t-text-muted)', padding: '20px 0', textAlign: 'center' }}>
            No tools detected. Run diagnostics to check your environment.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AppearanceTab() {
  const { themeId, setTheme, themes: themeList } = useTheme();
  const [fleetMode, setFleetMode] = useState<'smart' | 'all'>(() => {
    if (typeof window === 'undefined') return 'smart';
    return (localStorage.getItem('cortex-ide-fleet-mode') as 'smart' | 'all') ?? 'smart';
  });
  const [navRailHoverExpand, setNavRailHoverExpand] = useState(() => readNavRailHoverExpandEnabled());

  useEffect(() => subscribeNavRailHoverExpandEnabled(setNavRailHoverExpand), []);

  const handleFleetModeChange = (mode: 'smart' | 'all') => {
    setFleetMode(mode);
    localStorage.setItem('cortex-ide-fleet-mode', mode);
  };

  const handleNavRailHoverExpandChange = (enabled: boolean) => {
    setNavRailHoverExpand(enabled);
    writeNavRailHoverExpandEnabled(enabled);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Section: Themes */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 24,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 4 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Theme
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0' }}>
            Choose how Cortex IDE looks. Accent colors and status indicators stay consistent across themes.
          </p>
        </div>

        <div style={{
          display: 'flex',
          gap: 16,
          marginTop: 20,
          flexWrap: 'wrap',
        }}>
          {themeList.map((theme) => (
            <ThemePreviewCard
              key={theme.id}
              theme={theme}
              active={themeId === theme.id}
              onSelect={() => setTheme(theme.id)}
            />
          ))}
        </div>
      </div>

      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 24,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Motion
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0' }}>
            Reduce movement in the shell without changing the underlying layout or actions.
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={navRailHoverExpand}
          onClick={() => handleNavRailHoverExpandChange(!navRailHoverExpand)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '14px 16px',
            borderRadius: 12,
            border: navRailHoverExpand
              ? `1.5px solid ${THEME_ACCENT_BORDER}`
              : '1px solid var(--t-panel-border)',
            background: navRailHoverExpand
              ? THEME_ACCENT_SOFT
              : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'border-color 140ms ease, background 140ms ease, box-shadow 140ms ease',
            boxShadow: navRailHoverExpand
              ? `0 10px 28px ${THEME_ACCENT_RING}`
              : 'none',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                Expand nav rail on hover
              </span>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px',
                borderRadius: 999,
                background: navRailHoverExpand ? THEME_ACCENT_SOFT_STRONG : 'var(--t-divider-subtle)',
                color: navRailHoverExpand ? THEME_ACCENT : 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 700,
              }}>
                <span style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: navRailHoverExpand ? THEME_ACCENT : 'var(--t-text-muted)',
                }} />
                {navRailHoverExpand ? 'On' : 'Off'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 5, lineHeight: 1.45 }}>
              When off, the left rail stays compact at all times and users open sections with clicks only.
            </div>
          </div>

          <div style={{
            width: 42,
            height: 24,
            borderRadius: 999,
            background: navRailHoverExpand ? THEME_ACCENT : 'var(--t-divider-strong)',
            position: 'relative',
            flexShrink: 0,
            boxShadow: navRailHoverExpand ? `inset 0 0 0 1px ${THEME_ACCENT_BORDER}` : 'inset 0 0 0 1px var(--t-divider)',
            transition: 'background 140ms ease',
          }}>
            <span style={{
              position: 'absolute',
              top: 3,
              left: navRailHoverExpand ? 21 : 3,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--t-text-strong)',
              boxShadow: '0 2px 8px rgba(15, 23, 42, 0.28)',
              transition: 'left 140ms ease',
            }} />
          </div>
        </button>
      </div>

      {/* Section: Fleet Display */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 24,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Fleet Display
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0' }}>
            Control how agents and their sessions appear in the sidebar.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {([
            {
              id: 'smart' as const,
              label: 'Agents + Updates',
              desc: 'Show all main agent surfaces and one card per sub-agent. Cron runs update existing cards instead of creating new ones.',
            },
            {
              id: 'all' as const,
              label: 'All Agents + Crons',
              desc: 'Show every session including individual cron runs. More detail, more cards.',
            },
          ]).map((option) => (
            <div
              key={option.id}
              onClick={() => handleFleetModeChange(option.id)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '12px 14px', borderRadius: 10,
                border: fleetMode === option.id
                  ? `1.5px solid ${THEME_ACCENT_BORDER}`
                  : '1px solid var(--t-panel-border)',
                background: fleetMode === option.id
                  ? THEME_ACCENT_SOFT
                  : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                cursor: 'pointer',
                transition: 'all 120ms ease',
                boxShadow: fleetMode === option.id ? `0 10px 24px ${THEME_ACCENT_RING}` : 'none',
              }}
            >
              <div style={{
                width: 16, height: 16, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                border: fleetMode === option.id
                  ? `5px solid ${THEME_ACCENT}`
                  : '2px solid var(--t-text-muted)',
                background: fleetMode === option.id ? 'var(--t-panel)' : 'transparent',
                transition: 'all 120ms ease',
              }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>
                  {option.label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                  {option.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: 24,
      background: 'var(--t-bg-gradient)',
      display: 'flex',
      gap: 20,
    }}>
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
        <TabButton label="Agents" icon={<UsersIcon />} active={activeTab === 'agents'} onClick={() => setActiveTab('agents')} />
        <TabButton label="Memory" icon={<BrainIcon />} active={activeTab === 'memory'} onClick={() => setActiveTab('memory')} />
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
            <OpenClawConnectionCard />
          </div>
        )}
        {activeTab === 'api-keys' && (
          <APIKeysTab />
        )}
        {activeTab === 'agents' && (
          <AgentsTab />
        )}
        {activeTab === 'memory' && (
          <CortexMemoryTab />
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
