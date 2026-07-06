'use client';

import { useState } from 'react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  type GitHubAccount,
  type GitHubRepo,
  type GitHubBrokerStatus,
  type GitHubDeviceFlowState,
  type GitHubActionKind,
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  FieldLabel,
  LockIcon,
  GlobeIcon,
  RamsButton,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow } from './grouped';

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
  const [reposExpanded, setReposExpanded] = useState(false);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);

  const activeAccount = accounts.find((a) => a.active) ?? null;
  const cliConnected = !!activeAccount;

  const appConfigured = !!(broker && broker.configured);
  const appConnected = !!(broker
    && broker.tokenReady
    && broker.installationReachable
    && broker.privateKeyConfigured);
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
      <div style={{
        paddingTop: 40,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Checking GitHub connection...
      </div>
    );
  }

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="connectors" />
      <TabHeading
        title="connectors"
        subtitle="GitHub is the first-class connector. App install drives automation; the local CLI is optional for terminal git commands."
      />

      {actionNote ? (
        <div style={{
          marginBottom: 28,
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          fontFamily: APP_FONT_STACK,
          lineHeight: 1.5,
          paddingTop: 2,
          paddingBottom: 2,
        }}>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: RAMS_ACCENT,
            marginRight: 8,
          }}>
            [note]
          </span>
          {actionNote}
        </div>
      ) : null}

      <section>
        <SettingsGroup header="Accounts">
          {activeAccount ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              paddingTop: 14,
              paddingBottom: 14,
              paddingLeft: 14,
              paddingRight: 14,
            }}>
              <AccountAvatar login={activeAccount.login} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 15, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                    {activeAccount.login}
                  </span>
                  <BracketLabel tone="quiet">active</BracketLabel>
                </div>
                <div style={{
                  fontSize: 12,
                  color: 'var(--t-text-muted)',
                  marginTop: 4,
                  fontFamily: APP_FONT_STACK,
                  letterSpacing: '-0.01em',
                }}>
                  {activeAccount.protocol} · {activeAccount.scopes.length} {activeAccount.scopes.length === 1 ? 'scope' : 'scopes'}
                </div>
              </div>
              <RamsButton
                variant="ghost"
                onClick={onRefresh}
                disabled={actionBusy === 'refresh'}
                busy={actionBusy === 'refresh'}
              >
                Refresh
              </RamsButton>
              <RamsButton
                variant="ghost"
                onClick={() => onDisconnect?.(activeAccount.login)}
                disabled={actionBusy === 'logout'}
                busy={actionBusy === 'logout'}
              >
                Disconnect
              </RamsButton>
            </div>
          ) : (
            <div style={{
              paddingTop: 14,
              paddingBottom: 14,
              paddingLeft: 14,
              paddingRight: 14,
              fontSize: 13,
              color: 'var(--t-text-secondary)',
              lineHeight: 1.55,
              maxWidth: 580,
            }}>
              No GitHub account is connected. Use the device flow below to sign in. Terminal git push and gh commands will pick it up automatically.
            </div>
          )}
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Device flow">
          {!cliConnected && !deviceFlow ? (
            <SettingsRow
              label="Sign in with GitHub"
              subtitle={deviceFlowEnabled
                ? 'Opens a GitHub device code flow. The verification code appears below, paste it into github.com/login/device.'
                : 'Set GITHUB_OAUTH_CLIENT_ID to enable device-flow sign-in.'}
              onPress={onStartDeviceFlow}
              disabled={!deviceFlowEnabled || actionBusy === 'login_device'}
              chevron
            />
          ) : null}

          {deviceFlow ? (
            <div style={{
              paddingTop: 14,
              paddingBottom: 14,
              paddingLeft: 14,
              paddingRight: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}>
              <div>
                <FieldLabel>enter this code</FieldLabel>
                <div style={{
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 22,
                  fontWeight: 300,
                  color: 'var(--t-text)',
                  letterSpacing: '0.18em',
                  marginTop: 8,
                }}>
                  {deviceFlow.userCode}
                </div>
                <div style={{
                  marginTop: 6,
                  fontSize: 12,
                  color: 'var(--t-text-secondary)',
                  lineHeight: 1.55,
                  maxWidth: 560,
                }}>
                  {deviceFlow.note || 'Waiting for approval in GitHub.'} Expires in about {deviceFlow.expiresInMinutes} minute{deviceFlow.expiresInMinutes === 1 ? '' : 's'}.
                </div>
                <div style={{
                  marginTop: 4,
                  fontSize: 12,
                  color: 'var(--t-text-muted)',
                  fontFamily: MONO_FONT_STACK,
                  wordBreak: 'break-all',
                }}>
                  {deviceFlow.verificationUriComplete || deviceFlow.verificationUri}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => openExternalUrl(deviceFlow.verificationUriComplete || deviceFlow.verificationUri)}
                  style={quietActionStyle(false)}
                >
                  open github
                </button>
                <button type="button" onClick={() => { void copyDeviceCode(); }} style={quietActionStyle(false)}>
                  {deviceCodeCopied ? 'copied' : 'copy code'}
                </button>
                <button type="button" onClick={() => onPollDeviceFlow?.(deviceFlow.flowId)} style={quietActionStyle(false)}>
                  poll now
                </button>
                <button
                  type="button"
                  onClick={() => onCancelDeviceFlow?.(deviceFlow.flowId)}
                  disabled={actionBusy === 'cancel_device'}
                  style={quietActionStyle(actionBusy === 'cancel_device')}
                >
                  {actionBusy === 'cancel_device' ? 'cancelling...' : 'cancel'}
                </button>
              </div>
            </div>
          ) : null}

          {cliConnected && !deviceFlow ? (
            <div style={{
              paddingTop: 14,
              paddingBottom: 14,
              paddingLeft: 14,
              paddingRight: 14,
              fontSize: 13,
              color: 'var(--t-text-secondary)',
              lineHeight: 1.55,
              maxWidth: 580,
            }}>
              Signed in as {activeAccount!.login}. Terminal git push and gh commands use this session. Disconnect above to sign in with a different account.
            </div>
          ) : null}
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="Repositories">
          {repos.length === 0 ? (
            <div style={{
              paddingTop: 14,
              paddingBottom: 14,
              paddingLeft: 14,
              paddingRight: 14,
              fontSize: 13,
              color: 'var(--t-text-muted)',
              lineHeight: 1.55,
              maxWidth: 580,
            }}>
              {appConnected
                ? 'The GitHub App is connected but repo sync hasn’t populated this list yet — it fills in shortly after install. If it stays empty, check which repos the App can access in GitHub settings.'
                : 'No tracked repositories yet. Connect the GitHub App below to pull in issues and open PRs from your repos.'}
            </div>
          ) : (
            <div>
              <div style={{ paddingTop: 10, paddingBottom: 6, paddingLeft: 14, paddingRight: 14 }}>
                <RamsButton variant="ghost" onClick={() => setReposExpanded((v) => !v)}>
                  {repos.length} tracked {repos.length === 1 ? 'repo' : 'repos'} {reposExpanded ? '—' : '+'}
                </RamsButton>
              </div>

              {reposExpanded ? (
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {repos.map((repo, idx) => (
                    <SettingsRow
                      key={repo.nameWithOwner}
                      icon={repo.isPrivate ? <LockIcon /> : <GlobeIcon />}
                      label={repo.nameWithOwner}
                      value={repo.updatedAt}
                      onPress={() => window.open(`https://github.com/${repo.nameWithOwner}`, '_blank', 'noopener,noreferrer')}
                      chevron
                      divider={idx < repos.length - 1}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="GitHub App">
          <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 10,
            }}>
              <span style={{
                fontSize: 15,
                fontWeight: 300,
                color: 'var(--t-text)',
                letterSpacing: '-0.01em',
              }}>
                o8 github app
              </span>
              <BracketLabel tone={appConnected ? 'quiet' : 'accent'}>
                {appConnected ? 'connected' : appConfigured ? 'needs attention' : 'not configured'}
              </BracketLabel>
            </div>

            <div style={{
              fontSize: 13,
              color: 'var(--t-text-secondary)',
              lineHeight: 1.55,
              maxWidth: 600,
              marginBottom: 16,
            }}>
              {appConnected && broker
                ? `App ${broker.appId} · installed on @${broker.installationAccount} · ${repoCount} ${repoCount === 1 ? 'repo' : 'repos'}.`
                : appConfigured
                  ? broker?.note ?? 'Diagnostics below show what still needs to be configured.'
                  : 'The product needs the GitHub App to read issues, open PRs, and act on your behalf. Set GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID and drop the PEM at ~/.o8/github-app.pem.'}
            </div>

            {appConfigured ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                marginBottom: 16,
                borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              }}>
                <DiagnosticRow
                  title="App key"
                  status={broker!.privateKeyConfigured ? 'ready' : 'missing'}
                  detail={broker!.privateKeyConfigured
                    ? `App ${broker!.appId ?? 'unknown'} can sign installation token requests.`
                    : 'Missing GitHub App private key at ~/.o8/github-app.pem.'}
                />
                <DiagnosticRow
                  title="Installation"
                  status={broker!.installationReachable ? 'ready' : 'missing'}
                  detail={broker!.installationReachable
                    ? `Installation ${broker!.installationId ?? 'unknown'} is healthy on ${broker!.probeRepo ?? 'the probe repo'}.`
                    : `Cannot reach installation for ${broker!.probeRepo ?? 'the configured repo'}.`}
                />
                {showProdDiagnostics ? (
                  <DiagnosticRow
                    title="Webhook secret"
                    status={broker!.webhookSecretConfigured ? 'ready' : 'missing'}
                    detail={broker!.webhookSecretConfigured
                      ? 'Webhook signature verification can be enforced in production.'
                      : 'Set GITHUB_APP_WEBHOOK_SECRET before enabling production webhooks.'}
                  />
                ) : null}
                {showProdDiagnostics ? (
                  <DiagnosticRow
                    title="Production URL"
                    status={broker!.publicBaseUrlConfigured ? 'ready' : 'missing'}
                    detail={broker!.publicBaseUrlConfigured
                      ? `Webhook target is ${broker!.webhookUrl ?? 'configured'}.`
                      : 'Set CORTEX_IDE_PUBLIC_BASE_URL when this installation is publicly reachable.'}
                  />
                ) : null}
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {broker?.installationId ? (
                <a
                  href={`https://github.com/settings/installations/${broker.installationId}`}
                  target="_blank"
                  rel="noreferrer"
                  style={primaryLinkStyle(false)}
                >
                  open installation ›
                </a>
              ) : null}
              <a
                href="https://github.com/settings/apps/cortex-dev-agent"
                target="_blank"
                rel="noreferrer"
                style={primaryLinkStyle(false)}
              >
                app settings ›
              </a>
            </div>
          </div>
        </SettingsGroup>
      </section>
    </div>
  );
}

// ── Support primitives ──

function AccountAvatar({ login }: { login: string }) {
  const letter = (login || '?').slice(0, 1).toUpperCase();
  return (
    <div style={{
      width: 36,
      height: 36,
      borderRadius: 18,
      border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
      background: 'transparent',
      color: 'var(--t-text-muted)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: MONO_FONT_STACK,
      fontSize: 14,
      fontWeight: 400,
      letterSpacing: '0.04em',
      flexShrink: 0,
    }}>
      {letter}
    </div>
  );
}

function DiagnosticRow({
  title,
  status,
  detail,
}: {
  title: string;
  status: 'ready' | 'partial' | 'missing';
  detail: string;
}) {
  const dotColor = status === 'ready'
    ? '#22c55e'
    : status === 'partial'
      ? '#f59e0b'
      : '#ef4444';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 14,
      paddingTop: 12,
      paddingBottom: 12,
      paddingLeft: 2,
      paddingRight: 2,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <div style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: dotColor,
        flexShrink: 0,
        marginTop: 8,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 11,
          fontWeight: 400,
          color: RAMS_INK_QUIET,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          marginBottom: 4,
        }}>
          {title}
        </div>
        <div style={{
          fontSize: 12,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 520,
        }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

// Symon-clean button shapes (system, sentence/title case, 32h, radius 9) —
// match the shared RamsButton. Was: mono / 11.5px / 350 / UPPERCASE / 44h.
function primaryLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_CONTROL_BORDER : RAMS_CONTROL_ACTIVE_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_ACTIVE_BG,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize',
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    textDecoration: 'none',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}

function quietActionStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: RAMS_CONTROL_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_BG,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize',
    color: 'var(--t-text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}
