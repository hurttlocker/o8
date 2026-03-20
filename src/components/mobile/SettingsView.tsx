'use client';

import { useState, useEffect, useCallback, memo } from 'react';
import { useTheme } from './ThemeContext';

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const options: Array<{ value: 'light' | 'dark' | 'system'; label: string }> = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];

  return (
    <div style={{ marginBottom: 20 }}>
      <span style={{
        display: 'block', fontSize: 12, fontWeight: 700,
        color: '#8e8e93', textTransform: 'uppercase',
        letterSpacing: '0.04em', padding: '0 16px', marginBottom: 6,
      }}>
        Appearance
      </span>
      <div style={{
        borderRadius: 14,
        background: 'rgba(0,122,255,0.03)',
        border: '1px solid rgba(0,122,255,0.08)',
        overflow: 'hidden', padding: '10px 16px',
      }}>
        {/* iOS-style segmented control */}
        <div style={{
          display: 'flex', gap: 0,
          background: 'rgba(0,122,255,0.06)',
          borderRadius: 9, padding: 2,
        }}>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTheme(opt.value)}
              style={{
                flex: 1,
                padding: '7px 0',
                borderRadius: 7,
                border: 'none',
                background: theme === opt.value ? '#fff' : 'transparent',
                boxShadow: theme === opt.value ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                color: theme === opt.value ? '#007aff' : '#8e8e93',
                fontSize: 13, fontWeight: 600,
                fontFamily: '-apple-system, system-ui, sans-serif',
                cursor: 'pointer',
                transition: 'all 200ms ease',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface SettingsViewProps {
  onBack: () => void;
}

interface GatewayStatus {
  connected: boolean;
  url: string;
  version: string;
  agents: number;
}

interface GitHubStatus {
  authenticated: boolean;
  username: string;
  repos: number;
}

function SettingsGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <span style={{
        display: 'block',
        fontSize: 12, fontWeight: 700,
        color: '#8e8e93',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        padding: '0 4px',
        marginBottom: 6,
      }}>
        {label}
      </span>
      <div style={{
        borderRadius: 14,
        background: 'rgba(0,122,255,0.02)',
        border: '1px solid rgba(0,122,255,0.06)',
        overflow: 'hidden',
      }}>
        {children}
      </div>
    </section>
  );
}

function SettingsRow({ label, value, detail, action, destructive, last }: {
  label: string;
  value?: string;
  detail?: string;
  action?: () => void;
  destructive?: boolean;
  last?: boolean;
}) {
  const Component = action ? 'button' : 'div';

  return (
    <Component
      type={action ? 'button' : undefined}
      onClick={action}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '13px 16px',
        borderBottom: last ? 'none' : '1px solid rgba(0,0,0,0.04)',
        background: 'transparent',
        border: last ? 'none' : undefined,
        borderTop: 'none', borderLeft: 'none', borderRight: 'none',
        cursor: action ? 'pointer' : 'default',
        WebkitTapHighlightColor: 'transparent',
        textAlign: 'left',
      } as React.CSSProperties}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          fontSize: 15, fontWeight: 500,
          color: destructive ? '#ff3b30' : '#0a0a0a',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}>
          {label}
        </span>
        {detail && (
          <p style={{
            margin: '2px 0 0', fontSize: 12,
            color: '#8e8e93',
          }}>
            {detail}
          </p>
        )}
      </div>
      {value && (
        <span style={{
          fontSize: 14, color: '#8e8e93',
          fontFamily: '-apple-system, system-ui, sans-serif',
          marginLeft: 12, flexShrink: 0,
        }}>
          {value}
        </span>
      )}
      {action && !destructive && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="#c7c7cc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ marginLeft: 8, flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      )}
    </Component>
  );
}

