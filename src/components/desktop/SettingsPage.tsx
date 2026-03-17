'use client';

/**
 * SettingsPage — Full workspace settings panel.
 *
 * First tab: GitHub connection status + account management.
 * Future tabs: Slack, Linear, Vault config, Agent defaults, etc.
 */

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { useTheme } from '@/lib/theme/context';
import { formatModelLabel } from '@/lib/format';

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

type SettingsTab = 'connectors' | 'agents' | 'appearance' | 'about';

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
        border: 'none',
        background: active ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
        color: active ? '#2563eb' : 'var(--t-text-secondary)',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 120ms, color 120ms',
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
      background: 'rgba(37, 99, 235, 0.08)',
      color: '#2563eb',
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
  const activeDeviceFlow = deviceFlow ?? {
    flowId: '',
    userCode: '',
    verificationUri: '',
    verificationUriComplete: '',
    expiresAt: 0,
    expiresInMinutes: 0,
    nextPollInMs: 1000,
    note: '',
  };

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
                  ? `${activeAccount.login} • ${repos.length} repos • ${diagnosticsReadyCount}/${diagnostics.length} diagnostics ready`
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
                <span style={{ padding: '4px 9px', borderRadius: 999, background: 'var(--t-bg-subtle)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600 }}>{repos.length} repos</span>
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
                    Protocol: {activeAccount.protocol} · {activeAccount.scopes.length} scopes · {repos.length} repositories
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
                        {activeDeviceFlow.userCode}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 8, lineHeight: 1.45 }}>
                        {activeDeviceFlow.note || 'Waiting for approval in GitHub…'} Expires in about {activeDeviceFlow.expiresInMinutes} minute(s).
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <button type="button" onClick={() => window.open(activeDeviceFlow.verificationUriComplete || activeDeviceFlow.verificationUri, '_blank', 'noopener,noreferrer')} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        Open GitHub
                      </button>
                      <button type="button" onClick={() => { void copyDeviceCode(); }} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        {deviceCodeCopied ? 'Copied' : 'Copy Code'}
                      </button>
                      <button type="button" onClick={() => onPollDeviceFlow?.(activeDeviceFlow.flowId)} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        Poll Now
                      </button>
                      <button
                        type="button"
                        onClick={() => onCancelDeviceFlow?.(activeDeviceFlow.flowId)}
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
                <span>Repositories ({repos.length})</span>
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

// ── Placeholder Tabs ──

function PlaceholderTab({ title, description }: { title: string; description: string }) {
  return (
    <div style={{
      background: 'var(--t-panel)',
      borderRadius: 14,
      padding: 32,
      border: '1px solid var(--t-panel-border)',
      textAlign: 'center',
    }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)', margin: '0 0 6px' }}>{title}</h3>
      <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: 0 }}>{description}</p>
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

  const fetchFleet = useCallback(async () => {
    try {
      const res = await fetch('/api/openclaw/fleet');
      if (!res.ok) return;
      const data = await res.json();
      setSquads(data.squads || []);
      setAgents(data.agents || []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchFleet(); }, [fetchFleet]);

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(fetchFleet, 30000);
    return () => clearInterval(timer);
  }, [fetchFleet]);

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
        <div style={{ width: 1, background: 'var(--t-divider)' }} />
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#f59e0b' }}>
            {agents.filter(a => a.runtime === 'openclaw').length}
          </div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>OpenClaw</div>
        </div>
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
        border: active ? '2px solid #2563eb' : '2px solid var(--t-panel-border)',
        borderRadius: 16,
        background: 'var(--t-panel)',
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'border-color 200ms, box-shadow 200ms',
        boxShadow: active ? '0 0 0 3px rgba(37, 99, 235, 0.15)' : 'var(--t-panel-shadow)',
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
            background: '#2563eb',
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

function AppearanceTab() {
  const { themeId, setTheme, themes: themeList } = useTheme();

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
    </div>
  );
}

// ── Main Settings Page ──

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('connectors');
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [deviceFlowEnabled, setDeviceFlowEnabled] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<GitHubDeviceFlowState | null>(null);
  const [actionBusy, setActionBusy] = useState<GitHubActionKind | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

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
      setAccounts(data.accounts || []);
      setRepos(data.repos || []);
      setDeviceFlowEnabled(Boolean(data.deviceFlowEnabled));
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
        setRepos(refreshData.repos || []);
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
        <TabButton label="Agents" icon={<UsersIcon />} active={activeTab === 'agents'} onClick={() => setActiveTab('agents')} />
        <TabButton label="Appearance" icon={<PaletteIcon />} active={activeTab === 'appearance'} onClick={() => setActiveTab('appearance')} />
        <TabButton label="About" icon={<InfoIcon />} active={activeTab === 'about'} onClick={() => setActiveTab('about')} />
      </div>

      {/* Right content — full width */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {activeTab === 'connectors' && (
          <GitHubTab
            accounts={accounts}
            repos={repos}
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
        )}
        {activeTab === 'agents' && (
          <AgentsTab />
        )}
        {activeTab === 'appearance' && (
          <AppearanceTab />
        )}
        {activeTab === 'about' && (
          <PlaceholderTab title="About Cortex IDE" description="Version 0.0.1 · Built with Next.js + Tauri · Powered by Cortex" />
        )}
      </div>
    </div>
  );
}
