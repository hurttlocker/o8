'use client';

import { useState } from 'react';
import {
  type GitHubAccount,
  type GitHubRepo,
  type GitHubBrokerStatus,
  type GitHubDeviceFlowState,
  type GitHubActionKind,
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_ACCENT_BORDER,
  CheckCircleIcon,
  LockIcon,
  GlobeIcon,
  ChevronDownIcon,
  ScopeDiagnostic,
  GitHubAvatar,
} from './shared';

export function GitHubTab({
  accounts,
  repos,
  repoCount,
  broker,
  loading,
  actionBusy,
  actionNote,
  onRefresh,
  onDisconnect,
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
  const [cliExpanded, setCliExpanded] = useState(false);
  const [reposExpanded, setReposExpanded] = useState(false);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);

  const activeAccount = accounts.find((a) => a.active) ?? null;
  const cliConnected = !!activeAccount;

  const appConfigured = !!(broker && broker.configured);
  const appConnected = !!(broker
    && broker.tokenReady
    && broker.installationReachable
    && broker.privateKeyConfigured);
  // Webhook + production URL only matter when this install is hosting a
  // public webhook target. For local-only installs, hide that noise.
  const showProdDiagnostics = !!(broker && (broker.publicBaseUrlConfigured || broker.webhookSecretConfigured));

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

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
        Checking GitHub connection...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── Section 1: o8 GitHub App ─────────────────────────── */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
        padding: 18,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)' }}>o8 GitHub App</span>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 9px',
                borderRadius: 999,
                background: appConnected ? 'rgba(34, 197, 94, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                color: appConnected ? '#22c55e' : '#92400e',
                fontSize: 11,
                fontWeight: 700,
              }}>
                {appConnected && <CheckCircleIcon />}
                {appConnected ? 'Connected' : appConfigured ? 'Needs Attention' : 'Not Configured'}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--t-text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              {appConnected && broker
                ? `App ${broker.appId} · installed on @${broker.installationAccount} · ${repoCount} ${repoCount === 1 ? 'repo' : 'repos'}`
                : appConfigured
                  ? broker?.note ?? 'Diagnostics below show what still needs to be configured.'
                  : 'The product needs the GitHub App to read issues, open PRs, and act on your behalf. Set GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID and drop the PEM at ~/.cortex-ide/github-app.pem.'}
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={actionBusy === 'refresh'}
            style={{
              padding: '7px 12px',
              borderRadius: 8,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-panel)',
              color: 'var(--t-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: actionBusy === 'refresh' ? 'default' : 'pointer',
              opacity: actionBusy === 'refresh' ? 0.55 : 1,
              flexShrink: 0,
            }}
          >
            {actionBusy === 'refresh' ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {actionNote && (
          <div style={{
            marginBottom: 14,
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

        {appConfigured && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 10,
            marginBottom: 14,
          }}>
            <ScopeDiagnostic
              title="App key"
              status={broker!.privateKeyConfigured ? 'ready' : 'missing'}
              detail={broker!.privateKeyConfigured
                ? `App ${broker!.appId ?? 'unknown'} can sign installation token requests.`
                : 'Missing GitHub App private key at ~/.cortex-ide/github-app.pem.'}
            />
            <ScopeDiagnostic
              title="Installation"
              status={broker!.installationReachable ? 'ready' : 'missing'}
              detail={broker!.installationReachable
                ? `Installation ${broker!.installationId ?? 'unknown'} is healthy on ${broker!.probeRepo ?? 'the probe repo'}.`
                : `Cannot reach installation for ${broker!.probeRepo ?? 'the configured repo'}.`}
            />
            {showProdDiagnostics && (
              <ScopeDiagnostic
                title="Webhook secret"
                status={broker!.webhookSecretConfigured ? 'ready' : 'missing'}
                detail={broker!.webhookSecretConfigured
                  ? 'Webhook signature verification can be enforced in production.'
                  : 'Set GITHUB_APP_WEBHOOK_SECRET before enabling production webhooks.'}
              />
            )}
            {showProdDiagnostics && (
              <ScopeDiagnostic
                title="Production URL"
                status={broker!.publicBaseUrlConfigured ? 'ready' : 'missing'}
                detail={broker!.publicBaseUrlConfigured
                  ? `Webhook target is ${broker!.webhookUrl ?? 'configured'}.`
                  : 'Set CORTEX_IDE_PUBLIC_BASE_URL when this installation is publicly reachable.'}
              />
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {broker?.installationId && (
            <a
              href={`https://github.com/settings/installations/${broker.installationId}`}
              target="_blank"
              rel="noreferrer"
              style={brokerLinkStyle}
            >
              Open Installation
            </a>
          )}
          <a
            href="https://github.com/settings/apps/cortex-dev-agent"
            target="_blank"
            rel="noreferrer"
            style={brokerLinkStyle}
          >
            App Settings
          </a>
        </div>
      </div>

      {/* ── Repositories ──────────────────────────────────────── */}
      {repos.length > 0 && (
        <div style={{
          background: 'var(--t-panel)',
          borderRadius: 14,
          border: '1px solid var(--t-panel-border)',
          boxShadow: 'var(--t-panel-shadow)',
          overflow: 'hidden',
        }}>
          <button
            type="button"
            onClick={() => setReposExpanded((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '14px 18px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--t-text)',
              textAlign: 'left',
            }}
          >
            <span>Tracked repositories ({repos.length})</span>
            <ChevronDownIcon rotated={reposExpanded} />
          </button>
          {reposExpanded && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: 240,
              overflowY: 'auto',
              padding: '0 18px 18px',
            }}>
              {repos.map((repo) => (
                <a
                  key={repo.nameWithOwner}
                  href={`https://github.com/${repo.nameWithOwner}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--t-panel-border)',
                    background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
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
      )}

      {/* ── Section 2: Local GitHub CLI (optional) ──────────── */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
        overflow: 'hidden',
      }}>
        <button
          type="button"
          onClick={() => setCliExpanded((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            padding: '14px 18px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {activeAccount
            ? <GitHubAvatar avatarUrl={activeAccount.avatarUrl} login={activeAccount.login} size={32} />
            : <GitHubAvatar login="github" size={32} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                Local GitHub CLI
              </span>
              <span style={{
                padding: '2px 8px',
                borderRadius: 999,
                background: 'var(--t-bg-card, rgba(148, 163, 184, 0.10))',
                color: 'var(--t-text-muted)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}>
                Optional
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 3, lineHeight: 1.45 }}>
              {cliConnected
                ? `Signed in as ${activeAccount!.login} — used for terminal git push/fetch and gh commands.`
                : 'Sign in if you want o8 to run gh commands or git push from the workspace terminals.'}
            </div>
          </div>
          <ChevronDownIcon rotated={cliExpanded} />
        </button>

        {cliExpanded && (
          <div style={{
            padding: '0 18px 18px',
            borderTop: '1px solid var(--t-divider-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}>
            {cliConnected && activeAccount && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>
                    {activeAccount.login}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2 }}>
                    Protocol: {activeAccount.protocol} · {activeAccount.scopes.length} {activeAccount.scopes.length === 1 ? 'scope' : 'scopes'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onDisconnect?.(activeAccount.login)}
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
                    opacity: actionBusy === 'logout' ? 0.6 : 1,
                  }}
                >
                  {actionBusy === 'logout' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            )}

            {!cliConnected && !deviceFlow && (
              <div style={{ paddingTop: 14 }}>
                <button
                  type="button"
                  onClick={onStartDeviceFlow}
                  disabled={!deviceFlowEnabled || actionBusy === 'login_device'}
                  style={{
                    padding: '9px 16px',
                    borderRadius: 9,
                    border: 'none',
                    background: !deviceFlowEnabled || actionBusy === 'login_device' ? 'var(--t-divider-subtle)' : THEME_ACCENT,
                    color: !deviceFlowEnabled || actionBusy === 'login_device' ? 'var(--t-text-faint)' : '#fff',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: !deviceFlowEnabled || actionBusy === 'login_device' ? 'default' : 'pointer',
                  }}
                >
                  {actionBusy === 'login_device' ? 'Starting…' : 'Sign in with GitHub'}
                </button>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 8, lineHeight: 1.45 }}>
                  {deviceFlowEnabled
                    ? 'Opens a GitHub device code flow and stores the result in your local gh CLI.'
                    : 'Set GITHUB_OAUTH_CLIENT_ID to enable device-flow sign-in.'}
                </div>
              </div>
            )}

            {deviceFlow && (
              <div style={{ paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
                  border: '1px solid var(--t-panel-border)',
                }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--t-text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    marginBottom: 6,
                  }}>
                    Enter This Code
                  </div>
                  <div style={{
                    fontSize: 22,
                    fontWeight: 800,
                    color: 'var(--t-text)',
                    letterSpacing: '0.14em',
                    fontFamily: '"SF Mono", Menlo, monospace',
                  }}>
                    {deviceFlow.userCode}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 8, lineHeight: 1.45 }}>
                    {deviceFlow.note || 'Waiting for approval in GitHub…'} Expires in about {deviceFlow.expiresInMinutes} minute{deviceFlow.expiresInMinutes === 1 ? '' : 's'}.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => window.open(deviceFlow.verificationUriComplete || deviceFlow.verificationUri, '_blank', 'noopener,noreferrer')}
                    style={ghostButtonStyle}
                  >
                    Open GitHub
                  </button>
                  <button type="button" onClick={() => { void copyDeviceCode(); }} style={ghostButtonStyle}>
                    {deviceCodeCopied ? 'Copied' : 'Copy Code'}
                  </button>
                  <button type="button" onClick={() => onPollDeviceFlow?.(deviceFlow.flowId)} style={ghostButtonStyle}>
                    Poll Now
                  </button>
                  <button
                    type="button"
                    onClick={() => onCancelDeviceFlow?.(deviceFlow.flowId)}
                    disabled={actionBusy === 'cancel_device'}
                    style={{
                      ...ghostButtonStyle,
                      border: '1px solid rgba(239, 68, 68, 0.18)',
                      background: 'rgba(239, 68, 68, 0.04)',
                      color: '#b91c1c',
                      opacity: actionBusy === 'cancel_device' ? 0.6 : 1,
                    }}
                  >
                    {actionBusy === 'cancel_device' ? 'Cancelling…' : 'Cancel'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const brokerLinkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 14px',
  borderRadius: 9,
  border: `1px solid ${THEME_ACCENT_BORDER}`,
  background: THEME_ACCENT_SOFT,
  color: THEME_ACCENT,
  fontSize: 11,
  fontWeight: 700,
  textDecoration: 'none',
};

const ghostButtonStyle: React.CSSProperties = {
  padding: '7px 12px',
  borderRadius: 8,
  border: '1px solid var(--t-panel-border)',
  background: 'var(--t-panel)',
  color: 'var(--t-text-secondary)',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
};
