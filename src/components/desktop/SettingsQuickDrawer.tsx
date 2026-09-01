'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Cpu,
  Download,
  ExternalLink,
  Gauge,
  Globe,
  LogOut,
  MessageSquare,
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
import { SignInErrorCard } from '@/components/desktop/SignInErrorCard';
import { ThemeContrastGlyph, AppearanceControl } from './settings-quick-drawer/theme-rows';
import { CapacityRows, capacitySummary } from './settings-quick-drawer/capacity-rows';

const FONT = 'var(--font-sans-system)';
const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const POLL_MS = 30_000;
const RELEASE_URL = 'https://github.com/hurttlocker/o8/releases/latest';
const DOCS_URL = 'https://o8.run';
// The canonical community invite — MUST match the README footer + o8.run
// (the drawer previously carried a different, stale invite).
const DISCORD_URL = 'https://o8.run/discord';
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
const BORDER = 'var(--t-panel-border, rgba(15, 23, 42, 0.1))';
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
  | { status: 'loading'; snapshot: RuntimeCapacityControlSnapshot | null; error: null }
  | { status: 'ready'; snapshot: RuntimeCapacityControlSnapshot; error: null }
  | { status: 'error'; snapshot: RuntimeCapacityControlSnapshot | null; error: string };

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
        // border-box, or width:100% + the horizontal padding OVERFLOWS the
        // drawer body by 14px and every trailing value (⌘, / version /
        // chevrons) ends ~1px from the panel edge (operator live-hit
        // 2026-07-16: "numbers are too close to the edge").
        boxSizing: 'border-box',
        minHeight: 30,
        border: 0,
        borderRadius: 9,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 7,
        paddingRight: 7,
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

function separatorStyle(): CSSProperties {
  return {
    height: 1,
    width: '100%',
    background: BORDER,
  };
}

/** Founding Operator mark — founders-only, drawer account row ONLY (Q ruling
 *  2026-07-27: founder identity shows only once settings is opened). Restyled
 *  2026-07-31 (Q: the bordered FOUNDING pill read too loud and sat glued to
 *  the drawer's right edge): now the quiet plain-dot vocabulary — one founding
 *  orange dot + the tabular serial, no box, breathing room from the edge. The
 *  full title lives in the tooltip. Hides while View-as-free is active because
 *  the effective entitlement's `founder` goes null under the override. */
const FOUNDER_ORANGE = '#ff5a1f';

