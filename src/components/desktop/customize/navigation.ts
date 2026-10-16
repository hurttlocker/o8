'use client';

import { useSyncExternalStore } from 'react';
import type { CustomizeTab } from './CustomizeHeader';

let currentTab: CustomizeTab = 'rules';
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function setCustomizeTab(tab: CustomizeTab) {
  if (currentTab === tab) return;
  currentTab = tab;
  listeners.forEach(listener => listener());
}
export function useCustomizeTab() {
  return [useSyncExternalStore(subscribe, () => currentTab, () => 'rules' as CustomizeTab), setCustomizeTab] as const;
}
export function openCustomizeTab(tab?: CustomizeTab) {
  if (tab && tab !== 'plugins') setCustomizeTab(tab);
  if (!tab && currentTab === 'plugins') setCustomizeTab('rules');
  window.dispatchEvent(new CustomEvent('o8:open-customize', { detail: { tab: tab ?? currentTab } }));
}
