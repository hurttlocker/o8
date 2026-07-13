'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CliUsageSnapshot, CliWindow } from '@/lib/usage/cli-scrape';
import { ClaudeIcon, CodexIcon } from './repo-registry/shared';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Cpu,
  Download,
  ExternalLink,
  Gauge,
  Github,
  Globe,
  LogOut,
  MessageSquare,
  RefreshCw,
  Settings2,
  Sparkles,
} from './lucide-shims';
import { useO8Auth, type O8AuthState } from '@/components/auth/O8AuthProvider';
import {
  clearDesktopAuthError,
  getDesktopAuthError,
  subscribeDesktopAuthError,
  type DesktopAuthError,
} from '@/lib/auth/desktop-auth-error';
import { useTheme } from '@/lib/theme/context';
import { useEntitlement } from '@/lib/entitlement/context';
import { openExternalUrl } from '@/lib/desktop/open-external';
import type { PaletteId } from '@/lib/theme/registry';
import { SignInErrorCard } from '@/components/desktop/SignInErrorCard';

const FONT = 'var(--font-sans-system)';
const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const POLL_MS = 30_000;
const RELEASE_URL = 'https://github.com/hurttlocker/o8/releases/latest';
const DOCS_URL = 'https://o8.run';
const DISCORD_URL = 'https://discord.gg/uSU9TXsk5d';
// Paint the panel token directly — NOT through color-mix. In glass mode
// --t-panel-solid is a linear-gradient (an <image>), and color-mix() only
// accepts <color> args, so the old color-mix() was invalid CSS → the whole
// background was dropped → the drawer rendered transparent over the dark
// vibrancy with near-black text (illegible). A gradient is a valid
// `background`, so this restores the frosted cream/graphite menu card in
// every palette × surface combo.
const PANEL_BG = 'var(--t-panel-solid, var(--t-panel, rgba(255,255,255,0.92)))';
const ROW_HOVER_BG = 'var(--t-panel-hover, rgba(15, 23, 42, 0.04))';
const SUBTLE_BG = 'var(--t-bg-card, rgba(15, 23, 42, 0.04))';
const SELECTED_BG = 'var(--t-input-bg, var(--t-bg-card))';
const BORDER = 'var(--t-panel-border, rgba(15, 23, 42, 0.1))';
const SELECTED_BORDER = 'var(--t-accent-border, var(--t-panel-border))';
const TEXT = 'var(--t-text, #0f172a)';
const MUTED = 'var(--t-text-muted, #64748b)';
const FAINT = 'color-mix(in srgb, var(--t-text-muted, #64748b) 62%, transparent)';

interface SettingsQuickDrawerProps {
  open: boolean;
  anchorRect: DOMRect | null;
  onClose: () => void;
  onOpenSettings: () => void;
  /** When provided, the What's-new row opens the in-app Brain-summarized
   *  card instead of the external releases page. */
  onWhatsNew?: () => void;
}

type UsageState =
  | { status: 'idle'; snapshot: null; error: null }
  | { status: 'loading'; snapshot: CliUsageSnapshot | null; error: null }
  | { status: 'ready'; snapshot: CliUsageSnapshot; error: null }
  | { status: 'error'; snapshot: CliUsageSnapshot | null; error: string };

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'No data';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatWindow(minutes: number | null | undefined): string {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'Weekly';
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return 'Window';
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatResetTime(epochSeconds: number | null | undefined): string {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return 'Rolling';
  const resetDate = new Date(epochSeconds * 1000);
  const deltaMs = resetDate.getTime() - Date.now();
  if (deltaMs <= 0) return 'Now';
  if (deltaMs < 24 * 60 * 60 * 1000) {
    return resetDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return resetDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatGeneratedAt(epochMs: number | null | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return 'Not synced';
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function usageValue(window: CliWindow | null, mode: 'percent-or-tokens' | 'tokens'): string {
  if (!window) return 'No data';
  if (mode === 'percent-or-tokens' && typeof window.usedPercent === 'number') {
    return `${Math.round(window.usedPercent)}%`;
  }
  return formatTokens(window.tokens);
}

function usagePercent(window: CliWindow | null): number | null {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  return Math.max(0, Math.min(100, window.usedPercent));
}

function IconFrame({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        width: 17,
        height: 17,
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: SUBTLE_BG,
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--t-panel-border, rgba(15,23,42,0.1)) 60%, transparent)',
        color: MUTED,
      }}
    >
      {children}
    </span>
  );
}

