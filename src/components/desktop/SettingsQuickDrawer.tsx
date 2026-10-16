'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleUser,
  ExternalLink,
  Globe,
  MessageSquare,
  Settings2,
} from './lucide-shims';
import { useTheme } from '@/lib/theme/context';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { OPEN_KEYBOARD_SHORTCUTS_EVENT, OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { ThemeContrastGlyph } from './settings-quick-drawer/theme-rows';
import { FloatingSurface } from './FloatingSurface';
import { useO8Auth } from '@/components/auth/O8AuthProvider';

const FONT = 'var(--font-sans-system)';
const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const DOCS_URL = 'https://o8.run';
// The canonical community invite — MUST match the README footer + o8.run
// (the drawer previously carried a different, stale invite).
const DISCORD_URL = 'https://o8.run/discord';
const ROW_HOVER_BG = 'var(--t-panel-hover, rgba(15, 23, 42, 0.04))';
const SUBTLE_BG = 'var(--t-bg-card, rgba(15, 23, 42, 0.04))';
const BORDER = 'var(--t-panel-border, rgba(15, 23, 42, 0.1))';
const TEXT = 'var(--t-text, #0f172a)';
const MUTED = 'var(--t-text-muted, #64748b)';
const FAINT = 'color-mix(in srgb, var(--t-text-muted, #64748b) 62%, transparent)';

interface SettingsQuickDrawerProps {
  id?: string;
  open: boolean;
  anchorRect: DOMRect | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts?: () => void;
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
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  ariaExpanded?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      disabled={disabled}
      aria-busy={disabled || undefined}
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
        cursor: disabled ? 'wait' : 'pointer',
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

export function SettingsQuickDrawer({
  id,
  open,
  anchorRect,
  onClose,
  onOpenSettings,
  onOpenShortcuts,
}: SettingsQuickDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const { paletteId, workspaceGlass, setPalette, setWorkspaceGlass, setReduceTransparency } = useTheme();
  const auth = useO8Auth();
  const openSettingsTab = (tab: string) => {
    onClose();
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_TAB_EVENT, { detail: { tab } }));
  };
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open || !mounted) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') ?? []);
    const first = focusable()[0];
    first?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') {
        const controls = focusable();
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
    };
  }, [onClose, open, mounted]);

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
    };
  }, [anchorRect]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      data-settings-quick-drawer-root="true"
      style={{ position: 'fixed', inset: 0, zIndex: 10999, pointerEvents: 'auto' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <FloatingSurface id={id} ref={panelRef} role="dialog" aria-modal="true" aria-label="Quick settings" style={panelStyle}
        contentStyle={{ maxHeight: 'inherit', overflow: 'hidden' }}>
        <div
          style={{
            maxHeight: 'inherit',
            overflowY: 'auto', scrollbarWidth: 'none',
            padding: 7,
            display: 'grid',
            gap: 4,
          }}
        >
          <RowButton disabled={!auth.isLoaded} onClick={() => {
            if (!auth.signedIn && auth.clerkEnabled) { onClose(); auth.signIn(); }
            else openSettingsTab('account');
          }}>
            <IconFrame><CircleUser size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Account</span>
            <ChevronRight size={12} color={MUTED} />
          </RowButton>

          <div style={separatorStyle()} />

          <RowButton onClick={onOpenSettings}>
            <IconFrame><Settings2 size={13} /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Settings</span>
            <span style={{ color: FAINT, fontFamily: MONO, fontSize: 10, fontWeight: 300, letterSpacing: '0.5px' }}>⌘,</span>
          </RowButton>

          <RowButton ariaExpanded={appearanceOpen} onClick={() => setAppearanceOpen(value => !value)}>
            <IconFrame><ThemeContrastGlyph /></IconFrame>
            <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Appearance</span>
            <span style={{ color: MUTED, fontSize: 10 }}>{workspaceGlass ? 'All Glass' : paletteId === 'light' ? 'Light Solid' : 'Dark Solid'}</span>
            {appearanceOpen ? <ChevronDown size={12} color={MUTED} /> : <ChevronRight size={12} color={MUTED} />}
          </RowButton>

          {appearanceOpen ? <div role="group" aria-label="Quick appearance" style={{ display: 'grid', gap: 2, paddingLeft: 25, paddingRight: 4 }}>
            {(['light', 'dark', 'glass'] as const).map(mode => {
              const selected = mode === 'glass' ? workspaceGlass : !workspaceGlass && paletteId === mode;
              return <button key={mode} type="button" aria-pressed={selected} onClick={() => {
                if (mode === 'glass') setWorkspaceGlass(true);
                else { setWorkspaceGlass(false); setPalette(mode); setReduceTransparency('on'); }
                onClose();
              }} style={{ minHeight: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                paddingLeft: 10, paddingRight: 8, border: 0, borderRadius: 8, background: selected ? ROW_HOVER_BG : 'transparent',
                color: TEXT, cursor: 'pointer', textAlign: 'left', font: 'inherit', fontSize: 12 }}>
                {mode === 'glass' ? 'All Glass' : mode === 'light' ? 'Light' : 'Dark'}
                {selected ? <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-accent)" strokeWidth="2"><path d="m5 12 4 4L19 6" /></svg> : null}
              </button>;
            })}
          </div> : null}

          <div style={separatorStyle()} />

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
              <RowButton onClick={() => {
                onClose();
                if (onOpenShortcuts) onOpenShortcuts();
                else window.dispatchEvent(new CustomEvent(OPEN_KEYBOARD_SHORTCUTS_EVENT));
              }}>
                <IconFrame><span aria-hidden="true" style={{ fontSize: 12 }}>?</span></IconFrame>
                <span style={{ flex: 1, color: TEXT, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>Keyboard shortcuts</span>
                <span style={{ color: FAINT, fontFamily: MONO, fontSize: 10 }}>⌘/</span>
              </RowButton>
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
      </FloatingSurface>
    </div>,
    document.body,
  );
}
