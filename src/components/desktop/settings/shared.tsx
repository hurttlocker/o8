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
  /** True when auth comes from the managed public "o8" App (license-server minted). */
  managed?: boolean;
  /** Install page for the managed App, when known and not yet installed. */
  managedInstallUrl?: string | null;
}

export interface GitHubDeviceFlowState {
  flowId: string;
  csrfToken: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  expiresInMinutes: number;
  nextPollInMs: number;
  note?: string;
}

export type GitHubActionKind = 'refresh' | 'logout' | 'login_token' | 'login_device' | 'cancel_device';

export type SettingsTab = 'general' | 'api-keys' | 'mcp' | 'connections' | 'operator-defaults' | 'git-prs' | 'models' | 'indexing' | 'projects' | 'workers' | 'cloud-workers' | 'analytics' | 'appearance' | 'voice' | 'permissions' | 'billing' | 'diagnostics' | 'about';

// ── Constants ──

export const THEME_ACCENT = 'var(--t-settings-accent, #7c9cff)';
export const THEME_ACCENT_SOFT = 'var(--t-settings-accent-soft, rgba(124, 156, 255, 0.12))';
export const THEME_ACCENT_SOFT_STRONG = 'var(--t-settings-accent-soft-strong, rgba(124, 156, 255, 0.2))';
export const THEME_ACCENT_BORDER = 'var(--t-settings-accent-border, rgba(124, 156, 255, 0.28))';
export const THEME_ACCENT_RING = 'var(--t-settings-accent-ring, rgba(124, 156, 255, 0.18))';
export const APP_FONT_STACK = 'var(--font-sans-system)';
export const MONO_FONT_STACK = '"iA Writer Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// Outer width cap for settings tab content. One knob.
// 2026-05-27: bumped 1080 → 1400 so wide displays don't truncate, and the
// right-content column in SettingsPage now centers its tab body via
// alignItems:'center' so the leftover cream on either side reads as
// intentional editorial breathing room (margin: auto) rather than orphan
// empty space crammed to one side.
export const SETTINGS_CONTENT_MAX_WIDTH = 1400;

// Rams × o8-site editorial tokens — paper, ink, one orange. See o8_design_language.md.
// Accent is palette-aware (registry.ts): deep #1D4ED8 on light paper, lighter
// #8FB4FF on dark graphite so active states stand out (operator, 2026-07-05).
export const RAMS_ACCENT = 'var(--t-settings-accent-strong, #1D4ED8)';
export const RAMS_HAIRLINE_SOFT = 'rgba(17, 17, 17, 0.08)';
export const RAMS_HAIRLINE = 'rgba(17, 17, 17, 0.18)';
export const RAMS_INK_QUIET = 'var(--t-text-muted, #9A968E)';
export const RAMS_CONTROL_BG = 'var(--t-bg-card, rgba(17, 17, 17, 0.035))';
export const RAMS_CONTROL_BORDER = 'var(--t-panel-border, rgba(17, 17, 17, 0.14))';
export const RAMS_CONTROL_ACTIVE_BG = 'var(--t-settings-accent-active-bg, rgba(29, 78, 216, 0.1))';
export const RAMS_CONTROL_ACTIVE_BORDER = 'var(--t-settings-accent-active-border, rgba(29, 78, 216, 0.32))';
// Symon-shape control extras (port of voice-settings primitives): focus-ring
// glow + the iOS-switch off-track. Off-track uses a theme divider so it reads
// on both cream (light) and graphite (dark) paper.
export const RAMS_ACCENT_GLOW = 'var(--t-settings-accent-glow, rgba(29, 78, 216, 0.28))';
export const RAMS_TOGGLE_OFF = 'var(--t-divider-strong, rgba(17, 17, 17, 0.22))';

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

export function UserIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
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

export function LayersIcon() {
  // Stacked-rectangles glyph for Settings → Projects (epic #899). Phosphor's
  // "stack" path simplified to plain SVG so it renders inside the Tauri webview.
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 2 2 7l10 5 10-5z" />
      <path d="M2 12l10 5 10-5" />
      <path d="M2 17l10 5 10-5" />
    </svg>
  );
}

export function MobileIcon() {
  // Smartphone glyph for Settings → Mobile (epic #1074). Hand-authored raw
  // SVG so it renders inside the Tauri webview.
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
      <path d="M12 18h.01"/>
    </svg>
  );
}

