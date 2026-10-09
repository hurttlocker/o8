'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { AutoFlash, HomeSimple } from 'iconoir-react';
import { CircleUser, Download, Gauge, GitPullRequest, Play, Terminal, Settings2 as Settings } from '@/components/desktop/lucide-shims';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { SettingsQuickDrawer } from '@/components/desktop/SettingsQuickDrawer';
import { FloatingSurface } from '@/components/desktop/FloatingSurface';
import { RuntimeUsageSummary } from '@/components/desktop/analytics/RuntimeUsageSummary';
import { useRuntimeUsage } from '@/components/desktop/analytics/use-runtime-usage';
import type { NavSection } from '@/app/dashboard/types';
import { TrafficLightsOrSpacer } from './TrafficLights';
import { RailMoreMenu } from './RailMoreMenu';
import { openCustomizeTab, useCustomizeTab } from '../customize/navigation';

const railButton: CSSProperties = {
  position: 'relative',
  width: 44,
  height: 44,
  minWidth: 44,
  minHeight: 44,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 0,
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--t-text)',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans-system)',
};

type RailNavAction = 'automations' | 'customize' | 'projects' | 'plugins';

export function CompactNavigationRail({
  sidebarVisible, onToggleSidebar, activeDestination, glassSurface,
  onHome, onNewSession, onCreateTerminal, onOpenProjects, onOpenSettings, onOpenShortcuts, onOpenPRs, onOpenUsage,
}: {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  activeDestination: NavSection;
  glassSurface: boolean;
  onHome: () => void;
  onNewSession: () => void;
  onCreateTerminal: () => void;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenPRs: () => void;
  onOpenUsage: () => void;
}) {
  const auth = useO8Auth();
  const profileRef = useRef<HTMLButtonElement | null>(null);
  const updatesRef = useRef<HTMLButtonElement | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [focusUpdates, setFocusUpdates] = useState(false);
  const [customizeTab] = useCustomizeTab();
  const [profileAnchor, setProfileAnchor] = useState<DOMRect | null>(null);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  useEffect(() => {
    if (!profileOpen) return;
    const updateAnchor = () => setProfileAnchor((focusUpdates ? updatesRef : profileRef).current?.getBoundingClientRect() ?? null);
    window.addEventListener('resize', updateAnchor);
    return () => window.removeEventListener('resize', updateAnchor);
  }, [profileOpen, focusUpdates]);
  const isGlass = glassSurface;
  const [usageOpen, setUsageOpen] = useState(false);
  const [usagePosition, setUsagePosition] = useState({ left: 0, bottom: 0 });
  const { snapshot: usageSnapshot, loading: usageLoading, error: usageError } = useRuntimeUsage(usageOpen);
  const usageCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownUsageRatios = usageSnapshot?.capacities.flatMap((capacity) =>
    capacity.status === 'available'
      ? capacity.buckets.flatMap((bucket) => typeof bucket.usedRatio === 'number' ? [bucket.usedRatio] : [])
      : [],
  ) ?? [];
  const highestKnownUsage = knownUsageRatios.length > 0 ? Math.max(...knownUsageRatios) : null;
  const usageMeterColor = highestKnownUsage !== null && highestKnownUsage >= 0.8
    ? 'var(--t-brand-orange)'
    : 'var(--t-accent)';
  const cancelUsageClose = useCallback(() => {
    if (usageCloseTimerRef.current) clearTimeout(usageCloseTimerRef.current);
    usageCloseTimerRef.current = null;
  }, []);
  const scheduleUsageClose = useCallback(() => {
    cancelUsageClose();
    usageCloseTimerRef.current = setTimeout(() => setUsageOpen(false), 160);
  }, [cancelUsageClose]);
  useEffect(() => () => cancelUsageClose(), [cancelUsageClose]);
  const showUsage = (button: HTMLButtonElement) => {
    cancelUsageClose();
    const rect = button.getBoundingClientRect();
    setUsagePosition({
      left: Math.max(12, Math.min(rect.right + 16, window.innerWidth - 300)),
      bottom: Math.max(12, window.innerHeight - rect.bottom),
    });
    setUsageOpen(true);
  };
  const openNav = (action: RailNavAction) => {
    setUsageOpen(false);
    if (action === 'projects') {
      onOpenProjects?.();
      return;
    }
    if (action === 'customize' || action === 'plugins') {
      openCustomizeTab(action === 'plugins' ? 'plugins' : undefined);
      return;
    }
    window.dispatchEvent(new CustomEvent(`o8:open-${action}`));
  };
  const openQuickSettings = (button: HTMLButtonElement, updates: boolean) => {
    setUsageOpen(false);
    button.focus();
    setProfileAnchor(button.getBoundingClientRect());
    setFocusUpdates(updates);
    setProfileOpen(current => !current || focusUpdates !== updates);
  };

  return (
    <>
    <div data-mcp-scope="navigation-window-controls" style={{ position: 'fixed', top: 0, left: 0, width: 68, height: 36, display: 'flex', alignItems: 'center', paddingLeft: 8, WebkitAppRegion: 'drag', zIndex: 190 } as CSSProperties}>
      <TrafficLightsOrSpacer leadInPx={6} yNudge={3.3} />
    </div>
    <nav
      data-mcp-scope="compact-navigation-rail"
      data-chrome-surface={isGlass ? 'true' : undefined}
      data-vibrancy-passthrough={isGlass ? 'true' : undefined}
      aria-label="Workspace navigation"
      style={{
        position: 'fixed',
        top: 44,
        bottom: 8,
        left: 8,
        width: 56,
        zIndex: 190,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 8,
        border: isGlass ? '1px solid transparent' : '1px solid var(--t-divider-subtle)',
        borderRadius: 16,
        background: isGlass ? 'transparent' : 'var(--t-panel-solid)',
        boxShadow: 'none',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <button type="button" aria-label="Home" title="Workspace" aria-current={activeDestination === 'agents' ? 'page' : undefined} onClick={onHome} style={railButton}><HomeSimple width={20} height={20} strokeWidth={1.8} /></button>
      <button type="button" aria-label="New session" title="New session" onClick={onNewSession} style={railButton}><Play size={19} strokeWidth={1.8} /></button>
      <button type="button" aria-label="Terminal" title="Terminal" onClick={onCreateTerminal} style={railButton}><Terminal size={19} strokeWidth={1.8} /></button>
      <button id="o8-chat-list-toggle" type="button" aria-label={sidebarVisible ? 'Hide chats' : 'Show chats'} title={sidebarVisible ? 'Hide chats' : 'Show chats'} aria-expanded={sidebarVisible} aria-controls="o8-chat-list" onClick={onToggleSidebar} style={{ ...railButton, background: sidebarVisible ? 'var(--t-hover)' : 'transparent' }}>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>
      </button>
      <div style={{ width: 27, height: 1, marginTop: 6, marginBottom: 6, flexShrink: 0, background: 'var(--t-divider-subtle)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: 0, flexShrink: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
        <button type="button" aria-label="Automations" title="Automations" aria-current={activeDestination === 'automations' ? 'page' : undefined}
          onClick={() => openNav('automations')} style={{ ...railButton, flexShrink: 0, background: activeDestination === 'automations' ? 'var(--t-hover)' : 'transparent' }}><AutoFlash width={19} height={19} strokeWidth={1.8} /></button>
        <button type="button" aria-label="Plugins" title="Plugins" aria-current={activeDestination === 'customize' && customizeTab === 'plugins' ? 'page' : undefined}
          onClick={() => openNav('plugins')} style={{ ...railButton, flexShrink: 0, background: activeDestination === 'customize' && customizeTab === 'plugins' ? 'var(--t-hover)' : 'transparent' }}>
          <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3a3 3 0 1 1 0 6v3a2 2 0 0 0 2 2h3a3 3 0 1 1 6 0h3a2 2 0 0 0 2-2v-3a3 3 0 1 0 0-6V5a2 2 0 0 0-2-2h-3a3 3 0 1 0-6 0Z" /></svg>
        </button>
        <RailMoreMenu buttonStyle={railButton} selected={activeDestination === 'projects' ? 'projects'
          : activeDestination === 'customize' && customizeTab !== 'plugins' ? 'customize' : null}
          onProjects={() => openNav('projects')} onCustomize={() => openNav('customize')} />
        <button type="button" aria-label="PRs" title="Pull requests" onClick={onOpenPRs} style={{ ...railButton, flexShrink: 0 }}><GitPullRequest size={19} strokeWidth={1.8} /></button>
      </div>
      <div style={{ width: 27, height: 1, marginTop: 6, marginBottom: 6, flexShrink: 0, background: 'var(--t-divider-subtle)' }} />
      <div aria-hidden="true" style={{ flex: 1, minHeight: 0 }} />
      <button type="button" aria-label="Settings" title="Settings" aria-current={activeDestination === 'settings' ? 'page' : undefined} onClick={onOpenSettings} style={railButton}><Settings size={19} strokeWidth={1.8} /></button>
      <button
        type="button"
        aria-label="Runtime usage"
        aria-describedby={usageOpen ? 'o8-rail-usage-tooltip' : undefined}
        title="Usage — click to open"
        onClick={() => { cancelUsageClose(); setUsageOpen(false); onOpenUsage(); }}
        onMouseEnter={(event) => showUsage(event.currentTarget)}
        onMouseLeave={scheduleUsageClose}
        onFocus={(event) => showUsage(event.currentTarget)}
        onBlur={scheduleUsageClose}
        onKeyDown={(event) => { if (event.key === 'Escape') setUsageOpen(false); }}
        style={{ ...railButton, flexShrink: 0, color: highestKnownUsage !== null && highestKnownUsage >= 0.8 ? 'var(--t-brand-orange)' : 'var(--t-text-muted)' }}
      >
        <Gauge size={18} strokeWidth={1.7} />
        <span aria-hidden="true" style={{ position: 'absolute', bottom: 4, left: 14, width: 12, height: 2, borderRadius: 2, background: 'var(--t-divider-subtle)', overflow: 'hidden' }}>
          {highestKnownUsage !== null ? <span style={{ display: 'block', width: `${Math.max(0, Math.min(1, highestKnownUsage)) * 100}%`, height: '100%', background: usageMeterColor }} /> : null}
        </span>
      </button>
      {usageOpen && typeof document !== 'undefined' ? createPortal(
        <FloatingSurface
          id="o8-rail-usage-tooltip"
          role="tooltip"
          data-mcp-scope="rail-usage-preview"
          glass={isGlass}
          contentStyle={{ maxHeight: 'min(360px, calc(100vh - 24px))', overflowY: 'auto', scrollbarWidth: 'none' }}
          onMouseEnter={cancelUsageClose}
          onMouseLeave={scheduleUsageClose}
          style={{
            position: 'fixed',
            left: usagePosition.left,
            bottom: usagePosition.bottom,
            width: 284,
            maxHeight: 'min(360px, calc(100vh - 24px))',
            zIndex: 210,
          } as CSSProperties}
        >
            <div style={{ paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 400 }}>Runtime usage</span>
                <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{usageLoading ? 'Updating…' : usageSnapshot ? 'Connected accounts' : 'Loading…'}</span>
              </div>
              <RuntimeUsageSummary snapshot={usageSnapshot} compact />
              <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>Click the meter to open Usage</span>
              {!usageSnapshot && usageLoading ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>Reading connected runtimes…</span> : null}
              {usageError ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>{usageError}</span> : null}
            </div>
        </FloatingSurface>,
        document.body,
      ) : null}
      <button ref={updatesRef} type="button" aria-label="Updates" title="Updates" aria-haspopup="dialog"
        aria-expanded={profileOpen && focusUpdates} aria-controls={profileOpen && focusUpdates ? 'o8-rail-quick-settings' : undefined}
        onClick={event => openQuickSettings(event.currentTarget, true)} style={{ ...railButton, flexShrink: 0 }}>
        <span aria-hidden="true" style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: '50%', color: 'var(--t-accent)', background: 'var(--t-hover)' }}><Download size={17} strokeWidth={1.7} /></span>
      </button>
      <button
        ref={profileRef}
        id="o8-profile-menu-button"
        type="button"
        aria-label="Open quick settings"
        aria-haspopup="dialog"
        aria-expanded={profileOpen && !focusUpdates}
        aria-controls={profileOpen && !focusUpdates ? 'o8-rail-quick-settings' : undefined}
        title="Quick settings"
        onClick={event => openQuickSettings(event.currentTarget, false)}
        style={{ ...railButton, flexShrink: 0, color: auth.signedIn ? 'var(--t-text)' : 'var(--t-text-muted)' }}
      >{auth.signedIn && auth.user?.avatarUrl ? <Image src={auth.user.avatarUrl} alt="" width={27} height={27} unoptimized style={{ width: 27, height: 27, borderRadius: '50%', objectFit: 'cover' }} /> : <CircleUser size={22} strokeWidth={1.7} />}</button>
    </nav>
    <SettingsQuickDrawer
      id="o8-rail-quick-settings"
      open={profileOpen}
      anchorRect={profileAnchor}
      onClose={closeProfile}
      focusUpdates={focusUpdates}
      onOpenSettings={() => { closeProfile(); onOpenSettings(); }}
      onOpenShortcuts={onOpenShortcuts}
    />
    </>
  );
}
