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
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  FieldLabel,
  GitHubIcon,
  GitHubAvatar,
  RamsButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow, ValuePill, GroupFootnote } from './grouped';

/**
 * The props needed to render the GitHub CONNECTION surface — the identity
 * card / sign-in flow / GitHub App block. Shared verbatim between the standalone
 * GitHubTab wrapper and the merged Git & PRs tab so SettingsPage wires the same
 * bundle to either. The repositories list is intentionally NOT here — it moved
 * to the Projects surface — but `repoCount` stays for the App footnote.
 */
export type GitHubConnectionProps = {
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
  onStartDeviceFlow?: () => void;
  onPollDeviceFlow?: (flowId: string) => void;
  onCancelDeviceFlow?: (flowId: string) => void;
};

/**
 * The GitHub connection surface, standalone from any page chrome — identity /
 * sign-in / GitHub App. Renders its own loading + action-feedback lines so it
 * can drop into either the legacy GitHubTab or the merged Git & PRs tab.
 */
export function GitHubConnectionSections({
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
  onStartDeviceFlow,
  onPollDeviceFlow,
  onCancelDeviceFlow,
}: GitHubConnectionProps) {
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenValue, setTokenValue] = useState('');

  const activeAccount = accounts.find((a) => a.active) ?? null;
  const connected = !!activeAccount;

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

      {/* ── Identity (connected) ── */}
      {connected ? (
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
              <GitHubAvatar avatarUrl={activeAccount!.avatarUrl} login={activeAccount!.login} size={44} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 16,
                    fontWeight: 500,
                    letterSpacing: '-0.01em',
                    color: 'var(--t-text)',
                  }}>
                    {activeAccount!.login}
                  </span>
                  <ValuePill tone="success">Connected</ValuePill>
                </div>
                {activeAccount!.name ? (
                  <span style={{ fontSize: 12.5, fontWeight: 300, color: 'var(--t-text-faint)' }}>
                    {activeAccount!.name}
                  </span>
                ) : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
                  onClick={() => onDisconnect?.(activeAccount!.login)}
                  disabled={actionBusy === 'logout'}
                  busy={actionBusy === 'logout'}
                >
                  Disconnect
                </RamsButton>
              </div>
            </div>
          </SettingsGroup>
          <GroupFootnote>Repo access for this machine — terminal git, gh, and dispatched agents push with this credential. It is separate from your o8 account (General), which identifies you but can never touch your repos.</GroupFootnote>
        </section>
      ) : (
        /* ── Sign in (disconnected) ── */
        <section>
          <SettingsGroup header="Sign in">
            {!deviceFlow ? (
              <SettingsRow
                icon={<GitHubIcon size={16} />}
                label="Sign in with GitHub"
                subtitle={deviceFlowEnabled ? 'Open GitHub and approve o8' : 'Not available on this build'}
                onPress={onStartDeviceFlow}
                disabled={!deviceFlowEnabled || actionBusy === 'login_device'}
                chevron
                divider
              />
            ) : (
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
                  <div style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: 'var(--t-text-secondary)',
                    lineHeight: 1.55,
                    maxWidth: 560,
                  }}>
                    {deviceFlow.note || 'Waiting for you to approve o8 on GitHub.'} Expires in about {deviceFlow.expiresInMinutes} minute{deviceFlow.expiresInMinutes === 1 ? '' : 's'}.
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <RamsButton
                    variant="ghost"
                    onClick={() => openExternalUrl(deviceFlow.verificationUriComplete || deviceFlow.verificationUri)}
                  >
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
            )}

            {/* Quiet fallback: access token */}
            {!deviceFlow ? (
              <>
                <SettingsRow
                  label="Use an access token instead"
                  onPress={() => setTokenOpen((v) => !v)}
                  value={tokenOpen ? 'Hide' : 'Show'}
                  divider={tokenOpen}
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
                      onChange={(e) => setTokenValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitToken(); }}
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
          </SettingsGroup>
          <GroupFootnote>
            {deviceFlowEnabled
              ? 'Signing in lets o8 read your repositories and act on your behalf.'
              : 'Device sign-in isn’t set up on this build — paste an access token to connect.'}
          </GroupFootnote>
        </section>
      )}

      {/* ── GitHub App ── */}
      <section style={{ marginTop: 28 }}>
        <SettingsGroup header="GitHub App">
          <SettingsRow
            icon={<GitHubIcon size={16} />}
            label="GitHub App"
            subtitle="Higher rate limits, issue and PR sync"
            accessory={
              <ValuePill tone={appConnected ? 'success' : 'default'}>
                {appConnected ? 'Installed' : appConfigured ? 'Needs setup' : 'Not installed'}
              </ValuePill>
            }
            divider
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

          <div style={{
            paddingTop: 12,
            paddingBottom: 14,
            paddingLeft: 14,
            paddingRight: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap',
          }}>
            <a
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              style={primaryLinkStyle(false)}
            >
              {appConnected ? 'Manage on GitHub' : managedInstall ? 'Install the o8 GitHub App' : 'Set up on GitHub'}
            </a>
          </div>
        </SettingsGroup>
        <GroupFootnote>
          {appConnected && broker
            ? `Installed on @${broker.installationAccount} · ${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}.`
            : appConfigured
              ? 'Finish the checks above to bring the App online.'
              : managedInstall
                ? 'One click on GitHub: pick your repos and o8 gets higher rate limits plus issue and PR sync. You can change repos any time.'
                : 'Optional: create your own GitHub App for higher rate limits, then point o8 at it with GITHUB_APP_ID and ~/.o8/github-app.pem. Signing in above is all most setups need.'}
        </GroupFootnote>
      </section>
    </>
  );
}

/**
 * Legacy standalone GitHub settings tab — a thin page-chrome wrapper around
 * GitHubConnectionSections. Kept assignable from SettingsPage's current call
 * (repos / onSwitchAccount are accepted and ignored) until the merged Git & PRs
 * tab fully supersedes it and the nav entry is removed.
 */
export function GitHubTab(props: GitHubConnectionProps & {
  repos?: GitHubRepo[];
  onSwitchAccount?: (user: string) => void;
}) {
  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="connectors"
        subtitle="Connect GitHub so o8 can track your repositories, issues, and pull requests."
      />
      <GitHubConnectionSections {...props} />
    </div>
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
