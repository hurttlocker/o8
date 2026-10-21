'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsTab } from './shared';

export function useSettingsSectionNavigation(activeTab: SettingsTab, setActiveTab: (tab: SettingsTab) => void) {
  const contentRef = useRef<HTMLDivElement>(null);
  const navigationId = useRef(0);
  const [target, setTarget] = useState<{ tab: SettingsTab; section?: string; scrollTop?: number; id: number } | null>(null);
  const [history, setHistory] = useState({ entries: [{ tab: activeTab, scrollTop: 0 }], index: 0 });
  const [notice, setNotice] = useState('');
  const navigate = useCallback((tab: SettingsTab, section?: string) => {
    const scrollTop = contentRef.current?.scrollTop ?? 0;
    setHistory(current => {
      const entries = current.entries.map((entry, index) => index === current.index ? { ...entry, scrollTop } : entry);
      if (tab === entries[current.index].tab && !section) return { ...current, entries };
      return { entries: [...entries.slice(0, current.index + 1), { tab, scrollTop: 0 }].slice(-100), index: Math.min(current.index + 1, 99) };
    });
    setNotice('');
    setTarget(section ? { tab, section, id: ++navigationId.current } : null);
    setActiveTab(tab);
    if (!section && contentRef.current) contentRef.current.scrollTop = 0;
  }, [setActiveTab]);

  const move = useCallback((direction: -1 | 1) => {
    const index = history.index + direction;
    const destination = history.entries[index];
    if (!destination) return;
    const scrollTop = contentRef.current?.scrollTop ?? 0;
    setHistory({ entries: history.entries.map((entry, cursor) => cursor === history.index ? { ...entry, scrollTop } : entry), index });
    setNotice('');
    setTarget({ ...destination, id: ++navigationId.current });
    setActiveTab(destination.tab);
  }, [history, setActiveTab]);

  useEffect(() => {
    if (!target || target.tab !== activeTab) return;
    const root = contentRef.current;
    if (!root) return;
    let complete = false;
    const jump = () => {
      if (target.scrollTop !== undefined) {
        root.scrollTop = target.scrollTop;
        complete = root.scrollHeight - root.clientHeight >= target.scrollTop;
        return complete;
      }
      const heading = Array.from(root.querySelectorAll<HTMLElement>('[data-settings-section]'))
        .find((element) => !element.closest('[hidden]') && element.dataset.settingsSection === target.section);
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
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    const timeout = setTimeout(() => {
      observer.disconnect();
      if (!complete && target.section) setNotice(`${target.section} is not available on this page right now.`);
    }, 5000);
    return () => { observer.disconnect(); clearTimeout(timeout); };
  }, [activeTab, target]);

  return { contentRef, navigate, notice, targetSection: target?.tab === activeTab ? target.section : undefined, navigationId: target?.id,
    canBack: history.index > 0, canForward: history.index < history.entries.length - 1,
    back: () => move(-1), forward: () => move(1) };
}
