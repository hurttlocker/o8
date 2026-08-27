export const BROWSER_PANE_STORAGE_KEY = 'o8:browser-pane-state:v1';
export const BROWSER_PANE_STATE_VERSION = 1;
export const BROWSER_PANE_MAX_SCOPES = 24;
export const BROWSER_PANE_MAX_TABS_PER_SCOPE = 20;
export const BROWSER_PANE_STALE_AFTER_MS = 45 * 24 * 60 * 60 * 1_000;

export type BrowserTabSurface = 'embedded' | 'engine' | 'native';

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  surface?: BrowserTabSurface;
  redacted?: boolean;
}

export interface BrowserPaneStateSnapshot {
  tabs: BrowserTab[];
  activeTabId: string | null;
  activeUrl: string | null;
}

interface StoredBrowserPaneScope extends BrowserPaneStateSnapshot {
  scopeKey: string;
  updatedAt: number;
}

interface StoredBrowserPaneDocument {
  version: typeof BROWSER_PANE_STATE_VERSION;
  scopes: StoredBrowserPaneScope[];
}

const DEFAULT_STATE_SCOPE_KEY = 'right-panel';
const browserPaneStateStore = new Map<string, BrowserPaneStateSnapshot>();
const hydratedBrowserPaneScopes = new Set<string>();
const browserPaneListeners = new Set<() => void>();
const NO_BROWSER_TABS: readonly BrowserTab[] = Object.freeze([]);
const SENSITIVE_QUERY_VALUE = /^(bearer\s+|sk-|gh[pousr]_|eyJ[a-zA-Z0-9_-]+\.|[a-zA-Z0-9_-]{48,}\.[a-zA-Z0-9_-]{12,})/i;
const SENSITIVE_QUERY_NAME_PARTS = [
  'accesskey',
  'apikey',
  'authorization',
  'credential',
  'jwt',
  'keypair',
  'password',
  'passwd',
  'secret',
  'session',
  'signature',
  'ticket',
  'token',
];

export function normalizeBrowserPaneScopeKey(key?: string): string {
  const trimmed = key?.trim();
  return trimmed || DEFAULT_STATE_SCOPE_KEY;
}

function browserPaneStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function cloneTabs(tabs: readonly BrowserTab[]): BrowserTab[] {
  return tabs.map((tab) => ({ ...tab }));
}

function isBrowserTabSurface(value: unknown): value is BrowserTabSurface {
  return value === 'embedded' || value === 'engine' || value === 'native';
}

function normalizeStoredTab(value: unknown): BrowserTab | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<BrowserTab>;
  if (typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 160) return null;
  if (typeof candidate.url !== 'string' || candidate.url.length > 4_096) return null;
  if (typeof candidate.title !== 'string' || candidate.title.length > 300) return null;
  return durableTab({
    id: candidate.id,
    url: candidate.url,
    title: candidate.title,
    surface: isBrowserTabSurface(candidate.surface) ? candidate.surface : 'embedded',
    redacted: candidate.redacted === true,
  });
}

function normalizeStoredScope(value: unknown): StoredBrowserPaneScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredBrowserPaneScope>;
  if (typeof candidate.scopeKey !== 'string' || !candidate.scopeKey.trim()) return null;
  if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) return null;
  if (!Array.isArray(candidate.tabs)) return null;
  const tabs = candidate.tabs
    .map(normalizeStoredTab)
    .filter((tab): tab is BrowserTab => tab !== null)
    .slice(0, BROWSER_PANE_MAX_TABS_PER_SCOPE);
  const requestedActiveTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null;
  const requestedActiveUrl = typeof candidate.activeUrl === 'string' ? candidate.activeUrl : null;
  const activeTab = tabs.find((tab) => tab.id === requestedActiveTabId)
    ?? tabs.find((tab) => tab.url === requestedActiveUrl)
    ?? tabs[0]
    ?? null;
  return {
    scopeKey: normalizeBrowserPaneScopeKey(candidate.scopeKey),
    updatedAt: candidate.updatedAt,
    tabs,
    activeTabId: activeTab?.id ?? null,
    activeUrl: activeTab?.url ?? null,
  };
}

function readStoredDocument(): StoredBrowserPaneDocument | null {
  const storage = browserPaneStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(BROWSER_PANE_STORAGE_KEY);
    if (!raw) return { version: BROWSER_PANE_STATE_VERSION, scopes: [] };
    const parsed = JSON.parse(raw) as Partial<StoredBrowserPaneDocument>;
    if (parsed.version !== BROWSER_PANE_STATE_VERSION || !Array.isArray(parsed.scopes)) {
      storage.removeItem(BROWSER_PANE_STORAGE_KEY);
      return null;
    }
    return {
      version: BROWSER_PANE_STATE_VERSION,
      scopes: parsed.scopes
        .map(normalizeStoredScope)
        .filter((scope): scope is StoredBrowserPaneScope => scope !== null),
    };
  } catch {
    try { storage.removeItem(BROWSER_PANE_STORAGE_KEY); } catch { /* storage is unavailable */ }
    return null;
  }
}

function normalizedSnapshot(snapshot: BrowserPaneStateSnapshot): BrowserPaneStateSnapshot {
  const tabs = cloneTabs(snapshot.tabs);
  const activeFromId = tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null;
  const activeFromUrl = snapshot.activeUrl
    ? tabs.find((tab) => tab.url === snapshot.activeUrl) ?? null
    : null;
  const activeTab = activeFromId ?? activeFromUrl ?? tabs[0] ?? null;
  return {
    tabs,
    activeTabId: activeTab?.id ?? null,
    activeUrl: activeTab?.url ?? null,
  };
}

