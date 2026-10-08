'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { SmoothCorners } from '@lisse/react';
import { AutoFlash, ControlSlider, Delivery, HomeSimple } from 'iconoir-react';
import { CircleUser, Gauge, GitPullRequest, Play, Terminal, Settings2 as Settings } from '@/components/desktop/lucide-shims';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { SettingsQuickDrawer } from '@/components/desktop/SettingsQuickDrawer';
import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';
import type { NavSection } from '@/app/dashboard/types';
import { TrafficLightsOrSpacer } from './TrafficLights';
import { WORKSPACE_RAIL_CORNER_RADIUS, WORKSPACE_RAIL_CORNER_SMOOTHING } from '@/components/desktop/branch-rail-geometry';

function runtimeName(runtime: string): string {
  if (runtime === 'codex') return 'Codex';
  if (runtime === 'claude-code') return 'Claude';
  return runtime;
}

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

type RailNavAction = 'automations' | 'customize' | 'projects';

export function CompactNavigationRail({
  sidebarVisible, onToggleSidebar, activeDestination, glassSurface,
  onHome, onNewSession, onCreateTerminal, onOpenProjects, onOpenSettings, onOpenShortcuts, onOpenPRs,
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
}) {
  const auth = useO8Auth();
  const profileRef = useRef<HTMLButtonElement | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileAnchor, setProfileAnchor] = useState<DOMRect | null>(null);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  useEffect(() => {
    if (!profileOpen) return;
    const updateAnchor = () => setProfileAnchor(profileRef.current?.getBoundingClientRect() ?? null);
    window.addEventListener('resize', updateAnchor);
    return () => window.removeEventListener('resize', updateAnchor);
  }, [profileOpen]);
  const isGlass = glassSurface;
  const [usageOpen, setUsageOpen] = useState(false);
  const [usagePosition, setUsagePosition] = useState({ left: 0, bottom: 0 });
  const [usageSnapshot, setUsageSnapshot] = useState<RuntimeCapacityControlSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
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
  useEffect(() => {
    if (!usageOpen) return;
    const controller = new AbortController();
    const loadUsage = async () => {
      setUsageLoading(true);
      try {
        const response = await fetch('/api/runtime/capacity', { cache: 'no-store', signal: controller.signal });
        const payload = await response.json() as RuntimeCapacityControlSnapshot & { error?: string };
        if (!response.ok || payload.schema !== 'o8/runtime-capacity-control/v1') {
          throw new Error(payload.error || 'Runtime usage unavailable');
        }
        if (controller.signal.aborted) return;
        setUsageSnapshot(payload);
        setUsageError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setUsageError(error instanceof Error ? error.message : 'Runtime usage unavailable');
      } finally {
        if (!controller.signal.aborted) setUsageLoading(false);
      }
    };
    void loadUsage();
    const refresh = window.setInterval(() => { void loadUsage(); }, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [usageOpen]);
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
    window.dispatchEvent(new CustomEvent(`o8:open-${action}`));
  };
  const navItems = [
    { id: 'automations', label: 'Automations', icon: <AutoFlash width={19} height={19} strokeWidth={1.8} /> },
    { id: 'customize', label: 'Customize', icon: <ControlSlider width={19} height={19} strokeWidth={1.8} /> },
    { id: 'projects', label: 'Projects', icon: <Delivery width={19} height={19} strokeWidth={1.8} /> },
  ] as const;

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
        {navItems.map((item) => (
          <button key={item.id} type="button" aria-label={item.label} title={item.label} aria-current={activeDestination === item.id ? 'page' : undefined} onClick={() => openNav(item.id)} style={{ ...railButton, flexShrink: 0, background: activeDestination === item.id ? 'var(--t-hover)' : 'transparent' }}>{item.icon}</button>
        ))}
        <button type="button" aria-label="PRs" title="Pull requests" onClick={onOpenPRs} style={{ ...railButton, flexShrink: 0 }}><GitPullRequest size={19} strokeWidth={1.8} /></button>
      </div>
      <div style={{ width: 27, height: 1, marginTop: 6, marginBottom: 6, flexShrink: 0, background: 'var(--t-divider-subtle)' }} />
      <div aria-hidden="true" style={{ flex: 1, minHeight: 0 }} />
      <button type="button" aria-label="Settings" title="Settings" aria-current={activeDestination === 'settings' ? 'page' : undefined} onClick={onOpenSettings} style={railButton}><Settings size={19} strokeWidth={1.8} /></button>
      <button
        type="button"
        aria-label="Runtime usage"
        aria-describedby={usageOpen ? 'o8-rail-usage-tooltip' : undefined}
        title="Runtime usage"
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
        <div
          id="o8-rail-usage-tooltip"
          role="tooltip"
          data-mcp-scope="rail-usage-preview"
          onMouseEnter={cancelUsageClose}
          onMouseLeave={scheduleUsageClose}
          style={{
            position: 'fixed',
            left: usagePosition.left,
            bottom: usagePosition.bottom,
            width: 284,
            maxHeight: 'min(360px, calc(100vh - 24px))',
            border: `1px solid ${isGlass ? 'var(--t-border)' : 'var(--t-divider-subtle)'}`,
            borderRadius: WORKSPACE_RAIL_CORNER_RADIUS,
            boxShadow: '0 18px 48px rgba(15, 23, 42, 0.32), 0 4px 14px rgba(15, 23, 42, 0.16)',
            color: 'var(--t-text)',
            fontFamily: 'var(--font-sans-system)',
            zIndex: 210,
            ...(isGlass ? {
              ['--t-text' as string]: '#e8ecf2',
              ['--t-text-secondary' as string]: '#bcc5d0',
              ['--t-text-muted' as string]: '#8b95a3',
            } : {}),
          } as CSSProperties}
        >
          <SmoothCorners
            corners={{ radius: WORKSPACE_RAIL_CORNER_RADIUS, smoothing: WORKSPACE_RAIL_CORNER_SMOOTHING }}
            autoEffects={false}
            style={{
              maxHeight: 'min(360px, calc(100vh - 24px))',
              overflowY: 'auto', scrollbarWidth: 'none',
              background: isGlass ? 'var(--t-bg)' : 'var(--t-panel-solid)',
              backdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
              WebkitBackdropFilter: isGlass ? 'blur(18px) saturate(1.15)' : undefined,
            } as CSSProperties}
          >
            <div style={{ paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 400 }}>Runtime usage</span>
                <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{usageLoading ? 'Updating…' : usageSnapshot ? 'Local CLI data' : 'Loading…'}</span>
              </div>
              {usageSnapshot?.capacities.map((capacity, index) => (
                <div key={`${capacity.runtime}:${capacity.identityId ?? index}`} style={{ display: 'grid', gap: 7, borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
                    <span>{runtimeName(capacity.runtime)}</span>
                    <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>
                      {capacity.status === 'stale' ? 'Stale' : capacity.status === 'available' ? capacity.confidence === 'exact' ? 'Exact' : 'Estimated' : 'Unavailable'}
                    </span>
                  </div>
                  {capacity.buckets.length > 0 ? capacity.buckets.map((bucket) => (
                    <div key={bucket.id} style={{ display: 'grid', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--t-text-secondary)', fontSize: 10.5 }}>
                        <span>{bucket.label}</span>
                        <span>{typeof bucket.usedRatio === 'number'
                          ? `${Math.round(bucket.usedRatio * 100)}% used`
                          : typeof bucket.remaining === 'number'
                            ? `${bucket.remaining} remaining`
                            : typeof bucket.used === 'number' && bucket.unit
                              ? `${bucket.used} ${bucket.unit} used`
                              : 'No quota total'}</span>
                      </div>
                      {typeof bucket.usedRatio === 'number' ? (
                        <div aria-hidden="true" style={{ height: 2, borderRadius: 2, background: 'var(--t-divider-subtle)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.max(0, Math.min(1, bucket.usedRatio)) * 100}%`, background: bucket.usedRatio >= 0.8 ? 'var(--t-brand-orange)' : 'var(--t-accent)' }} />
                        </div>
                      ) : null}
                    </div>
                  )) : <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>{capacity.reason?.replaceAll('_', ' ') ?? 'No observation'}</span>}
                </div>
              ))}
              {usageSnapshot?.capacities.length === 0 ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>No runtime capacity reported</span> : null}
              {!usageSnapshot && usageLoading ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>Reading connected runtimes…</span> : null}
              {usageError ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10.5 }}>{usageError}</span> : null}
            </div>
          </SmoothCorners>
        </div>,
        document.body,
      ) : null}
      <button
        ref={profileRef}
        id="o8-profile-menu-button"
        type="button"
        aria-label="Open quick settings"
        aria-haspopup="dialog"
        aria-expanded={profileOpen}
        aria-controls={profileOpen ? 'o8-rail-quick-settings' : undefined}
        title="Quick settings"
        onClick={() => {
          setUsageOpen(false);
          profileRef.current?.focus();
          setProfileAnchor(profileRef.current?.getBoundingClientRect() ?? null);
          setProfileOpen((open) => !open);
        }}
        style={{ ...railButton, flexShrink: 0, color: auth.signedIn ? 'var(--t-text)' : 'var(--t-text-muted)' }}
      >{auth.signedIn && auth.user?.avatarUrl ? <Image src={auth.user.avatarUrl} alt="" width={27} height={27} unoptimized style={{ width: 27, height: 27, borderRadius: '50%', objectFit: 'cover' }} /> : <CircleUser size={22} strokeWidth={1.7} />}</button>
    </nav>
    <SettingsQuickDrawer
      id="o8-rail-quick-settings"
      open={profileOpen}
      anchorRect={profileAnchor}
      onClose={closeProfile}
      onOpenSettings={() => { closeProfile(); onOpenSettings(); }}
      onOpenShortcuts={onOpenShortcuts}
    />
    </>
  );
}
