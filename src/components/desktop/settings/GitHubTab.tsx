'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  type GitHubAccount,
  type GitHubRepo,
  type GitHubBrokerStatus,
  type GitHubDeviceFlowState,
  type GitHubActionKind,
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
  normalizeVersion,
  GitHubIcon,
  CheckCircleIcon,
  LockIcon,
  GlobeIcon,
  ChevronDownIcon,
  ScopeBadge,
  ScopeDiagnostic,
  GitHubAvatar,
  QuickLink,
} from './shared';

// ── GitHub Tab Content ──

export function GitHubTab({
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
