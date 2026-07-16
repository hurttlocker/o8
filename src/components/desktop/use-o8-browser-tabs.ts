'use client';

import { useSyncExternalStore } from 'react';
import { getBrowserPaneTabs, subscribeBrowserPaneTabs, type BrowserTab } from './O8BrowserPane';

export interface O8BrowserTab {
  id: string;
  url: string;
  title: string;
  /** Host shown as the row's trailing detail, e.g. `127.0.0.1:58929`. */
  host: string;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * The pages o8 owns, minus o8 itself.
 *
 * `o8Host` is passed in rather than read off `window` inside: the browser pane
 * seeds its tabs from detected localhost previews and o8 IS a localhost server,
 * so this filter is the only thing standing between the rail and o8 listing
 * itself as a page it opened (Q 2026-07-16: "never show the o8 port as a
 * browser"). A hidden `window` read would make that rule silently no-op
 * anywhere `window` is absent — including its own test.
 */
export function o8OwnedTabs(tabs: readonly BrowserTab[], o8Host: string | null): O8BrowserTab[] {
  const out: O8BrowserTab[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    const host = hostOf(tab.url);
    if (!host || (o8Host && host === o8Host)) continue;
    if (seen.has(tab.url)) continue;
    seen.add(tab.url);
    out.push({ id: tab.id, url: tab.url, title: tab.title?.trim() || host, host });
  }
  return out;
}

const EMPTY: O8BrowserTab[] = [];

/**
 * The pages o8 has open in its browser pane, minus o8 itself. Empty when o8
 * owns none — the Browser card hides rather than showing a placeholder.
 */
export function useO8BrowserTabs(scopeKey?: string): O8BrowserTab[] {
  const tabs = useSyncExternalStore(
    subscribeBrowserPaneTabs,
    () => getBrowserPaneTabs(scopeKey),
    () => getBrowserPaneTabs(scopeKey),
  );
  // Derived per render off a reference that only changes on a pane write, so
  // this stays cheap; the store snapshot is what React compares.
  const o8Host = typeof window === 'undefined' ? null : window.location.host;
  const owned = o8OwnedTabs(tabs, o8Host);
  return owned.length === 0 ? EMPTY : owned;
}