export function CreditCardIcon() {
  // Card glyph for Settings → Billing (monetization M3). Hand-authored raw SVG
  // so it renders inside the Tauri webview (React icon libs don't, per repo rule).
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}

export function MicIcon() {
  // Microphone glyph for Settings → Voice (system-wide Symon fold P4).
  // Hand-authored raw SVG so it renders inside the Tauri webview.
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
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

export function SettingsTabSectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 9,
        fontWeight: 300,
        color: RAMS_INK_QUIET,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 6,
        paddingLeft: 14,
        userSelect: 'none',
      }}
    >
      {children}
    </div>
  );
}

export function TabButton({ label, icon, active, onClick, comingSoon = false }: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  comingSoon?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        minHeight: 44,
        paddingTop: 9,
        paddingRight: 12,
        paddingBottom: 9,
        paddingLeft: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? RAMS_CONTROL_ACTIVE_BORDER : 'transparent',
        background: active ? RAMS_CONTROL_ACTIVE_BG : 'transparent',
        color: active ? RAMS_ACCENT : 'var(--t-text-secondary)',
        fontSize: 13.5,
        fontWeight: active ? 400 : 300,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: APP_FONT_STACK,
        letterSpacing: '-0.01em',
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms',
        opacity: comingSoon && !active ? 0.55 : 1,
      }}
    >
      <span style={{ flexShrink: 0, color: active ? RAMS_ACCENT : 'var(--t-text-muted)', display: 'inline-flex' }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {comingSoon ? (
        <span style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 9,
          fontWeight: 400,
          letterSpacing: '0.12em',
          color: RAMS_INK_QUIET,
          textTransform: 'uppercase',
          paddingRight: 4,
        }}>
          (soon)
        </span>
      ) : null}
    </button>
  );
}

// ── Tab breadcrumb + heading primitives ──

export function TabBreadcrumb({ tab, scope = 'settings' }: { tab: string; scope?: string }) {
  return (
    <div style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 10,
      fontWeight: 400,
      letterSpacing: '0.2em',
      textTransform: 'uppercase',
      color: RAMS_INK_QUIET,
      marginBottom: 20,
    }}>
      <span>{scope}</span>
      <span style={{ opacity: 0.5, marginLeft: 8, marginRight: 8 }}>/</span>
      <span>{tab}</span>
    </div>
  );
}

export function TabHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <h1 style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 32,
        fontWeight: 700,
        color: 'var(--t-text)',
        letterSpacing: '-0.045em',
        lineHeight: 1.08,
        margin: 0,
        marginBottom: subtitle ? 10 : 0,
      }}>
        {title}
      </h1>
      {subtitle ? (
        <p style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 13.5,
          fontWeight: 300,
          color: 'var(--t-text-faint)',
          lineHeight: 1.55,
          margin: 0,
          maxWidth: 640,
          letterSpacing: '-0.005em',
        }}>
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

// ── Shared Rams form-label primitive ──

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 10,
      fontWeight: 400,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: RAMS_INK_QUIET,
    }}>
      {children}
    </span>
  );
}

// ── Rams primitives ──

export function SectionLabel({ number, children }: { number: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 10,
      fontFamily: APP_FONT_STACK,
      fontSize: 10,
      fontWeight: 300,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: 'var(--t-text-secondary)',
      marginBottom: 14,
    }}>
      <span style={{ color: RAMS_ACCENT }}>{number}</span>
      <span style={{ color: RAMS_INK_QUIET }}>—</span>
      <span>{children}</span>
    </div>
  );
}

