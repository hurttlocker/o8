import { useCallback, useEffect, useState } from 'react';
import type { NavSection } from '@/components/desktop/NavRail';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
import { readTimelineVisible, subscribeTimelineVisible } from '@/lib/appearance/timeline';

export function useUIChrome() {
  // ── Navigation ──
  const [activeNavSection, setActiveNavSection] = useState<NavSection>('agents');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('connectors');

  // ── Sidebar + Timeline ──
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [timelineVisible, setTimelineVisible] = useState(() => readTimelineVisible());

  // ── Overlay state ──
  const [alertTrayOpen, setAlertTrayOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // ── Draft injections ──
  const [desktopDraftInjection, setDesktopDraftInjection] = useState<{ id: string; text: string } | null>(null);
  const [thoughtsDraftInjection, setThoughtsDraftInjection] = useState<{ id: string; text: string } | null>(null);

  // ── Mobile remote href ──
  const [mobileRemoteHref, setMobileRemoteHref] = useState('/mobile');

  // ── Timeline visibility subscription ──
  useEffect(() => subscribeTimelineVisible(setTimelineVisible), []);

  // ── Resolve mobile remote href on mount ──
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot SSR-to-client origin sync */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setMobileRemoteHref(`${window.location.origin}/mobile`);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Cmd+J to toggle the orchestrator tile lives in page.tsx now — it needs
  // access to toggleThoughtsTile from the tile-layout hook.

  // ── Settings tab opener ──
  const handleOpenSettingsTab = useCallback((tab: SettingsTab) => {
    setSettingsInitialTab(tab);
    setActiveNavSection('settings');
  }, []);

  return {
    // Navigation
    activeNavSection,
    setActiveNavSection,
    settingsInitialTab,
    setSettingsInitialTab,
    handleOpenSettingsTab,

    // Sidebar + Timeline
    sidebarVisible,
    setSidebarVisible,
    timelineVisible,
    setTimelineVisible,

    // Overlays
    alertTrayOpen,
    setAlertTrayOpen,
    searchOpen,
    setSearchOpen,

    // Draft injections
    desktopDraftInjection,
    setDesktopDraftInjection,
    thoughtsDraftInjection,
    setThoughtsDraftInjection,

    // Mobile
    mobileRemoteHref,
  };
}
