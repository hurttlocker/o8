import { useCallback, useEffect, useState } from 'react';
import type { NavSection } from '@/components/desktop/NavRail';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
import { readTimelineVisible, subscribeTimelineVisible } from '@/lib/appearance/timeline';

export function useUIChrome() {
  // ── Navigation ──
  const [activeNavSection, setActiveNavSection] = useState<NavSection>('agents');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('connectors');
  const [showMemoryView, setShowMemoryView] = useState(false);

  // ── Sidebar + Timeline ──
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [timelineVisible, setTimelineVisible] = useState(() => readTimelineVisible());

  // ── Overlay state ──
  const [alertTrayOpen, setAlertTrayOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [thoughtsOpen, setThoughtsOpen] = useState(false);

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

  // ── Cmd+J to toggle Thoughts Card ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable = Boolean(
        target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]'),
      );
      if (isEditable) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setThoughtsOpen(v => !v);
      }
      if (e.key === 'Escape') {
        setThoughtsOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Settings tab opener ──
  const handleOpenSettingsTab = useCallback((tab: SettingsTab) => {
    setShowMemoryView(false);
    setSettingsInitialTab(tab);
    setActiveNavSection('settings');
  }, []);

  return {
    // Navigation
    activeNavSection,
    setActiveNavSection,
    settingsInitialTab,
    setSettingsInitialTab,
    showMemoryView,
    setShowMemoryView,
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
    thoughtsOpen,
    setThoughtsOpen,

    // Draft injections
    desktopDraftInjection,
    setDesktopDraftInjection,
    thoughtsDraftInjection,
    setThoughtsDraftInjection,

    // Mobile
    mobileRemoteHref,
  };
}
