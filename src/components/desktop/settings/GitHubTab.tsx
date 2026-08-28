'use client';

import { useState } from 'react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import type { O8AuthState } from '@/components/auth/O8AuthProvider';
import { requestO8Capability } from '@/lib/auth/capabilities';
import {
  type GitHubAccount,
  type GitHubBrokerStatus,
  type GitHubDeviceFlowState,
  type GitHubActionKind,
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  FieldLabel,
  GitHubIcon,
  GitHubAvatar,
  RamsButton,
} from './shared';
import { SettingsGroup, SettingsRow, ValuePill, GroupFootnote } from './grouped';

const MANAGED_APP_UPGRADE_URL = 'https://o8.run/pricing';
const LOCAL_GITHUB_APP_SETUP_URL = 'https://github.com/settings/apps/new';

/**
 * The props needed by the single GitHub connection surface in Git & PRs.
 * Identity, local gh access, and GitHub App automation stay separate
 * capabilities, but they are presented and managed in one place.
 */
export type GitHubConnectionProps = {
  auth: O8AuthState;
  /** Hosted App tokens are a paid service; local GitHub access remains free. */
  managedAppEntitled: boolean;
  accounts: GitHubAccount[];
  repoCount: number;
  broker: GitHubBrokerStatus | null;
  loading: boolean;
  actionBusy?: GitHubActionKind | null;
  actionNote?: string | null;
  onRefresh?: () => void;
  onDisconnect?: (user: string) => void;
  onLoginWithToken?: (token: string) => void;
  deviceFlowEnabled?: boolean;
  deviceFlow?: GitHubDeviceFlowState | null;
  onConnect?: () => void;
  onPollDeviceFlow?: (flowId: string) => void;
  onCancelDeviceFlow?: (flowId: string) => void;
};

/**
 * The GitHub connection surface: one connected identity and three explicit
 * capability rows, with device flow and PAT fallback inline.
 */