export function SettingsToggleButton({
  checked,
  onChange,
  disabled = false,
  activeLabel = 'On',
  inactiveLabel = 'Off',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  activeLabel?: string;
  inactiveLabel?: string;
}) {
  // iOS-style sliding switch (Symon voice-settings shape) on o8's #1D4ED8
  // accent. The activeLabel/inactiveLabel props are kept for compat + aria;
  // the row's own label carries the meaning, so the switch itself is wordless.
  const [focus, setFocus] = useState(false);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? activeLabel : inactiveLabel}
      onClick={() => { if (!disabled) onChange(!checked); }}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      disabled={disabled}
      style={{
        position: 'relative',
        width: 44,
        height: 24,
        borderRadius: 12,
        padding: 0,
        flexShrink: 0,
        border: 'none',
        outline: 'none',
        background: checked ? RAMS_ACCENT : RAMS_TOGGLE_OFF,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 200ms cubic-bezier(0.22, 1, 0.36, 1)',
        boxShadow: focus && !disabled ? `0 0 0 2px ${RAMS_ACCENT_GLOW}` : 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 2,
          left: 2,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#ffffff',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
          transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
          transform: checked ? 'translateX(20px)' : 'translateX(0)',
        }}
      />
    </button>
  );
}

export function RamsButton({
  children,
  onClick,
  disabled = false,
  variant = 'primary',
  type = 'button',
  busy = false,
  icon,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
  busy?: boolean;
  icon?: React.ReactNode;
}) {
  const tone = variant === 'danger' ? '#d94f3a' : variant === 'ghost' ? 'var(--t-text-secondary)' : RAMS_ACCENT;
  const border = variant === 'ghost'
    ? RAMS_CONTROL_BORDER
    : variant === 'danger'
      ? 'rgba(217, 79, 58, 0.32)'
      : RAMS_CONTROL_ACTIVE_BORDER;
  const bg = disabled
    ? 'transparent'
    : variant === 'ghost'
      ? RAMS_CONTROL_BG
      : variant === 'danger'
        ? 'rgba(217, 79, 58, 0.08)'
        : RAMS_CONTROL_ACTIVE_BG;
  // Symon voice-settings button shape (system sans, sentence case, 32h) kept on
  // o8's accent + variant colors. Was: mono / 10px / 300 / UPPERCASE / 44h.
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        height: 32,
        paddingLeft: 14,
        paddingRight: 14,
        borderRadius: 9,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: disabled ? RAMS_HAIRLINE_SOFT : border,
        background: bg,
        color: disabled ? RAMS_INK_QUIET : tone,
        cursor: disabled || busy ? 'default' : 'pointer',
        fontFamily: APP_FONT_STACK,
        fontSize: 12,
        fontWeight: 400,
        letterSpacing: '-0.01em',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        opacity: busy ? 0.7 : 1,
      }}
    >
      {icon ? <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}

// ── Symon-shape selectors (native styled select + segmented), on #1D4ED8 ──