function RowButton({
  children,
  onClick,
  ariaExpanded,
}: {
  children: ReactNode;
  onClick: () => void;
  ariaExpanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      style={{
        width: '100%',
        minHeight: 30,
        border: 0,
        borderRadius: 9,
        padding: '0 7px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: FONT,
        fontSize: 11.5,
        textAlign: 'left',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = ROW_HOVER_BG;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

function MiniBar({ percent, tone }: { percent: number | null; tone: 'codex' | 'claude' }) {
  return (
    <div
      aria-hidden="true"
      style={{
        gridColumn: '1 / -1',
        height: 2,
        borderRadius: 999,
        overflow: 'hidden',
        background: 'color-mix(in srgb, var(--t-panel-border, rgba(15,23,42,0.1)) 70%, transparent)',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${percent ?? 100}%`,
          opacity: percent === null ? 0.24 : 0.92,
          borderRadius: 999,
          background: tone === 'codex'
            ? 'var(--t-accent, #2563eb)'
            : 'var(--t-brand-orange, #f97316)',
          transition: 'width 180ms ease-out',
        }}
      />
    </div>
  );
}

function UsageLine({
  icon,
  label,
  reset,
  value,
  percent,
  tone,
}: {
  icon?: ReactNode;
  label: string;
  reset: string;
  value: string;
  percent: number | null;
  tone: 'codex' | 'claude';
}) {
  return (
    <div
      style={{
        minHeight: 24,
        display: 'grid',
        gridTemplateColumns: 'minmax(82px, 1fr) auto auto',
        alignItems: 'center',
        columnGap: 6,
        rowGap: 2,
        minWidth: 0,
      }}
    >
      <span
        style={{
          color: TEXT,
          fontSize: 12,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          whiteSpace: 'nowrap',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
        }}
      >
        <span style={{ width: 13, height: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {icon}
        </span>
        {label}
      </span>
      <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', whiteSpace: 'nowrap' }}>
        {value}
      </span>
      <span style={{ color: FAINT, fontFamily: MONO, fontSize: 9, fontWeight: 260, letterSpacing: '-0.2px', whiteSpace: 'nowrap' }}>
        {reset}
      </span>
      <MiniBar percent={percent} tone={tone} />
    </div>
  );
}

function RuntimeUsageCard({
  icon,
  title,
  primary,
  secondary,
  valueMode,
  tone,
}: {
  icon: ReactNode;
  title: string;
  primary: CliWindow | null;
  secondary: CliWindow | null;
  valueMode: 'percent-or-tokens' | 'tokens';
  tone: 'codex' | 'claude';
}) {
  return (
    <section
      style={{
        display: 'grid',
        gap: 3,
        padding: '0 4px',
      }}
    >
      <UsageLine
        icon={icon}
        label={`${title} ${primary ? formatWindow(primary.windowMinutes) : '5h'}`}
        value={usageValue(primary, valueMode)}
        reset={formatResetTime(primary?.resetsAt)}
        percent={usagePercent(primary)}
        tone={tone}
      />
      <UsageLine
        label={`${title} ${secondary ? formatWindow(secondary.windowMinutes) : 'Weekly'}`}
        value={usageValue(secondary, valueMode)}
        reset={formatResetTime(secondary?.resetsAt)}
        percent={usagePercent(secondary)}
        tone={tone}
      />
    </section>
  );
}

function separatorStyle(): CSSProperties {
  return {
    height: 1,
    width: '100%',
    background: BORDER,
  };
}

/**
 * Identity header for the quick drawer. Replaces the static "Local desktop
 * profile / o8" header once Clerk is configured: signed-out shows a GitHub
 * sign-in CTA, signed-in shows avatar + name/email + Manage account / Sign out.
 * Builds without a Clerk key keep the original local-profile header.
 */
function AccountSection({ auth }: { auth: O8AuthState }) {
  const [authError, setAuthError] = useState<DesktopAuthError | null>(() => getDesktopAuthError());

  useEffect(() => {
    return subscribeDesktopAuthError(() => {
      setAuthError(getDesktopAuthError());
    });
  }, []);

  useEffect(() => {
    if (auth.signedIn && authError) clearDesktopAuthError();
  }, [auth.signedIn, authError]);

  if (!auth.clerkEnabled) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 7px 1px', minWidth: 0 }}>
          <IconFrame><Cpu size={15} /></IconFrame>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Local desktop profile
            </div>
            <div style={{ color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              o8
            </div>
          </div>
        </div>
        <div style={separatorStyle()} />
      </>
    );
  }

  if (!auth.signedIn) {
    return (
      <>
        <RowButton onClick={auth.signIn}>
          <IconFrame><Github size={13} /></IconFrame>
          <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Sign in with GitHub</span>
        </RowButton>
        {authError ? <SignInErrorCard key={authError.id} authError={authError} onRetry={auth.signIn} /> : null}
        <div style={separatorStyle()} />
      </>
    );
  }

  const user = auth.user;
  const displayName = user?.name || user?.email || 'Signed in';
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 7px 1px', minWidth: 0 }}>
        {user?.avatarUrl ? (
          <div
            aria-hidden="true"
            style={{
              width: 26,
              height: 26,
              borderRadius: 999,
              flexShrink: 0,
              backgroundImage: `url("${user.avatarUrl}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              border: `1px solid ${BORDER}`,
            }}
          />
        ) : (
          <IconFrame><CircleUser size={15} /></IconFrame>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayName}
          </div>
          {user?.email ? (
            <div style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </div>
          ) : null}
        </div>
      </div>

      <div style={separatorStyle()} />

      <RowButton onClick={auth.openManageAccount}>
        <IconFrame><CircleUser size={13} /></IconFrame>
        <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Manage account</span>
      </RowButton>

      <RowButton onClick={() => { void auth.signOut(); }}>
        <IconFrame><LogOut size={13} /></IconFrame>
        <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Sign out</span>
      </RowButton>

      <div style={separatorStyle()} />
    </>
  );
}

function ThemeGlyphSun() {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function ThemeGlyphMoon() {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function ThemeContrastGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ThemeToggle({ paletteId, setPalette }: { paletteId: PaletteId; setPalette: (id: PaletteId) => void }) {
  const opts: Array<{ id: PaletteId; label: string; glyph: ReactNode }> = [
    { id: 'light', label: 'Light', glyph: <ThemeGlyphSun /> },
    { id: 'dark', label: 'Dark', glyph: <ThemeGlyphMoon /> },
  ];
  return (
    <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: SUBTLE_BG, flexShrink: 0 }}>
      {opts.map((o) => {
        const active = paletteId === o.id;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => setPalette(o.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 20,
              paddingLeft: 7,
              paddingRight: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: active ? SELECTED_BORDER : 'transparent',
              borderRadius: 6,
              background: active ? SELECTED_BG : 'transparent',
              boxShadow: active ? 'var(--t-panel-shadow-soft, 0 1px 2px var(--t-shadow-color, transparent))' : 'none',
              color: active ? TEXT : MUTED,
              fontFamily: FONT,
              fontSize: 10.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              cursor: 'pointer',
              transition: 'background 140ms ease, color 140ms ease',
            }}
          >
            {o.glyph}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsQuickDrawer({
  open,
  anchorRect,
  onClose,
  onOpenSettings,
  onWhatsNew,
}: SettingsQuickDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [usageState, setUsageState] = useState<UsageState>({ status: 'idle', snapshot: null, error: null });
  const auth = useO8Auth();
  const { paletteId, setPalette } = useTheme();
  // CLI token telemetry is Founders-mode content (epic #1450) — visibility
  // only; the /api/panel/cli-usage route stays gated the same either way.
  const { founder, plan } = useEntitlement();
  const foundersMode = founder !== null || plan === 'founder';
  const [version, setVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'current' | 'available'>('idle');

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setVersion).catch(() => { /* not in Tauri */ });
  }, []);

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus('checking');
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        setUpdateStatus('available');
        // Surface the IN-APP update card (version + release note + install
        // button) instead of bouncing the operator to GitHub — the card is
        // the product surface for updates (operator report 2026-07-10).
        window.dispatchEvent(new CustomEvent('o8:update-found', {
          detail: {
            version: update.version,
            notes: update.body ?? undefined,
            date: update.date ?? undefined,
          },
        }));
      } else {
        setUpdateStatus('current');
        window.setTimeout(() => setUpdateStatus('idle'), 2600);
      }
    } catch {
      setUpdateStatus('idle');
    }
  }, []);

  const loadUsage = useCallback(async (preserveSnapshot = true) => {
    setUsageState((current) => ({
      status: 'loading',
      snapshot: preserveSnapshot ? current.snapshot : null,
      error: null,
    }));
    try {
      const res = await fetch('/api/panel/cli-usage', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data?.codex || !data?.claude) {
        throw new Error(data?.error || 'Usage data unavailable');
      }
      setUsageState({ status: 'ready', snapshot: data as CliUsageSnapshot, error: null });
    } catch (err) {
      setUsageState((current) => ({
        status: 'error',
        snapshot: current.snapshot,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    if (!open || !usageOpen) return;
    void loadUsage();
    const timer = window.setInterval(() => {
      void loadUsage();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadUsage, open, usageOpen]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const panelStyle = useMemo<CSSProperties>(() => {
    const viewportWidth = typeof window === 'undefined' ? 640 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 700 : window.innerHeight;
    const width = Math.max(246, Math.min(280, viewportWidth - 24));
    const leftFromAnchor = anchorRect?.left ?? 12;
    const left = Math.max(12, Math.min(leftFromAnchor, viewportWidth - width - 12));
    const bottomFromAnchor = anchorRect ? viewportHeight - anchorRect.top + 8 : 42;
    const bottom = Math.max(38, Math.min(bottomFromAnchor, Math.max(38, viewportHeight - 72)));
    return {
      position: 'fixed',
      left,
      bottom,
      width,
      maxWidth: 'calc(100vw - 24px)',
      maxHeight: 'min(340px, calc(100vh - 64px))',
      overflow: 'hidden',
      zIndex: 11000,
      borderRadius: 16,
      background: PANEL_BG,
      border: `1px solid ${BORDER}`,
      boxShadow: 'var(--t-panel-shadow, 0 24px 60px rgba(15, 23, 42, 0.1))',
      backdropFilter: 'blur(24px) saturate(150%)',
      WebkitBackdropFilter: 'blur(24px) saturate(150%)',
      color: TEXT,
      fontFamily: FONT,
    };
  }, [anchorRect]);

  const snapshot = usageState.snapshot;
  const usageSummary = !auth.signedIn
    ? 'Sign in to view usage'
    : snapshot
      ? formatGeneratedAt(snapshot.generatedAt)
      : usageState.status === 'loading'
        ? 'Syncing'
        : 'Codex + Claude';

  if (!mounted || !open) return null;

  return createPortal(
    <div
      data-settings-quick-drawer-root="true"
      style={{ position: 'fixed', inset: 0, zIndex: 10999, pointerEvents: 'auto' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-label="Quick settings" style={panelStyle}>
        <div
          style={{
            maxHeight: 'inherit',
            overflowY: 'auto',
            padding: 7,
            display: 'grid',
            gap: 4,
          }}
        >
          <AccountSection auth={auth} />

          <RowButton onClick={onOpenSettings}>
            <IconFrame><Settings2 size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Settings</span>
            <span style={{ color: FAINT, fontFamily: MONO, fontSize: 10, fontWeight: 300, letterSpacing: '0.5px' }}>⌘,</span>
          </RowButton>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, paddingLeft: 7, paddingRight: 7 }}>
            <IconFrame><ThemeContrastGlyph /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Theme</span>
            <ThemeToggle paletteId={paletteId} setPalette={setPalette} />
          </div>

          {foundersMode ? (
            <>
          <div style={separatorStyle()} />

          <RowButton
            ariaExpanded={usageOpen}
            onClick={() => {
              setUsageOpen((value) => !value);
            }}
          >
            <IconFrame><Gauge size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Usage remaining</span>
            <span
              style={{
                color: MUTED,
                fontFamily: MONO,
                fontSize: 9.5,
                whiteSpace: 'nowrap',
              }}
            >
              {usageSummary}
            </span>
            {usageOpen ? <ChevronDown size={12} color={MUTED} /> : <ChevronRight size={12} color={MUTED} />}
          </RowButton>

          {usageOpen ? (
            <div style={{ display: 'grid', gap: 4, padding: '0 4px 3px 28px' }}>
              <RuntimeUsageCard
                icon={<CodexIcon size={13} />}
                title="Codex"
                primary={snapshot?.codex.primary ?? null}
                secondary={snapshot?.codex.secondary ?? null}
                valueMode="percent-or-tokens"
                tone="codex"
              />
              <RuntimeUsageCard
                icon={<ClaudeIcon size={13} />}
                title="Claude"
                primary={snapshot?.claude.primary ?? null}
                secondary={snapshot?.claude.secondary ?? null}
                valueMode="tokens"
                tone="claude"
              />
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => {
                    void loadUsage(false);
                  }}
                  style={{
                    flex: 1,
                    height: 24,
                    border: 0,
                    borderRadius: 8,
                    background: SUBTLE_BG,
                    color: TEXT,
                    fontFamily: FONT,
                    fontSize: 11,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    cursor: 'pointer',
                  }}
                >
                  <RefreshCw size={10} />
                  Refresh usage
                </button>
              </div>
              {usageState.status === 'error' ? (
                <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.35 }}>
                  {usageState.error}
                </div>
              ) : null}
            </div>
          ) : null}
            </>
          ) : null}

          <div style={separatorStyle()} />

          <RowButton onClick={() => { void checkForUpdates(); }}>
            <IconFrame><Download size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Check for updates</span>
            <span
              style={{
                color: updateStatus === 'available' ? 'var(--t-brand-orange, #f97316)' : MUTED,
                fontFamily: MONO,
                fontSize: 9.5,
                fontWeight: 260,
                letterSpacing: '-0.2px',
                whiteSpace: 'nowrap',
              }}
            >
              {updateStatus === 'checking'
                ? 'Checking…'
                : updateStatus === 'available'
                  ? 'Update ready'
                  : updateStatus === 'current'
                    ? 'Up to date'
                    : version
                      ? `v${version}`
                      : ''}
            </span>
          </RowButton>

          <RowButton onClick={onWhatsNew ?? (() => openExternalUrl(RELEASE_URL))}>
            <IconFrame><Sparkles size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>What&apos;s new</span>
            {onWhatsNew ? null : <ExternalLink size={11} color={FAINT} />}
          </RowButton>

          <RowButton
            ariaExpanded={helpOpen}
            onClick={() => setHelpOpen((value) => !value)}
          >
            <IconFrame><BookOpen size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Get help</span>
            {helpOpen ? <ChevronDown size={12} color={MUTED} /> : <ChevronRight size={12} color={MUTED} />}
          </RowButton>

          {helpOpen ? (
            <div style={{ display: 'grid', gap: 2, paddingTop: 0, paddingRight: 4, paddingBottom: 3, paddingLeft: 28 }}>
              <RowButton onClick={() => openExternalUrl(DISCORD_URL)}>
                <IconFrame><MessageSquare size={13} /></IconFrame>
                <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Community Discord</span>
                <ExternalLink size={11} color={FAINT} />
              </RowButton>
              <RowButton onClick={() => openExternalUrl(DOCS_URL)}>
                <IconFrame><Globe size={13} /></IconFrame>
                <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Documentation</span>
                <ExternalLink size={11} color={FAINT} />
              </RowButton>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