export function GitHubConnectionSections({
  auth,
  managedAppEntitled,
  accounts,
  repoCount,
  broker,
  loading,
  actionBusy,
  actionNote,
  onRefresh,
  onDisconnect,
  onLoginWithToken,
  deviceFlowEnabled,
  deviceFlow,
  onConnect,
  onPollDeviceFlow,
  onCancelDeviceFlow,
}: GitHubConnectionProps) {
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenValue, setTokenValue] = useState('');

  const activeAccount = accounts.find((a) => a.active) ?? null;
  const connected = !!activeAccount;
  const identityName = activeAccount?.name
    || activeAccount?.login
    || 'GitHub';
  const identityAvatar = activeAccount?.avatarUrl || null;
  const needsConnect = !connected;
  const connectDisabled = actionBusy === 'login_device'
    || !deviceFlowEnabled;

  const appConfigured = !!(broker && broker.configured);
  const localAppConfigured = appConfigured && broker?.managed !== true;
  const appConnected = !!(broker
    && broker.tokenReady
    && broker.installationReachable
    && broker.privateKeyConfigured
    && (broker.managed !== true || managedAppEntitled));
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

  function submitToken() {
    const trimmed = tokenValue.trim();
    if (!trimmed) return;
    onLoginWithToken?.(trimmed);
    setTokenValue('');
  }

  if (loading) {
    return (
      <div style={{
        paddingTop: 40,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Checking your GitHub connection…
      </div>
    );
  }

  // Managed install and local App setup are separate actions. A missing hosted
  // install URL must never fall through to GitHub's create-App page.
  const managedInstallUrl = broker?.managedInstallUrl || null;
  const managedInstall = managedAppEntitled
    && !broker?.installationId
    && !!managedInstallUrl;
  const manageInstallationUrl = broker?.installationId
    ? `https://github.com/settings/installations/${broker.installationId}`
    : 'https://github.com/settings/installations';

  function useManagedApp() {
    if (!managedAppEntitled || !managedInstallUrl) return;
    requestO8Capability({
      capability: 'github.managed',
      signedIn: auth.signedIn,
      onAccountRequired: auth.signIn,
      onReady: () => openExternalUrl(managedInstallUrl),
    });
  }

  return (
    <>
      {actionNote ? (
        <div style={{
          marginBottom: 28,
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          fontFamily: APP_FONT_STACK,
          lineHeight: 1.5,
        }}>
          {actionNote}
        </div>
      ) : null}
      <section>
        <SettingsGroup header="GitHub">
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            paddingTop: 14,
            paddingBottom: 14,
            paddingLeft: 14,
            paddingRight: 14,
            flexWrap: 'wrap',
          }}>
            {identityAvatar ? (
              <GitHubAvatar avatarUrl={identityAvatar} login={identityName} size={44} />
            ) : (
              <span style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--t-bg-card)',
                color: 'var(--t-text-muted)',
              }}>
                <GitHubIcon size={20} />
              </span>
            )}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-0.01em', color: 'var(--t-text)' }}>
                  {connected ? identityName : 'Connect GitHub'}
                </span>
                <ValuePill tone={connected ? 'success' : 'default'}>
                  {connected ? 'Connected' : 'Not connected'}
                </ValuePill>
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 300, color: 'var(--t-text-faint)' }}>
                One place for your identity, local repo access, and GitHub automation.
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {needsConnect ? (
                <RamsButton
                  variant="primary"
                  onClick={onConnect}
                  disabled={connectDisabled}
                  busy={actionBusy === 'login_device'}
                >
                  Connect GitHub
                </RamsButton>
              ) : null}
              <RamsButton
                variant="ghost"
                onClick={onRefresh}
                disabled={actionBusy === 'refresh'}
                busy={actionBusy === 'refresh'}
              >
                Refresh
              </RamsButton>
            </div>
          </div>

          <SettingsRow
            icon={<GitHubIcon size={16} />}
            label="GitHub identity"
            subtitle={connected
              ? `Connected locally as @${activeAccount!.login}`
              : 'Connect only this machine; an o8 account is not required'}
            accessory={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <ValuePill tone={connected ? 'success' : 'default'}>
                  {connected ? 'Connected' : 'Not connected'}
                </ValuePill>
              </div>
            }
            divider
          />

          <SettingsRow
            icon={<GitHubIcon size={16} />}
            label="Repository & CLI access"
            subtitle={connected
              ? `gh, terminal git, and dispatched agents use @${activeAccount!.login}`
              : 'Authorize this machine to clone, push, and manage repositories'}
            accessory={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <ValuePill tone={connected ? 'success' : 'default'}>
                  {connected ? 'Connected' : 'Not connected'}
                </ValuePill>
                {connected ? (
                  <RamsButton
                    variant="ghost"
                    onClick={() => onDisconnect?.(activeAccount!.login)}
                    disabled={actionBusy === 'logout'}
                    busy={actionBusy === 'logout'}
                  >
                    Disconnect
                  </RamsButton>
                ) : null}
              </div>
            }
            divider
          />

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
                <FieldLabel>enter this code on github</FieldLabel>
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
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55, maxWidth: 560 }}>
                  {deviceFlow.note || 'Waiting for you to approve o8 on GitHub.'} Expires in about {deviceFlow.expiresInMinutes} minute{deviceFlow.expiresInMinutes === 1 ? '' : 's'}.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <RamsButton variant="ghost" onClick={() => openExternalUrl(deviceFlow.verificationUriComplete || deviceFlow.verificationUri)}>
                  Open GitHub
                </RamsButton>
                <RamsButton variant="ghost" onClick={() => { void copyDeviceCode(); }}>
                  {deviceCodeCopied ? 'Copied' : 'Copy code'}
                </RamsButton>
                <RamsButton variant="ghost" onClick={() => onPollDeviceFlow?.(deviceFlow.flowId)}>
                  Check now
                </RamsButton>
                <RamsButton
                  variant="ghost"
                  onClick={() => onCancelDeviceFlow?.(deviceFlow.flowId)}
                  disabled={actionBusy === 'cancel_device'}
                  busy={actionBusy === 'cancel_device'}
                >
                  {actionBusy === 'cancel_device' ? 'Cancelling…' : 'Cancel'}
                </RamsButton>
              </div>
            </div>
          ) : null}

          {!connected && !deviceFlow ? (
            <>
              <SettingsRow
                label="Use an access token instead"
                onPress={() => setTokenOpen((value) => !value)}
                value={tokenOpen ? 'Hide' : 'Show'}
                divider
              />
              {tokenOpen ? (
                <div style={{
                  paddingTop: 12,
                  paddingBottom: 14,
                  paddingLeft: 14,
                  paddingRight: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}>
                  <input
                    type="password"
                    value={tokenValue}
                    onChange={(event) => setTokenValue(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') submitToken(); }}
                    placeholder="ghp_…"
                    autoComplete="off"
                    spellCheck={false}
                    style={{
                      width: '100%',
                      maxWidth: 420,
                      height: 34,
                      paddingLeft: 12,
                      paddingRight: 12,
                      borderRadius: 9,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: RAMS_CONTROL_BORDER,
                      background: 'var(--t-input-bg, var(--t-bg-card))',
                      color: 'var(--t-text)',
                      fontFamily: MONO_FONT_STACK,
                      fontSize: 13,
                      outline: 'none',
                    }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <RamsButton
                      onClick={submitToken}
                      disabled={!tokenValue.trim() || actionBusy === 'login_token'}
                      busy={actionBusy === 'login_token'}
                    >
                      Connect
                    </RamsButton>
                    <span style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text-faint)', lineHeight: 1.5 }}>
                      A personal access token with repo access.
                    </span>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          <SettingsRow
            icon={<GitHubIcon size={16} />}
            label="Automation app"
            subtitle={appConnected
              ? `Installed on @${broker?.installationAccount} for ${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}`
              : localAppConfigured
                ? 'Finish the local GitHub App setup on this machine'
                : !managedAppEntitled
                  ? 'Managed issue and pull-request sync is included with Pro; local setup stays free'
                  : managedInstall
                    ? 'Install the managed App for issue and pull-request sync'
                    : 'Sign in with your paid o8 account to load the managed installation'}
            accessory={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <ValuePill tone={appConnected ? 'success' : 'default'}>
                  {appConnected
                    ? 'Installed'
                    : localAppConfigured
                      ? 'Needs setup'
                      : managedAppEntitled
                        ? 'Not installed'
                        : 'Pro'}
                </ValuePill>
                {appConnected ? (
                  <a href={manageInstallationUrl} target="_blank" rel="noreferrer" style={primaryLinkStyle(false)}>
                    Manage
                  </a>
                ) : localAppConfigured ? (
                  <a href={LOCAL_GITHUB_APP_SETUP_URL} target="_blank" rel="noreferrer" style={primaryLinkStyle(false)}>
                    Set up
                  </a>
                ) : !managedAppEntitled ? (
                  <>
                    <RamsButton variant="ghost" onClick={() => openExternalUrl(MANAGED_APP_UPGRADE_URL)}>
                      Upgrade
                    </RamsButton>
                    <a href={LOCAL_GITHUB_APP_SETUP_URL} target="_blank" rel="noreferrer" style={primaryLinkStyle(false)}>
                      Set up locally
                    </a>
                  </>
                ) : managedInstall ? (
                  <RamsButton variant="ghost" onClick={useManagedApp}>Install</RamsButton>
                ) : (
                  <>
                    {!auth.signedIn && auth.clerkEnabled ? (
                      <RamsButton variant="ghost" onClick={auth.signIn}>Sign in</RamsButton>
                    ) : null}
                    <a href={LOCAL_GITHUB_APP_SETUP_URL} target="_blank" rel="noreferrer" style={primaryLinkStyle(false)}>
                      Set up locally
                    </a>
                  </>
                )}
              </div>
            }
            divider={localAppConfigured && !appConnected}
          />

          {localAppConfigured && !appConnected ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <DiagnosticRow
                title="App key"
                status={broker!.privateKeyConfigured ? 'ready' : 'missing'}
                detail={broker!.privateKeyConfigured
                  ? 'The app can sign in to GitHub.'
                  : 'Add the GitHub App private key at ~/.o8/github-app.pem.'}
              />
              <DiagnosticRow
                title="Installation"
                status={broker!.installationReachable ? 'ready' : 'missing'}
                detail={broker!.installationReachable
                  ? 'The installation is reachable and healthy.'
                  : `Can’t reach the installation for ${broker!.probeRepo ?? 'the configured repo'}.`}
              />
              {showProdDiagnostics ? (
                <DiagnosticRow
                  title="Webhook secret"
                  status={broker!.webhookSecretConfigured ? 'ready' : 'missing'}
                  detail={broker!.webhookSecretConfigured
                    ? 'Webhook signatures can be verified.'
                    : 'Set GITHUB_APP_WEBHOOK_SECRET before enabling production webhooks.'}
                />
              ) : null}
              {showProdDiagnostics ? (
                <DiagnosticRow
                  title="Public URL"
                  status={broker!.publicBaseUrlConfigured ? 'ready' : 'missing'}
                  detail={broker!.publicBaseUrlConfigured
                    ? `Webhooks point at ${broker!.webhookUrl ?? 'the configured URL'}.`
                    : 'Set CORTEX_IDE_PUBLIC_BASE_URL when this install is publicly reachable.'}
                />
              ) : null}
            </div>
          ) : null}
        </SettingsGroup>
        <GroupFootnote>
          The local connection stays on this machine and does not require an o8 account. The managed Automation app is included with paid plans.
        </GroupFootnote>
      </section>
    </>
  );
}

// ── Support primitives ──

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
      gap: 12,
      paddingTop: 10,
      paddingBottom: 10,
      paddingLeft: 14,
      paddingRight: 14,
      borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <div style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: dotColor,
        flexShrink: 0,
        marginTop: 6,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 11,
          fontWeight: 400,
          color: RAMS_INK_QUIET,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          marginBottom: 3,
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

// Symon-clean button shape (system, sentence case, 32h, radius 9) — matches RamsButton.
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
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    textDecoration: 'none',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}
