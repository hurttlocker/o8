'use client';

/**
 * SettingsPage — Full workspace settings panel.
 *
 * First tab: GitHub connection status + account management.
 * Future tabs: Slack, Linear, Vault config, Agent defaults, etc.
 */

import { useState, useEffect, useCallback } from 'react';

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

type SettingsTab = 'github' | 'agents' | 'appearance' | 'about';

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
        color: active ? '#2563eb' : '#6b7280',
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

// ── GitHub Tab Content ──

function GitHubTab({ accounts, repos, loading }: {
  accounts: GitHubAccount[];
  repos: GitHubRepo[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
        Checking GitHub connection...
      </div>
    );
  }

  const activeAccount = accounts.find(a => a.active);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Connection Status */}
      <div style={{
        background: '#fff',
        borderRadius: 14,
        padding: 20,
        border: '1px solid rgba(0,0,0,0.06)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <div style={{ color: '#111827' }}><GitHubIcon size={24} /></div>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>GitHub</h3>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto',
            padding: '4px 10px', borderRadius: 8,
            background: 'rgba(34, 197, 94, 0.08)', color: '#22c55e',
            fontSize: 11, fontWeight: 600,
          }}>
            <CheckCircleIcon />
            Connected
          </div>
        </div>

        {/* Accounts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {accounts.map((acct) => (
            <div key={acct.login} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: 12,
              borderRadius: 10,
              background: acct.active ? 'rgba(37, 99, 235, 0.04)' : 'rgba(0,0,0,0.02)',
              border: acct.active ? '1px solid rgba(37, 99, 235, 0.15)' : '1px solid rgba(0,0,0,0.04)',
            }}>
              {/* Avatar */}
              <img
                src={acct.avatarUrl}
                alt={acct.login}
                width={36}
                height={36}
                style={{ borderRadius: 18, border: '2px solid rgba(0,0,0,0.06)' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{acct.login}</span>
                  {acct.name && <span style={{ fontSize: 11, color: '#9ca3af' }}>({acct.name})</span>}
                  {acct.active && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                      padding: '1px 6px', borderRadius: 4,
                      background: '#2563eb', color: '#fff',
                    }}>
                      Active
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
                  Protocol: {acct.protocol} · {acct.scopes.length} scopes
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Scopes */}
        {activeAccount && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
              Token Scopes
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {activeAccount.scopes.map((s) => <ScopeBadge key={s} scope={s} />)}
            </div>
          </div>
        )}
      </div>

      {/* Connected Repositories */}
      <div style={{
        background: '#fff',
        borderRadius: 14,
        padding: 20,
        border: '1px solid rgba(0,0,0,0.06)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: '#111827', margin: 0 }}>
            Repositories
          </h3>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>{repos.length} repos</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {repos.map((repo) => (
            <div key={repo.nameWithOwner} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px',
              borderRadius: 8,
              transition: 'background 80ms',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.02)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ color: repo.isPrivate ? '#f59e0b' : '#22c55e' }}>
                {repo.isPrivate ? <LockIcon /> : <GlobeIcon />}
              </div>
              <span style={{ fontSize: 12, fontWeight: 500, color: '#374151', flex: 1 }}>
                {repo.nameWithOwner}
              </span>
              <span style={{ fontSize: 10, color: '#b0b8c4' }}>
                {repo.updatedAt}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Placeholder Tabs ──

function PlaceholderTab({ title, description }: { title: string; description: string }) {
  return (
    <div style={{
      background: '#fff',
      borderRadius: 14,
      padding: 32,
      border: '1px solid rgba(0,0,0,0.06)',
      textAlign: 'center',
    }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: '0 0 6px' }}>{title}</h3>
      <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>{description}</p>
    </div>
  );
}

// ── Main Settings Page ──

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('github');
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);

  // Fetch GitHub status on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/panel/github-status');
        if (!res.ok) throw new Error('Failed to fetch');
        const data = await res.json();
        if (!cancelled) {
          setAccounts(data.accounts || []);
          setRepos(data.repos || []);
        }
      } catch {
        // Fallback — show empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: 24,
      background: 'linear-gradient(180deg, #f0f4f8 0%, #e8edf4 100%)',
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
          color: '#9ca3af',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          padding: '8px 14px',
          marginBottom: 4,
        }}>
          Settings
        </div>
        <TabButton label="GitHub" icon={<GitHubIcon size={16} />} active={activeTab === 'github'} onClick={() => setActiveTab('github')} />
        <TabButton label="Agents" icon={<UsersIcon />} active={activeTab === 'agents'} onClick={() => setActiveTab('agents')} />
        <TabButton label="Appearance" icon={<PaletteIcon />} active={activeTab === 'appearance'} onClick={() => setActiveTab('appearance')} />
        <TabButton label="About" icon={<InfoIcon />} active={activeTab === 'about'} onClick={() => setActiveTab('about')} />
      </div>

      {/* Right content */}
      <div style={{ flex: 1, minWidth: 0, maxWidth: 640 }}>
        {activeTab === 'github' && (
          <GitHubTab accounts={accounts} repos={repos} loading={loading} />
        )}
        {activeTab === 'agents' && (
          <PlaceholderTab title="Agent Configuration" description="Configure default models, heartbeat intervals, and agent-specific settings. Coming soon." />
        )}
        {activeTab === 'appearance' && (
          <PlaceholderTab title="Appearance" description="Theme, font size, density, and layout preferences. Coming soon." />
        )}
        {activeTab === 'about' && (
          <PlaceholderTab title="About Cortex IDE" description="Version 0.0.1 · Built with Next.js + Tauri · Powered by Cortex" />
        )}
      </div>
    </div>
  );
}
