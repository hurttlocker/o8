'use client';

import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { initSounds, isSoundEnabled, setSoundEnabled } from '@/lib/mobile/sounds';
import { useTheme } from './ThemeContext';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface SettingsViewProps {
  onBack: () => void;
}

interface BackendStatus {
  connected: boolean;
  host: string | null;
  platform: string;
  nodeVersion: string;
  runtime: string;
}

interface GitHubStatus {
  authenticated: boolean;
  username: string;
  repos: number;
  broker?: {
    tokenReady: boolean;
    productionWebhookReady: boolean;
    note: string;
  } | null;
}

function sectionHeaderStyle(colors: ThemeColors, padding = '0 4px') {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    padding,
    marginBottom: 8,
  };
}

function AppearanceSection() {
  const { theme, setTheme, colors } = useTheme();
  const options: Array<{ value: 'light' | 'dark' | 'system'; label: string }> = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];

  return (
    <div style={{ marginBottom: 20 }}>
      <span style={sectionHeaderStyle(colors, '0 4px')}>Appearance</span>
      <div
        style={{
          borderRadius: 14,
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          overflow: 'hidden',
          padding: '10px 12px',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: 4,
            borderRadius: 12,
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${colors.border}`,
          }}
        >
          {options.map((option) => {
            const active = theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setTheme(option.value)}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 12,
                  border: active ? `1px solid ${colors.blueGlassBorder}` : '1px solid transparent',
                  background: active ? colors.blueGlass : 'transparent',
                  color: active ? colors.text : colors.textSecondary,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p style={{ margin: '10px 4px 0', fontSize: 12, color: colors.textTertiary, lineHeight: 1.4 }}>
          Mobile surfaces are currently dark-only. Appearance selection is retained for parity.
        </p>
      </div>
    </div>
  );
}

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  const { colors } = useTheme();

  return (
    <section style={{ marginBottom: 20 }}>
      {label ? <span style={sectionHeaderStyle(colors)}>{label}</span> : null}
      <div
        style={{
          borderRadius: 14,
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  label,
  value,
  detail,
  action,
  destructive,
  last,
}: {
  label: string;
  value?: string;
  detail?: string;
  action?: () => void;
  destructive?: boolean;
  last?: boolean;
}) {
  const { colors } = useTheme();
  const sharedStyle = {
    width: '100%',
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '13px 16px',
    borderBottom: last ? 'none' : `1px solid ${colors.border}`,
    background: 'transparent',
    borderTop: 'none',
    borderLeft: 'none',
    borderRight: 'none',
    cursor: action ? 'pointer' : 'default',
    WebkitTapHighlightColor: 'transparent',
    textAlign: 'left' as const,
  };

  if (action) {
    return (
      <button type="button" onClick={action} style={sharedStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: destructive ? colors.red : colors.text }}>
            {label}
          </span>
          {detail ? (
            <p style={{ margin: '3px 0 0', fontSize: 12, color: colors.textSecondary, lineHeight: 1.4 }}>
              {detail}
            </p>
          ) : null}
        </div>
        {value ? (
          <span style={{ fontSize: 14, color: colors.textSecondary, flexShrink: 0 }}>{value}</span>
        ) : null}
        {!destructive ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke={colors.textTertiary}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        ) : null}
      </button>
    );
  }

  return (
    <div style={sharedStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 500, color: destructive ? colors.red : colors.text }}>
          {label}
        </span>
        {detail ? (
          <p style={{ margin: '3px 0 0', fontSize: 12, color: colors.textSecondary, lineHeight: 1.4 }}>
            {detail}
          </p>
        ) : null}
      </div>
      {value ? <span style={{ fontSize: 14, color: colors.textSecondary, flexShrink: 0 }}>{value}</span> : null}
    </div>
  );
}

function SettingsToggle({
  label,
  detail,
  checked,
  onChange,
  last,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  const { colors } = useTheme();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '13px 16px',
        borderBottom: last ? 'none' : `1px solid ${colors.border}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>{label}</span>
        {detail ? (
          <p style={{ margin: '3px 0 0', fontSize: 12, color: colors.textSecondary, lineHeight: 1.4 }}>
            {detail}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        style={{
          width: 52,
          minHeight: 32,
          borderRadius: 999,
          border: 'none',
          background: checked ? colors.blueAccent : 'rgba(255,255,255,0.12)',
          position: 'relative',
          cursor: 'pointer',
          flexShrink: 0,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 22 : 2,
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: colors.text,
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
          }}
        />
      </button>
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: connected ? '#30d158' : '#ff453a',
        boxShadow: connected ? '0 0 0 4px rgba(48,209,88,0.12)' : '0 0 0 4px rgba(255,69,58,0.12)',
        flexShrink: 0,
      }}
    />
  );
}

export const SettingsView = memo(function SettingsView({ onBack }: SettingsViewProps) {
  const { colors } = useTheme();
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [github, setGitHub] = useState<GitHubStatus | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [sounds, setSounds] = useState(() => {
    if (typeof window === 'undefined') {
      return true;
    }
    initSounds();
    return isSoundEnabled();
  });
  const [autoScroll, setAutoScroll] = useState(true);
  const [compactMode, setCompactMode] = useState(false);

  useEffect(() => {
    fetch('/api/panel/status')
      .then((response) => response.json())
      .then((data) => {
        setBackend({
          connected: true,
          host: typeof window !== 'undefined' ? window.location.host : null,
          platform: data.platform ?? 'unknown',
          nodeVersion: data.nodeVersion ?? 'unknown',
          runtime: data.runtime ?? 'codex+claude-code',
        });
      })
      .catch(() =>
        setBackend({
          connected: false,
          host: null,
          platform: 'unknown',
          nodeVersion: 'unknown',
          runtime: 'unknown',
        })
      );

    fetch('/api/panel/github-status')
      .then((response) => response.json())
      .then((data) => setGitHub(data))
      .catch(() => setGitHub({ authenticated: false, username: '', repos: 0 }));
  }, []);

  const handleSoundsChange = useCallback((enabled: boolean) => {
    setSounds(enabled);
    setSoundEnabled(enabled);
  }, []);

  const handleClearCache = useCallback(() => {
    sessionStorage.clear();
    window.location.reload();
  }, []);

  return (
    <div
      style={{
        padding: '0 14px 40px',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        minHeight: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 8,
          marginBottom: 16,
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: colors.text, letterSpacing: '-0.03em' }}>
          Settings
        </h2>
        <button
          type="button"
          onClick={onBack}
          style={{
            minHeight: 44,
            padding: '0 16px',
            borderRadius: 12,
            border: 'none',
            background: colors.blueAccent,
            color: colors.text,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Done
        </button>
      </div>

      <SettingsGroup label="Connection">
        <SettingsRow
          label="Backend"
          value={backend ? (backend.connected ? 'Connected' : 'Offline') : '...'}
          detail={backend?.host ?? undefined}
        />
        <SettingsRow
          label="Runtime"
          value={backend?.runtime ?? '...'}
          detail={backend ? `${backend.platform} · node ${backend.nodeVersion}` : undefined}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
          <StatusDot connected={backend?.connected ?? false} />
          <span style={{ fontSize: 12, color: colors.textSecondary, fontWeight: 500 }}>
            {backend?.connected ? 'Desktop runtime bridge available' : 'Not connected'}
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup label="GitHub">
        <SettingsRow
          label="Account"
          value={github?.authenticated ? github.username : 'Not connected'}
          detail={github?.authenticated ? `${github.repos} repositories` : 'Connect via gh auth login'}
        />
        <SettingsRow
          label="Broker"
          value={github?.broker?.tokenReady ? 'Ready' : 'Needs setup'}
          detail={github?.broker?.note ?? 'GitHub App broker status unavailable'}
        />
        <SettingsRow
          label="Webhooks"
          value={github?.broker?.productionWebhookReady ? 'Ready' : 'Blocked'}
          detail={
            github?.broker?.productionWebhookReady
              ? 'Production webhook sync can be completed.'
              : 'Waiting on production public URL and webhook secret.'
          }
        />
        <SettingsRow
          label="Repositories"
          value={github?.repos !== undefined ? `${github.repos}` : '...'}
          action={() => {}}
          last
        />
      </SettingsGroup>

      <SettingsGroup label="Notifications">
        <SettingsToggle
          label="Push Notifications"
          detail="Agent completions, approvals, alerts"
          checked={notifications}
          onChange={setNotifications}
        />
        <SettingsToggle
          label="Sounds"
          detail="Play sound on send and new notifications"
          checked={sounds}
          onChange={handleSoundsChange}
          last
        />
      </SettingsGroup>

      <SettingsGroup label="Chat">
        <SettingsToggle
          label="Auto-scroll"
          detail="Scroll to bottom on new messages"
          checked={autoScroll}
          onChange={setAutoScroll}
        />
        <SettingsToggle
          label="Compact Mode"
          detail="Reduce spacing between messages"
          checked={compactMode}
          onChange={setCompactMode}
          last
        />
      </SettingsGroup>

      <AppearanceSection />

      <SettingsGroup label="Runtimes">
        <SettingsRow label="Codex" detail="OpenAI coding agent" action={() => {}} />
        <SettingsRow label="Claude Code" detail="Anthropic coding agent" action={() => {}} last />
      </SettingsGroup>

      <SettingsGroup label="Data">
        <SettingsRow
          label="Clear Cache"
          detail="Reset session storage and reload"
          action={handleClearCache}
        />
        <SettingsRow label="Export Logs" detail="Download session transcripts" action={() => {}} last />
      </SettingsGroup>

      <SettingsGroup label="About">
        <SettingsRow label="Version" value="1.0.0" />
        <SettingsRow
          label="Documentation"
          action={() =>
            window.open(
              process.env.NEXT_PUBLIC_REPO_URL || 'https://github.com/hurttlocker/cortex-ide',
              '_blank'
            )
          }
        />
        <SettingsRow
          label="GitHub"
          action={() =>
            window.open(
              process.env.NEXT_PUBLIC_REPO_URL || 'https://github.com/hurttlocker/cortex-ide',
              '_blank'
            )
          }
          last
        />
      </SettingsGroup>

      <SettingsGroup label="Danger Zone">
        <SettingsRow
          label="Reset All Settings"
          destructive
          action={() => {
            if (confirm('Reset all settings to defaults?')) {
              localStorage.clear();
              sessionStorage.clear();
              window.location.reload();
            }
          }}
          last
        />
      </SettingsGroup>
    </div>
  );
});
