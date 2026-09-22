'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsTab } from './shared';

export function useSettingsSectionNavigation(activeTab: SettingsTab, setActiveTab: (tab: SettingsTab) => void) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ tab: SettingsTab; section: string } | null>(null);
  const [notice, setNotice] = useState('');
  const navigate = useCallback((tab: SettingsTab, section?: string) => {
    setNotice('');
    setTarget(section ? { tab, section } : null);
    setActiveTab(tab);
    if (!section && contentRef.current) contentRef.current.scrollTop = 0;
  }, [setActiveTab]);

  useEffect(() => {
    if (!target || target.tab !== activeTab) return;
    const root = contentRef.current;
    if (!root) return;
    let complete = false;
    const jump = () => {
      const heading = Array.from(root.querySelectorAll<HTMLElement>('[data-settings-section]'))
        .find((element) => element.dataset.settingsSection === target.section);
      if (!heading) return false;
      let ancestor: HTMLElement | null = heading;
      while (ancestor && ancestor !== root) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      heading.tabIndex = -1;
      heading.scrollIntoView({ block: 'start', behavior: 'instant' });
      heading.focus({ preventScroll: true });
      complete = true;
      return true;
    };
    if (jump()) return;
    const observer = new MutationObserver(() => { if (!complete && jump()) observer.disconnect(); });
    observer.observe(root, { childList: true, subtree: true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      if (!complete) setNotice(`${target.section} is not available on this page right now.`);
    }, 5000);
    return () => { observer.disconnect(); clearTimeout(timeout); };
  }, [activeTab, target]);

  return { contentRef, navigate, notice };
}