function FoundingSerialChip({ operatorNumber }: { operatorNumber: number }) {
  const serial = String(operatorNumber).padStart(3, '0');
  return (
    <div
      title={`Founding Operator · No. ${serial}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        marginRight: 5,
        userSelect: 'none',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: FOUNDER_ORANGE, opacity: 0.9, flexShrink: 0 }} />
      <span
        style={{
          fontFamily: 'var(--font-sans-system)',
          fontSize: 10.5,
          fontWeight: 400,
          letterSpacing: '0.08em',
          color: 'var(--t-text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {serial}
      </span>
    </div>
  );
}

/**
 * Identity header for the quick drawer. Signed-out is a complete local profile;
 * account sign-in stays available as an optional account action.
 */
function AccountSection({ auth }: { auth: O8AuthState }) {
  const { founder } = useEntitlement();
  const [authError, setAuthError] = useState<DesktopAuthError | null>(() => getDesktopAuthError());

  useEffect(() => {
    return subscribeDesktopAuthError(() => {
      setAuthError(getDesktopAuthError());
    });
  }, []);

  useEffect(() => {
    if (auth.signedIn && authError) clearDesktopAuthError();
  }, [auth.signedIn, authError]);

  if (!auth.signedIn) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 7px 1px', minWidth: 0 }}>
          <IconFrame><Cpu size={15} /></IconFrame>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Local desktop profile
            </div>
            <div style={{ color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Free
            </div>
          </div>
          {founder ? <FoundingSerialChip operatorNumber={founder.operatorNumber} /> : null}
        </div>
        {auth.clerkEnabled ? (
          <RowButton onClick={auth.signIn}>
            <IconFrame><CircleUser size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Sign in to o8</span>
          </RowButton>
        ) : null}
        {authError ? <SignInErrorCard key={authError.id} authError={authError} onRetry={auth.signIn} /> : null}
        <div style={separatorStyle()} />
      </>
    );
  }

  const user = auth.user;
  const displayName = user?.name || user?.email || 'Signed in';
  return (
    <>
      {/* The identity header IS the manage-account affordance (Q ruling
          2026-07-16): a separate "Manage account" row doubled the same verb
          and made the drawer taller. Clicking your own name/avatar opens
          account management — one row shorter. */}
      <RowButton onClick={auth.openManageAccount}>
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
        <div style={{ flex: 1, minWidth: 0, paddingTop: 2, paddingBottom: 1 }}>
          <div style={{ color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayName}
          </div>
          {user?.email ? (
            <div style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </div>
          ) : null}
        </div>
        {founder ? <FoundingSerialChip operatorNumber={founder.operatorNumber} /> : null}
      </RowButton>

      <div style={separatorStyle()} />

      <RowButton onClick={() => { void auth.signOut(); }}>
        <IconFrame><LogOut size={13} /></IconFrame>
        <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Sign out</span>
      </RowButton>

      <div style={separatorStyle()} />
    </>
  );
}

// The merged Appearance control (palette segments + glass latch) lives in
// ./settings-quick-drawer/theme-rows.tsx (extracted for the 800-line ceiling).

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
  const { paletteId, setPalette, surface, setReduceTransparency, workspaceGlass, setWorkspaceGlass } = useTheme();
  // CLI usage telemetry is ungated (Q ruling 2026-07-31, supersedes the #1450
  // founders-mode visibility): it reads the operator's OWN local CLI files, so
  // neither an account nor an entitlement has any business gating it. The
  // /api/panel/cli-usage route stays operator-bearer gated as always.
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
        // The card mounts BEHIND this drawer's overlay — leaving the drawer
        // open made "Check for updates" feel like it did nothing (Q report
        // 2026-07-31). Found an update → get out of its way.
        window.setTimeout(onClose, 350);
      } else {
        setUpdateStatus('current');
        window.setTimeout(() => setUpdateStatus('idle'), 2600);
      }
    } catch {
      setUpdateStatus('idle');
    }
  }, [onClose]);

  const loadUsage = useCallback(async (preserveSnapshot = true, fresh = false) => {
    setUsageState((current) => ({
      status: 'loading',
      snapshot: preserveSnapshot ? current.snapshot : null,
      error: null,
    }));
    try {
      const res = await fetch(`/api/runtime/capacity${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data?.schema !== 'o8/runtime-capacity-control/v1') {
        throw new Error(data?.error || 'Capacity data unavailable');
      }
      setUsageState({ status: 'ready', snapshot: data as RuntimeCapacityControlSnapshot, error: null });
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
  // No sign-in requirement here (Q ruling 2026-07-31): this is the operator's
  // OWN local CLI telemetry (~/.codex + Claude session files) — an account
  // adds nothing to reading your own disk.
  const usageSummary = snapshot
    ? capacitySummary(snapshot)
    : usageState.status === 'loading'
      ? 'Syncing'
      : 'Local runtimes';

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

          {/* ONE merged Appearance row (Q ruling 2026-07-16): the Light/Dark
              segments carry the palette, the icon latch after the divider
              carries glass. Replaced the separate Theme + Glass rows — one
              row shorter, same one-click reach for every state. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, paddingLeft: 7, paddingRight: 7 }}>
            <IconFrame><ThemeContrastGlyph /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Appearance</span>
            <AppearanceControl paletteId={paletteId} setPalette={setPalette} surface={surface} setReduceTransparency={setReduceTransparency} allGlass={workspaceGlass} onLeaveAllGlass={() => setWorkspaceGlass(false)} />
          </div>

          <div style={separatorStyle()} />

          <RowButton
            ariaExpanded={usageOpen}
            onClick={() => {
              setUsageOpen((value) => !value);
            }}
          >
            <IconFrame><Gauge size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Runtime capacity</span>
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
            <CapacityRows
              snapshot={snapshot}
              loading={usageState.status === 'loading'}
              error={usageState.error}
              onRefresh={(fresh) => { void loadUsage(true, fresh); }}
            />
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
