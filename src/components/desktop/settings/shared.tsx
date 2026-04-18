'use client';

/**
 * Shared types, constants, icons, helpers, and small components
 * used across all settings tab files.
 */

import { useState } from 'react';
import Image from 'next/image';

// ── Types ──

export interface GitHubAccount {
  login: string;
  name: string;
  avatarUrl: string;
  active: boolean;
  scopes: string[];
  protocol: string;
}

export interface GitHubRepo {
  nameWithOwner: string;
  isPrivate: boolean;
  updatedAt: string;
}

export interface GitHubBrokerStatus {
  configured: boolean;
  appId: string | null;
  privateKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  publicBaseUrlConfigured: boolean;
  webhookUrl: string | null;
  productionWebhookReady: boolean;
  installationReachable: boolean;
  installationId: number | null;
  installationAccount: string | null;
  probeRepo: string | null;
  tokenReady: boolean;
  authSource: 'github-app' | 'local-gh' | 'none';
  note: string;
}

export interface GitHubDeviceFlowState {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  expiresInMinutes: number;
  nextPollInMs: number;
  note?: string;
}

export type GitHubActionKind = 'refresh' | 'switch' | 'logout' | 'login_token' | 'login_device' | 'cancel_device';

export type SettingsTab = 'connectors' | 'api-keys' | 'mcp' | 'operator-defaults' | 'workers' | 'appearance' | 'diagnostics' | 'about';

// ── Constants ──

export const THEME_ACCENT = 'var(--t-settings-accent, #7c9cff)';
export const THEME_ACCENT_SOFT = 'var(--t-settings-accent-soft, rgba(124, 156, 255, 0.12))';
export const THEME_ACCENT_SOFT_STRONG = 'var(--t-settings-accent-soft-strong, rgba(124, 156, 255, 0.2))';
export const THEME_ACCENT_BORDER = 'var(--t-settings-accent-border, rgba(124, 156, 255, 0.28))';
export const THEME_ACCENT_RING = 'var(--t-settings-accent-ring, rgba(124, 156, 255, 0.18))';
export const APP_FONT_STACK = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';

// ── Helpers ──

export function normalizeVersion(value?: string | null, fallback = '—') {
  if (!value) return fallback;
  const trimmed = String(value).replace(/^cortex\s+/i, '').trim();
  if (!trimmed || trimmed === 'unknown') return fallback;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

// ── SVG Icons ──

export function GitHubIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}

export function CheckCircleIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  );
}

export function UsersIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

export function PaletteIcon() {
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

export function InfoIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  );
}

export function BrainIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/>
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396"/>
      <path d="M19.938 10.5a4 4 0 0 1 .585.396"/>
      <path d="M6 18a4 4 0 0 1-1.967-.516"/>
      <path d="M19.967 17.484A4 4 0 0 1 18 18"/>
    </svg>
  );
}

export function PlugIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 22v-5"/>
      <path d="M9 8V2"/>
      <path d="M15 8V2"/>
      <path d="M18 8v5a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V8z"/>
    </svg>
  );
}

export function KeyIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
  );
}

export function SlidersIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="4" y1="21" x2="4" y2="14"/>
      <line x1="4" y1="10" x2="4" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12" y2="3"/>
      <line x1="20" y1="21" x2="20" y2="16"/>
      <line x1="20" y1="12" x2="20" y2="3"/>
      <line x1="1" y1="14" x2="7" y2="14"/>
      <line x1="9" y1="8" x2="15" y2="8"/>
      <line x1="17" y1="16" x2="23" y2="16"/>
    </svg>
  );
}

export function ActivityIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>
  );
}

export function ChevronDownIcon({ rotated }: { rotated?: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      style={{ display: 'block', flexShrink: 0, transition: 'transform 200ms', transform: rotated ? 'rotate(180deg)' : 'rotate(0)' }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

// ── Settings Tab Button ──

export function TabButton({ label, icon, active, onClick }: {
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
        border: active ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid transparent',
        background: active ? THEME_ACCENT_SOFT : 'transparent',
        color: active ? THEME_ACCENT : 'var(--t-text-secondary)',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: APP_FONT_STACK,
        transition: 'background 120ms, color 120ms, border-color 120ms, box-shadow 120ms',
        boxShadow: active ? `0 10px 24px ${THEME_ACCENT_RING}` : 'none',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Small Shared Components ──

export function ScopeBadge({ scope }: { scope: string }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 6,
      fontSize: 10,
      fontWeight: 600,
      background: THEME_ACCENT_SOFT,
      color: THEME_ACCENT,
      letterSpacing: '0.01em',
    }}>
      {scope}
    </span>
  );
}

export function ScopeDiagnostic({
  title,
  status,
  detail,
}: {
  title: string;
  status: 'ready' | 'partial' | 'missing';
  detail: string;
}) {
  const tone = status === 'ready'
    ? { bg: 'rgba(34, 197, 94, 0.08)', border: 'rgba(34, 197, 94, 0.16)', text: '#166534', pill: '#22c55e', label: 'Ready' }
    : status === 'partial'
      ? { bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.18)', text: '#92400e', pill: '#f59e0b', label: 'Partial' }
      : { bg: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.16)', text: '#991b1b', pill: '#ef4444', label: 'Missing' };

  return (
    <div style={{
      padding: 12,
      borderRadius: 10,
      background: tone.bg,
      border: `1px solid ${tone.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{title}</span>
        <span style={{
          padding: '2px 7px',
          borderRadius: 999,
          background: `${tone.pill}22`,
          color: tone.text,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.01em',
          marginLeft: 'auto',
        }}>
          {tone.label}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.45 }}>
        {detail}
      </div>
    </div>
  );
}

export function GitHubAvatar({
  avatarUrl,
  login,
  size,
}: {
  avatarUrl?: string;
  login: string;
  size: number;
}) {
  const [failed, setFailed] = useState(false);

  if (!avatarUrl || failed) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        border: `1px solid ${THEME_ACCENT_BORDER}`,
        background: THEME_ACCENT_SOFT,
        color: THEME_ACCENT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <GitHubIcon size={Math.max(14, Math.floor(size * 0.48))} />
      </div>
    );
  }

  return (
    <Image
      src={avatarUrl}
      alt={login}
      width={size}
      height={size}
      unoptimized
      onError={() => setFailed(true)}
      style={{
        borderRadius: size / 2,
        border: `2px solid ${THEME_ACCENT_BORDER}`,
        flexShrink: 0,
      }}
    />
  );
}

export function QuickLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
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
      {label}
    </a>
  );
}