export function SettingsSelect({
  value,
  onChange,
  options,
  width = 220,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  width?: number;
  disabled?: boolean;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      disabled={disabled}
      style={{
        minWidth: width,
        height: 32,
        paddingLeft: 10,
        paddingRight: 26,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: focus ? RAMS_ACCENT : RAMS_CONTROL_BORDER,
        background: RAMS_CONTROL_BG,
        color: 'var(--t-text)',
        fontFamily: APP_FONT_STACK,
        fontSize: 12,
        fontWeight: 400,
        letterSpacing: '-0.01em',
        outline: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        boxShadow: focus ? `0 0 0 2px ${RAMS_ACCENT_GLOW}` : 'none',
        WebkitAppearance: 'none',
        appearance: 'none',
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239A968E' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 10px center',
      } as React.CSSProperties}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function SettingsSegmented({
  value,
  onChange,
  options,
  full = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  full?: boolean;
}) {
  return (
    <div style={{
      display: full ? 'grid' : 'inline-grid',
      gridAutoFlow: 'column',
      gridAutoColumns: full ? '1fr' : undefined,
      gap: 2,
      minHeight: 32,
      padding: 3,
      width: full ? '100%' : undefined,
      borderRadius: 8,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: RAMS_CONTROL_BORDER,
      background: RAMS_CONTROL_BG,
    }}>
      {options.map((o) => (
        <SettingsSegButton key={o.value} active={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </SettingsSegButton>
      ))}
    </div>
  );
}

function SettingsSegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={active}
      style={{
        minWidth: 54,
        height: 24,
        paddingLeft: 9,
        paddingRight: 9,
        border: 'none',
        borderRadius: 6,
        fontFamily: APP_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: active ? RAMS_ACCENT : hover ? 'var(--t-text)' : 'var(--t-text-secondary)',
        background: active ? RAMS_CONTROL_ACTIVE_BG : hover ? RAMS_CONTROL_BG : 'transparent',
        boxShadow: active ? `inset 0 0 0 1px ${RAMS_CONTROL_ACTIVE_BORDER}` : 'none',
        transition: 'background 160ms ease, color 160ms ease',
      }}
    >
      {children}
    </button>
  );
}

export function HairlineRule({ strong = false }: { strong?: boolean } = {}) {
  return <div style={{ height: 1, background: strong ? RAMS_HAIRLINE : RAMS_HAIRLINE_SOFT, width: '100%' }} />;
}

export function CornerBrackets({ armLength = 8, thickness = 1.5, inset = 4 }: { armLength?: number; thickness?: number; inset?: number } = {}) {
  const common: React.CSSProperties = { position: 'absolute', background: RAMS_ACCENT, pointerEvents: 'none' };
  return (
    <>
      <span aria-hidden="true" style={{ ...common, top: inset, left: inset, width: armLength, height: thickness }} />
      <span aria-hidden="true" style={{ ...common, top: inset, left: inset, width: thickness, height: armLength }} />
      <span aria-hidden="true" style={{ ...common, top: inset, right: inset, width: armLength, height: thickness }} />
      <span aria-hidden="true" style={{ ...common, top: inset, right: inset, width: thickness, height: armLength }} />
      <span aria-hidden="true" style={{ ...common, bottom: inset, left: inset, width: armLength, height: thickness }} />
      <span aria-hidden="true" style={{ ...common, bottom: inset, left: inset, width: thickness, height: armLength }} />
      <span aria-hidden="true" style={{ ...common, bottom: inset, right: inset, width: armLength, height: thickness }} />
      <span aria-hidden="true" style={{ ...common, bottom: inset, right: inset, width: thickness, height: armLength }} />
    </>
  );
}

export function BracketLabel({ children, tone = 'quiet' }: { children: React.ReactNode; tone?: 'quiet' | 'accent' | 'soon' }) {
  const color = tone === 'accent' ? RAMS_ACCENT : tone === 'soon' ? RAMS_INK_QUIET : RAMS_INK_QUIET;
  return (
    <span style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 10,
      fontWeight: 400,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color,
    }}>
      ({children})
    </span>
  );
}

export function ComingSoonBanner({ message }: { message: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      paddingTop: 16,
      paddingRight: 20,
      paddingBottom: 16,
      paddingLeft: 20,
      border: `1px dashed ${RAMS_HAIRLINE}`,
      borderRadius: 4,
      background: 'transparent',
    }}>
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 10,
        fontWeight: 400,
        letterSpacing: '0.22em',
        textTransform: 'uppercase',
        color: RAMS_INK_QUIET,
        flexShrink: 0,
      }}>
        (coming soon)
      </span>
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text-secondary)',
        lineHeight: 1.5,
      }}>
        {message}
      </span>
    </div>
  );
}

// ── Small Shared Components ──

export function ScopeBadge({ scope }: { scope: string }) {
  return (
    <span style={{
      display: 'inline-block',
      paddingTop: 2,
      paddingRight: 8,
      paddingBottom: 2,
      paddingLeft: 8,
      borderRadius: 6,
      fontSize: 9,
      fontWeight: 300,
      background: THEME_ACCENT_SOFT,
      color: THEME_ACCENT,
      letterSpacing: '0.04em',
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
      paddingTop: 12,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
      borderRadius: 10,
      background: tone.bg,
      border: `1px solid ${tone.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>{title}</span>
        <span style={{
          paddingTop: 2,
          paddingRight: 7,
          paddingBottom: 2,
          paddingLeft: 7,
          borderRadius: 999,
          background: `${tone.pill}22`,
          color: tone.text,
          fontSize: 9,
          fontWeight: 300,
          letterSpacing: '0.04em',
          marginLeft: 'auto',
        }}>
          {tone.label}
        </span>
      </div>
      <div style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)', lineHeight: 1.45 }}>
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
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 44,
        paddingTop: 7,
        paddingBottom: 7,
        paddingLeft: 14,
        paddingRight: 14,
        borderRadius: 12,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel)',
        color: 'var(--t-text-secondary)',
        fontSize: 11,
        fontWeight: 350,
        letterSpacing: '-0.1px',
        textDecoration: 'none',
      }}
    >
      {label}
    </a>
  );
}
