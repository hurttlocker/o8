import { useCallback, useEffect, useState } from 'react';
import type { NavSection } from '@/app/dashboard/types';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
export function useUIChrome() {
  // ── Navigation ──
  const [activeNavSection, setActiveNavSection] = useState<NavSection>('agents');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general');

  // ── Sidebar ──
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // ── Overlay state ──
  const [searchOpen, setSearchOpen] = useState(false);

  // ── Draft injections ──
  const [desktopDraftInjection, setDesktopDraftInjection] = useState<{
    id: string;
    text: string;
    previewImageDataUri?: string;
  } | null>(null);
  const [thoughtsDraftInjection, setThoughtsDraftInjection] = useState<{ id: string; text: string } | null>(null);
  const [thoughtsImageInjection, setThoughtsImageInjection] = useState<{ id: string; dataUri: string; name: string; mimeType: string } | null>(null);

  // ── Mobile remote href ──
  const [mobileRemoteHref, setMobileRemoteHref] = useState('/mobile');

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

    // Sidebar
    sidebarVisible,
    setSidebarVisible,

    // Overlays
    searchOpen,
    setSearchOpen,

    // Draft injections
    desktopDraftInjection,
    setDesktopDraftInjection,
    thoughtsDraftInjection,
    setThoughtsDraftInjection,
    thoughtsImageInjection,
    setThoughtsImageInjection,

    // Mobile
    mobileRemoteHref,
  };
}
