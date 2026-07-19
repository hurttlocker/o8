'use client';

import { useState } from 'react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import type { O8AuthState } from '@/components/auth/O8AuthProvider';
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

/**
 * The props needed by the single GitHub connection surface in Git & PRs.
 * Identity, local gh access, and GitHub App automation stay separate
 * capabilities, but they are presented and managed in one place.
 */
export type GitHubConnectionProps = {
  auth: O8AuthState;
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
  const identityConnected = auth.signedIn || (!auth.clerkEnabled && connected);
  const identityName = auth.user?.name?.trim()
    || auth.user?.email?.trim()
    || activeAccount?.name
    || activeAccount?.login
    || 'GitHub';
  const identityAvatar = auth.user?.avatarUrl || activeAccount?.avatarUrl || null;
  const needsConnect = !connected || (auth.clerkEnabled && auth.isLoaded && !auth.signedIn);
  const connectDisabled = actionBusy === 'login_device'
    || (auth.clerkEnabled && !auth.isLoaded)
    || (auth.signedIn && !connected && !deviceFlowEnabled)
    || (!auth.clerkEnabled && !deviceFlowEnabled);

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

  // Priority: manage an existing installation → install the managed public
  // "o8" App (Cursor-style, one click) → BYO-app creation page. Never link a
  // specific app's settings page: those are only visible to the app's owner,
  // so any other account gets GitHub's 404 (report BBX85E).
  const managedInstall = !broker?.installationId && !!broker?.managedInstallUrl;
  const installUrl = broker?.installationId
    ? `https://github.com/settings/installations/${broker.installationId}`
    : broker?.managedInstallUrl || 'https://github.com/settings/apps/new';

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
                  {identityConnected || connected ? identityName : 'Connect GitHub'}
                </span>
                <ValuePill tone={identityConnected && connected ? 'success' : 'default'}>
                  {identityConnected && connected ? 'Connected' : 'Setup incomplete'}
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
            label="Identity"
            subtitle={identityConnected
              ? (auth.user?.email || `Signed in as ${identityName}`)
              : auth.clerkEnabled
                ? 'Sign in once to use the same identity across desktop and web'
                : connected
                  ? `Local identity from @${activeAccount!.login}`
                  : 'Identity sign-in is unavailable in this build'}
            accessory={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <ValuePill tone={identityConnected ? 'success' : 'default'}>
                  {identityConnected ? 'Connected' : 'Not connected'}
                </ValuePill>
                {auth.signedIn ? (
                  <>
                    <RamsButton variant="ghost" onClick={auth.openManageAccount}>Manage</RamsButton>
                    <RamsButton variant="ghost" onClick={() => { void auth.signOut(); }}>Sign out</RamsButton>
                  </>
                ) : null}
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
              : 'Higher rate limits plus issue and pull-request sync'}
            accessory={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <ValuePill tone={appConnected ? 'success' : 'default'}>
                  {appConnected ? 'Installed' : appConfigured ? 'Needs setup' : 'Not installed'}
                </ValuePill>
                <a href={installUrl} target="_blank" rel="noreferrer" style={primaryLinkStyle(false)}>
                  {appConnected ? 'Manage' : managedInstall ? 'Install' : 'Set up'}
                </a>
              </div>
            }
            divider={appConfigured && !appConnected}
          />

          {appConfigured && !appConnected ? (
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
          Connect GitHub once, then use the status rows above to see exactly which capabilities are ready on this machine. The automation app is optional.
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