function SettingsToggle({ label, detail, checked, onChange, last }: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (val: boolean) => void;
  last?: boolean;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '13px 16px',
      borderBottom: last ? 'none' : '1px solid rgba(0,0,0,0.04)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          fontSize: 15, fontWeight: 500, color: '#0a0a0a',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}>
          {label}
        </span>
        {detail && (
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#8e8e93' }}>
            {detail}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        style={{
          width: 51, height: 31,
          borderRadius: 16, border: 'none',
          background: checked ? '#007aff' : 'rgba(0,0,0,0.08)',
          position: 'relative',
          cursor: 'pointer',
          transition: 'background 200ms ease',
          flexShrink: 0, marginLeft: 12,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span style={{
          position: 'absolute',
          top: 2, left: checked ? 22 : 2,
          width: 27, height: 27,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          transition: 'left 200ms cubic-bezier(0.32, 0.72, 0, 1)',
        }} />
      </button>
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span style={{
      width: 8, height: 8, borderRadius: '50%',
      background: connected ? '#34c759' : '#ff3b30',
      boxShadow: connected ? '0 0 6px rgba(52,199,89,0.4)' : 'none',
      flexShrink: 0,
    }} />
  );
}

export const SettingsView = memo(function SettingsView({ onBack }: SettingsViewProps) {
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [github, setGitHub] = useState<GitHubStatus | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [sounds, setSounds] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [compactMode, setCompactMode] = useState(false);

  // Fetch gateway status
  useEffect(() => {
    fetch('/api/panel/status')
      .then(r => r.json())
      .then(data => {
        setGateway({
          connected: data.connected ?? true,
          url: data.gatewayUrl || 'localhost:18789',
          version: data.version || 'unknown',
          agents: data.agentCount ?? 0,
        });
      })
      .catch(() => setGateway({ connected: false, url: 'unknown', version: 'unknown', agents: 0 }));

    // GitHub status via gh
    fetch('/api/panel/github-status')
      .then(r => r.json())
      .then(data => setGitHub(data))
      .catch(() => setGitHub({ authenticated: false, username: '', repos: 0 }));
  }, []);

  const handleClearCache = useCallback(() => {
    sessionStorage.clear();
    window.location.reload();
  }, []);

  return (
    <div style={{
      padding: '0 14px 40px',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 8, marginBottom: 16,
      }}>
        <h2 style={{
          margin: 0, fontSize: 28, fontWeight: 800,
          fontFamily: '-apple-system, system-ui, sans-serif',
          color: '#0a0a0a', letterSpacing: '-0.03em',
        }}>
          Settings
        </h2>
        <button type="button" onClick={onBack} style={{
          padding: '6px 14px', borderRadius: 10,
          background: 'rgba(0,122,255,0.08)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(0,122,255,0.12)',
          color: '#007aff', fontSize: 13, fontWeight: 600,
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
        }}>
          Done
        </button>
      </div>

      {/* Connection */}
      <SettingsGroup label="Connection">
        <SettingsRow
          label="Gateway"
          value={gateway ? (gateway.connected ? 'Connected' : 'Offline') : '…'}
          detail={gateway ? `${gateway.url} · v${gateway.version}` : undefined}
        />
        <SettingsRow
          label="Agents"
          value={gateway ? `${gateway.agents}` : '…'}
          detail="Connected to gateway"
        />
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 16px',
        }}>
          <StatusDot connected={gateway?.connected ?? false} />
          <span style={{ fontSize: 12, color: '#8e8e93', fontWeight: 500 }}>
            {gateway?.connected ? 'Live connection to OpenClaw gateway' : 'Not connected'}
          </span>
        </div>
      </SettingsGroup>

      {/* GitHub */}
      <SettingsGroup label="GitHub">
        <SettingsRow
          label="Account"
          value={github?.authenticated ? github.username : 'Not connected'}
          detail={github?.authenticated ? `${github.repos} repositories` : 'Connect via gh auth login'}
        />
        <SettingsRow
          label="Repositories"
          value={github?.repos !== undefined ? `${github.repos}` : '…'}
          action={() => {}}
          last
        />
      </SettingsGroup>

      {/* Notifications */}
      <SettingsGroup label="Notifications">
        <SettingsToggle
          label="Push Notifications"
          detail="Agent completions, approvals, alerts"
          checked={notifications}
          onChange={setNotifications}
        />
        <SettingsToggle
          label="Sounds"
          detail="Play sound on new notifications"
          checked={sounds}
          onChange={setSounds}
          last
        />
      </SettingsGroup>

      {/* Chat */}
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

      {/* Appearance */}
      <AppearanceSection />

      {/* Runtimes */}
      <SettingsGroup label="Runtimes">
        <SettingsRow
          label="Codex"
          detail="OpenAI coding agent"
          action={() => {}}
        />
        <SettingsRow
          label="Claude Code"
          detail="Anthropic coding agent"
          action={() => {}}
        />
        <SettingsRow
          label="OpenClaw"
          detail="Gateway-managed agents"
          action={() => {}}
          last
        />
      </SettingsGroup>

      {/* Data */}
      <SettingsGroup label="Data">
        <SettingsRow
          label="Clear Cache"
          detail="Reset session storage and reload"
          action={handleClearCache}
        />
        <SettingsRow
          label="Export Logs"
          detail="Download session transcripts"
          action={() => {}}
          last
        />
      </SettingsGroup>

      {/* About */}
      <SettingsGroup label="About">
        <SettingsRow label="Version" value="1.0.0" />
        <SettingsRow label="OpenClaw" value={gateway?.version || '…'} />
        <SettingsRow
          label="Documentation"
          action={() => window.open('https://docs.openclaw.ai', '_blank')}
        />
        <SettingsRow
          label="GitHub"
          action={() => window.open('https://github.com/hurttlocker/cortex-ide', '_blank')}
          last
        />
      </SettingsGroup>

      {/* Danger zone */}
      <SettingsGroup label="">
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
