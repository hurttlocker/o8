'use client';

/**
 * SettingsPage — Full workspace settings panel.
 *
 * First tab: GitHub connection status + account management.
 * Future tabs: Slack, Linear, Vault config, Agent defaults, etc.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '@/lib/theme/context';

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

// ── GitHub Tab Content ──

function ChevronDownIcon({ rotated }: { rotated?: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      style={{ display: 'block', flexShrink: 0, transition: 'transform 200ms', transform: rotated ? 'rotate(180deg)' : 'rotate(0)' }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

function GitHubTab({ accounts, repos, loading }: {
  accounts: GitHubAccount[];
  repos: GitHubRepo[];
  loading: boolean;
}) {
  const [reposExpanded, setReposExpanded] = useState(false);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
        Checking GitHub connection...
      </div>
    );
  }

  // Only show active accounts
  const activeAccounts = accounts.filter(a => a.active);
  const activeAccount = activeAccounts[0];
  const connected = !!activeAccount;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Connection Status Card */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 24,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{ color: 'var(--t-text)' }}><GitHubIcon size={28} /></div>
          <div>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>GitHub</h3>
            <p style={{ fontSize: 11, color: 'var(--t-text-muted)', margin: '2px 0 0' }}>
              Source control, issues, and pull requests
            </p>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto',
            padding: '5px 12px', borderRadius: 8,
            background: connected ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
            color: connected ? '#22c55e' : '#ef4444',
            fontSize: 12, fontWeight: 600,
          }}>
            {connected && <CheckCircleIcon />}
            {connected ? 'Connected' : 'Not Connected'}
          </div>
        </div>

        {/* Active Account */}
        {activeAccount && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: 16,
            borderRadius: 12,
            background: 'rgba(37, 99, 235, 0.03)',
            border: '1px solid rgba(37, 99, 235, 0.1)',
          }}>
            <img
              src={activeAccount.avatarUrl}
              alt={activeAccount.login}
              width={44}
              height={44}
              style={{ borderRadius: 22, border: '2px solid rgba(37, 99, 235, 0.2)' }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)' }}>{activeAccount.login}</span>
                {activeAccount.name && <span style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{activeAccount.name}</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 3 }}>
                Protocol: {activeAccount.protocol} · {activeAccount.scopes.length} scopes · {repos.length} repositories
              </div>
              {/* Scopes inline */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                {activeAccount.scopes.map((s) => <ScopeBadge key={s} scope={s} />)}
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {connected ? (
            <>
              <button type="button" style={{
                padding: '8px 16px', borderRadius: 10, border: '1px solid var(--t-panel-border)',
                background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', transition: 'background 120ms',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--t-panel)'; }}
              >
                Disconnect
              </button>
              <button type="button" style={{
                padding: '8px 16px', borderRadius: 10, border: '1px solid var(--t-panel-border)',
                background: 'var(--t-panel)', color: 'var(--t-text-secondary)', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', transition: 'background 120ms',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--t-panel)'; }}
              >
                Switch Account
              </button>
            </>
          ) : (
            <button type="button" style={{
              padding: '8px 20px', borderRadius: 10, border: 'none',
              background: '#111827', color: '#fff', fontSize: 12, fontWeight: 600,
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              transition: 'background 120ms',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#374151'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#111827'; }}
            >
              <GitHubIcon size={14} /> Connect GitHub
            </button>
          )}
        </div>
      </div>

      {/* Repositories — Collapsible */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
        overflow: 'hidden',
      }}>
        <button
          type="button"
          onClick={() => setReposExpanded(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', padding: '14px 20px', border: 'none', background: 'transparent',
            cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--t-text)',
            borderBottom: reposExpanded ? '1px solid var(--t-divider-subtle)' : 'none',
          }}
        >
          <span>Repositories ({repos.length})</span>
          <ChevronDownIcon rotated={reposExpanded} />
        </button>
        {reposExpanded && (
          <div style={{ padding: '8px 12px 12px', maxHeight: 300, overflowY: 'auto' }}>
            {repos.map((repo) => (
              <div key={repo.nameWithOwner} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 8px',
                borderRadius: 8,
                transition: 'background 80ms',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Placeholder Tabs ──

function PlaceholderTab({ title, description }: { title: string; description: string }) {
  return (
    <div style={{
      background: 'var(--t-panel)',
      borderRadius: 14,
      padding: 32,
      border: '1px solid rgba(0,0,0,0.06)',
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
        background: 'rgba(0,0,0,0.06)',
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
  const shortModel = agent.model
    .replace('claude-opus-4-6', 'Opus 4.6')
    .replace('claude-sonnet-4-20250514', 'Sonnet 4')
    .replace('claude-haiku-4-5-20251001', 'Haiku 4.5')
    .replace('gemini-3-flash-preview', 'Gemini 3 Flash')
    .replace('codex owned', 'Codex')
    .replace(/^openai-codex\//, '')
    .replace(/^anthropic\//, '');

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
      border: '1px solid rgba(0,0,0,0.06)',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      transition: 'box-shadow 120ms',
    }}>
      {/* Status + Icon */}
      <div style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        display: 'grid',
        placeItems: 'center',
        background: isOpenClaw ? 'rgba(37, 99, 235, 0.06)' : 'rgba(0,0,0,0.03)',
        color: isOpenClaw ? '#2563eb' : '#6b7280',
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
            background: agent.status === 'running' ? 'rgba(34, 197, 94, 0.08)' : 'rgba(0,0,0,0.04)',
            color: agent.status === 'running' ? '#22c55e' : '#9ca3af',
          }}>
            {agent.status}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>
          <span style={{ fontWeight: 600, color: 'var(--t-text-secondary)' }}>{shortModel}</span>
          {heartbeatLabel && (
            <>
              <span>·</span>
              <span style={{ color: 'var(--t-text-muted)' }}>HB {heartbeatLabel}</span>
            </>
          )}
          <span>·</span>
          <span style={{ fontFamily: '"SF Mono", monospace', fontSize: 10 }}>{shortId}</span>
        </div>
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
              border: '1px solid rgba(0,0,0,0.08)',
              background: 'var(--t-panel)',
              color: 'var(--t-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background 120ms',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.03)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
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
              background: killing ? 'rgba(239, 68, 68, 0.08)' : '#fff',
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
                e.currentTarget.style.background = '#fff';
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
        boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
      }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--t-text)', margin: '0 0 4px' }}>
          Configure Agent
        </h3>
        <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '0 0 20px' }}>
          {agent.id}
        </p>

        {/* Model selector */}
        <label style={{ display: 'block', marginBottom: 16 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
            Model
          </span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(0,0,0,0.1)',
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
          This uses the OpenClaw <code style={{ background: 'rgba(0,0,0,0.04)', padding: '1px 4px', borderRadius: 3 }}>session_status</code> model override.
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{
            padding: '8px 16px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.08)',
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
        border: '1px solid rgba(0,0,0,0.06)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t-text)' }}>{agents.length}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Agents</div>
        </div>
        <div style={{ width: 1, background: 'rgba(0,0,0,0.06)' }} />
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#22c55e' }}>
            {agents.filter(a => a.status === 'running').length}
          </div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Running</div>
        </div>
        <div style={{ width: 1, background: 'rgba(0,0,0,0.06)' }} />
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#3b82f6' }}>{squads.length}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Squads</div>
        </div>
        <div style={{ width: 1, background: 'rgba(0,0,0,0.06)' }} />
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
                background: 'rgba(0,0,0,0.04)',
              }}>
                {members.length}
              </span>
              {squad && (
                <span style={{ fontSize: 10, color: '#b0b8c4', marginLeft: 'auto' }}>
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
          <GitHubTab accounts={accounts} repos={repos} loading={loading} />
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