function containsSensitiveQuery(url: URL): boolean {
  for (const [name, value] of url.searchParams) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const sensitiveName = normalizedName === 'auth'
      || normalizedName === 'code'
      || normalizedName === 'key'
      || normalizedName === 'sig'
      || normalizedName === 'state'
      || normalizedName.startsWith('xamz')
      || normalizedName.startsWith('xgoog')
      || SENSITIVE_QUERY_NAME_PARTS.some((part) => normalizedName.includes(part));
    if (sensitiveName || SENSITIVE_QUERY_VALUE.test(value) || value.length > 96) {
      return true;
    }
  }
  return false;
}

function durableTab(tab: BrowserTab): BrowserTab {
  const base: BrowserTab = {
    id: tab.id.slice(0, 160),
    url: '',
    title: tab.title.slice(0, 300),
    surface: tab.surface ?? 'embedded',
    redacted: false,
  };
  if (!tab.url) return { ...base, redacted: tab.redacted === true };
  try {
    const parsed = new URL(tab.url);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username || parsed.password || containsSensitiveQuery(parsed)) {
      return { ...base, title: 'Navigation required', redacted: true };
    }
    parsed.hash = '';
    return { ...base, url: parsed.toString() };
  } catch {
    return { ...base, title: 'Navigation required', redacted: true };
  }
}

function writeStoredScope(scopeKey: string, snapshot: BrowserPaneStateSnapshot): void {
  const storage = browserPaneStorage();
  if (!storage) return;
  const document = readStoredDocument() ?? { version: BROWSER_PANE_STATE_VERSION, scopes: [] };
  const now = Date.now();
  const tabs = snapshot.tabs.slice(0, BROWSER_PANE_MAX_TABS_PER_SCOPE).map(durableTab);
  const activeTab = tabs.find((tab) => tab.id === snapshot.activeTabId) ?? tabs[0] ?? null;
  const current: StoredBrowserPaneScope = {
    scopeKey,
    updatedAt: now,
    tabs,
    activeTabId: activeTab?.id ?? null,
    activeUrl: activeTab?.url ?? null,
  };
  // Retain the 24 most recently touched scopes for 45 days. The current scope
  // is retained even when it is empty so a deliberately closed preview does
  // not return on the next launch.
  const scopes = [current, ...document.scopes.filter((scope) => (
    scope.scopeKey !== scopeKey && now - scope.updatedAt <= BROWSER_PANE_STALE_AFTER_MS
  ))]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, BROWSER_PANE_MAX_SCOPES);
  try {
    // Web Storage replaces one key atomically, so a crash observes either the
    // previous complete document or this complete document, never a partial JSON write.
    storage.setItem(BROWSER_PANE_STORAGE_KEY, JSON.stringify({
      version: BROWSER_PANE_STATE_VERSION,
      scopes,
    } satisfies StoredBrowserPaneDocument));
  } catch {
    // The live in-memory workspace remains usable when storage is unavailable or full.
  }
}

export function readBrowserPaneState(scopeKey: string): BrowserPaneStateSnapshot | null {
  const normalizedKey = normalizeBrowserPaneScopeKey(scopeKey);
  if (!hydratedBrowserPaneScopes.has(normalizedKey)) {
    const stored = readStoredDocument()?.scopes.find((scope) => scope.scopeKey === normalizedKey);
    if (stored) browserPaneStateStore.set(normalizedKey, normalizedSnapshot(stored));
    hydratedBrowserPaneScopes.add(normalizedKey);
  }
  const snapshot = browserPaneStateStore.get(normalizedKey);
  return snapshot ? normalizedSnapshot(snapshot) : null;
}

export function writeBrowserPaneState(
  scopeKey: string,
  tabs: readonly BrowserTab[],
  activeTabId: string | null,
): void {
  const normalizedKey = normalizeBrowserPaneScopeKey(scopeKey);
  const snapshot = normalizedSnapshot({
    tabs: cloneTabs(tabs),
    activeTabId,
    activeUrl: tabs.find((tab) => tab.id === activeTabId)?.url ?? null,
  });
  browserPaneStateStore.set(normalizedKey, snapshot);
  hydratedBrowserPaneScopes.add(normalizedKey);
  writeStoredScope(normalizedKey, snapshot);
  for (const listener of browserPaneListeners) listener();
}

export function subscribeBrowserPaneTabs(listener: () => void): () => void {
  browserPaneListeners.add(listener);
  return () => { browserPaneListeners.delete(listener); };
}

export function getBrowserPaneTabs(scopeKey?: string): readonly BrowserTab[] {
  const normalizedKey = normalizeBrowserPaneScopeKey(scopeKey);
  if (!hydratedBrowserPaneScopes.has(normalizedKey)) {
    const stored = readStoredDocument()?.scopes.find((scope) => scope.scopeKey === normalizedKey);
    if (stored) browserPaneStateStore.set(normalizedKey, normalizedSnapshot(stored));
    hydratedBrowserPaneScopes.add(normalizedKey);
  }
  return browserPaneStateStore.get(normalizedKey)?.tabs ?? NO_BROWSER_TABS;
}

export function activeUrlFromBrowserPaneSnapshot(snapshot: BrowserPaneStateSnapshot | null): string {
  if (!snapshot) return '';
  return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.url ?? snapshot.activeUrl ?? '';
}

export function reorderBrowserTabs(
  tabs: readonly BrowserTab[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): BrowserTab[] {
  if (draggedId === targetId) return cloneTabs(tabs);
  const dragged = tabs.find((tab) => tab.id === draggedId);
  if (!dragged || !tabs.some((tab) => tab.id === targetId)) return cloneTabs(tabs);
  const next = tabs.filter((tab) => tab.id !== draggedId).map((tab) => ({ ...tab }));
  const targetIndex = next.findIndex((tab) => tab.id === targetId);
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, { ...dragged });
  return next;
}
