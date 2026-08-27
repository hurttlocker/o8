'use client';

/**
 * O8BrowserPane — Chrome-like browser tab experience inside the O8 panel.
 *
 * Tab bar + URL bar + iframe content. Localhost previews seed as initial tabs.
 * New Tab page shows detected ports as clickable tiles.
 *
 * Local pages load through the same-origin live proxy (`/api/browser/proxy`)
 * so the page stays fully interactive for the human AND inspectable by both the
 * in-page agent (o8_browser_*) and the unified Design Mode grab (Cmd+Shift+D).
 * There is no longer a script-stripping picker mode — grabbing an element is a
 * Design Mode click on the live page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openExternalUrl } from '@/lib/desktop/open-external';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import { installBrowserAgent } from '@/lib/browser-agent/page-agent';
import {
  browserFrameSrc,
  browserTitleFromUrl,
  isLoopbackBrowserUrl,
  normalizeBrowserUrl,
} from '@/lib/browser/url';
import { isTauri, browserViewEval, browserViewNavigate } from '@/lib/tauri/bridge';
import { useNativeBrowserViewFlag } from '@/lib/operator/use-native-browser-view';
import {
  activeUrlFromBrowserPaneSnapshot,
  normalizeBrowserPaneScopeKey,
  readBrowserPaneState,
  reorderBrowserTabs,
  writeBrowserPaneState,
  type BrowserTab,
} from '@/lib/browser/pane-state';
import { O8EnginePane } from './O8EnginePane';
import { NativeBrowserSurface } from './NativeBrowserSurface';
import { BrowserNewTabState, BrowserRedactedState, BrowserTabFavicon } from './O8BrowserPaneStates';

// ── Types ──

export type { BrowserTab } from '@/lib/browser/pane-state';

interface O8BrowserPaneProps {
  previews?: DetectedLocalhostPreview[];
  navigateToUrl?: string | null;
  stateScopeKey?: string;
  // Bubbles the currently-loaded URL up to the dashboard so the TitleBar
  // Browser button can render a hover-preview iframe pointed at it.
  onActiveUrlChange?: (url: string | null) => void;
  /** Cursor 2-bar parity (Q 2026-07-12): when the host provides a strip slot,
   *  the page tabs PORTAL into it (pages become first-class tabs next to
   *  Files/Terminal) and the pane's own tab-bar row doesn't render — one
   *  strip + one toolbar. Hosts without a slot (ContextualPanel, the main
   *  browser tab) keep the internal tab bar unchanged. */
  tabStripSlot?: HTMLElement | null;
  /** Called when the operator interacts with a portaled page tab while
   *  another utility surface is active — the host focuses the browser. */
  onFocusRequest?: () => void;
}

// ── Helpers ──

let tabCounter = 0;
function newTabId(): string {
  tabCounter += 1;
  return `btab-${tabCounter}-${Date.now()}`;
}

// ── Component ──

export function O8BrowserPane({ previews = [], navigateToUrl, stateScopeKey, onActiveUrlChange, tabStripSlot, onFocusRequest }: O8BrowserPaneProps) {
  const normalizedStateScopeKey = normalizeBrowserPaneScopeKey(stateScopeKey);
  const [initialBrowserState] = useState(() => readBrowserPaneState(normalizedStateScopeKey));
  const [tabs, setTabs] = useState<BrowserTab[]>(() => initialBrowserState?.tabs ?? []);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => initialBrowserState?.activeTabId ?? null);
  const [urlInput, setUrlInput] = useState(() => activeUrlFromBrowserPaneSnapshot(initialBrowserState));
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const draggedTabId = useRef<string | null>(null);
  /** Stable handle for the header-rail "New page" event listener — the
   *  listener mounts before addNewTab is declared below. */
  const addNewTabRef = useRef<(() => void) | null>(null);
  const seeded = useRef(initialBrowserState !== null);
  const hasStoredState = useRef(initialBrowserState !== null);
  /** Agent-driving glow — pulses when an agent verb lands on this surface. */
  const [agentGlow, setAgentGlow] = useState(false);
  /** URLs that blank out when proxied (auth-gated SPAs) — drive them in the
   *  engine's real Chrome instead, where they render + stay grabbable. */
  const [engineUrls, setEngineUrls] = useState<Set<string>>(() => new Set(
    initialBrowserState?.tabs
      .filter((tab) => tab.surface === 'engine' && tab.url)
      .map((tab) => tab.url) ?? [],
  ));
  /** Native browser-view path (docs/internals/native-browser-webview-spec.md). Operator
   *  setting `nativeBrowserView` (default ON, Settings → Operator Defaults);
   *  only in Tauri — the native child window can't exist in the web/dev preview,
   *  where the iframe is the default. When on, the native surface renders ANY url
   *  (incl. origin-locked Clerk), so the proxy/iframe + engine-blank fallback are
   *  bypassed for tabs with a url. */
  const [inTauri] = useState<boolean>(() => isTauri());
  const nativeEnabled = useNativeBrowserViewFlag() && inTauri;
  /** Browser toolbelt (Q 2026-07-12): the Design toggle in the
   *  URL row arms the app-wide Design Mode grab; active state mirrors the
   *  hook's broadcast so the keyboard toggle stays in sync. */
  const [designActive, setDesignActive] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  useEffect(() => {
    const onMode = (event: Event) => {
      setDesignActive(Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active));
    };
    window.addEventListener('o8:design-mode', onMode);
    return () => window.removeEventListener('o8:design-mode', onMode);
  }, []);

  // Agent verbs (o8_browser_* / `o8 browser`) drive this pane's iframe too.
  useEffect(() => { installBrowserAgent(); }, []);

  // Header-rail [+] → "New page" (the universal opener in PanelHeaderStrip
  // dispatches this; the pane owns tab state, so it does the actual add).
  useEffect(() => {
    const onNewPage = () => addNewTabRef.current?.();
    window.addEventListener('o8:browser-new-page', onNewPage);
    return () => window.removeEventListener('o8:browser-new-page', onNewPage);
  }, []);

  // The agent-driving indicator — mirror the canvas card: pulse a glow when an
  // o8_browser_* verb lands on the panel surface (the ghost cursor moves inside
  // the page; this glow frames the surface so the operator sees who's driving).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onPulse = (event: Event) => {
      const surface = (event as CustomEvent<{ surface?: string | null }>).detail?.surface;
      if (surface && surface !== 'panel') return;
      setAgentGlow(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setAgentGlow(false), 1300);
    };
    window.addEventListener('o8:browser-agent-pulse', onPulse);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('o8:browser-agent-pulse', onPulse);
    };
  }, []);

  // Seed tabs from previews on first render
  useEffect(() => {
    if (seeded.current || previews.length === 0) return;
    seeded.current = true;
    const initial: BrowserTab[] = previews.map(p => ({
      id: newTabId(),
      url: p.url || `http://localhost:${p.port}`,
      title: `localhost:${p.port}`,
    }));
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      hasStoredState.current = true;
      setTabs(initial);
      setActiveTabId(initial[0].id);
      setUrlInput(initial[0].url);
    });
    return () => { cancelled = true; };
  }, [previews]);

  useEffect(() => {
    if (!hasStoredState.current && tabs.length === 0 && activeTabId === null) return;
    hasStoredState.current = true;
    writeBrowserPaneState(normalizedStateScopeKey, tabs.map((tab) => ({
      ...tab,
      surface: nativeEnabled && tab.url
        ? 'native'
        : engineUrls.has(tab.url)
          ? 'engine'
          : 'embedded',
    })), activeTabId);
  }, [activeTabId, engineUrls, nativeEnabled, normalizedStateScopeKey, tabs]);

  // Navigate to externally-provided URL (e.g. from port popover)
  const lastNavigatedUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!navigateToUrl || navigateToUrl === lastNavigatedUrl.current) return;
    lastNavigatedUrl.current = navigateToUrl;
    const normalized = normalizeBrowserUrl(navigateToUrl);
    if (!normalized) return;
    // Check if a tab with this URL already exists
    const existing = tabs.find(t => t.url === normalized);
    if (existing) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setActiveTabId(existing.id);
        setUrlInput(normalized);
      });
      return () => { cancelled = true; };
    }
    // Create a new tab for this URL
    const id = newTabId();
    const newTab: BrowserTab = { id, url: normalized, title: browserTitleFromUrl(normalized) };
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(id);
      setUrlInput(normalized);
    });
    return () => { cancelled = true; };
  }, [navigateToUrl, tabs]);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;

  // Sync URL input when switching tabs
  useEffect(() => {
    const frame = requestAnimationFrame(() => setUrlInput(activeTab?.url ?? ''));
    return () => cancelAnimationFrame(frame);
  }, [activeTabId, activeTab?.url]);

  // Bubble active URL up so the TitleBar can hover-preview it. Empty string
  // → null so the popover knows to render the empty state.
  useEffect(() => {
    if (!onActiveUrlChange) return;
    onActiveUrlChange(activeTab?.url ? activeTab.url : null);
  }, [activeTab?.url, onActiveUrlChange]);

  const navigateTo = useCallback((url: string) => {
    if (!activeTabId) return;
    const normalized = normalizeBrowserUrl(url);
    if (!normalized) return;
    setTabs(prev => prev.map(t =>
      t.id === activeTabId
        ? { ...t, url: normalized, title: browserTitleFromUrl(normalized), redacted: false }
        : t
    ));
    setUrlInput(normalized);
  }, [activeTabId]);

  const addNewTab = useCallback(() => {
    const id = newTabId();
    setTabs(prev => [...prev, { id, url: '', title: 'New Tab' }]);
    setActiveTabId(id);
    setUrlInput('');
    setTimeout(() => urlRef.current?.focus(), 50);
  }, []);
  useEffect(() => { addNewTabRef.current = addNewTab; }, [addNewTab]);

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (next.length === 0) {
        setActiveTabId(null);
        return next;
      }
      if (activeTabId === id) {
        const idx = prev.findIndex(t => t.id === id);
        const newActive = next[Math.min(idx, next.length - 1)];
        setActiveTabId(newActive.id);
      }
      return next;
    });
  }, [activeTabId]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateTo(urlInput);
      urlRef.current?.blur();
    }
  }, [urlInput, navigateTo]);

  const handleReload = useCallback(() => {
    if (!activeTab?.url) return;
    // Native path: re-navigating to the same URL reloads the page in the child
    // window — no iframe-key toggle (which would unmount + flash the surface).
    if (nativeEnabled) {
      void browserViewNavigate(activeTab.url);
      return;
    }
    // Force iframe reload by toggling URL
    const url = activeTab.url;
    setTabs(prev => prev.map(t =>
      t.id === activeTabId ? { ...t, url: '' } : t
    ));
    requestAnimationFrame(() => {
      setTabs(prev => prev.map(t =>
        t.id === activeTabId ? { ...t, url } : t
      ));
    });
  }, [activeTab, activeTabId, nativeEnabled]);

  const openExternal = useCallback(() => {
    if (activeTab?.url) openExternalUrl(activeTab.url);
  }, [activeTab]);

  // Back / forward (Q 2026-07-12: "we need the back and forward buttons on
  // the left"). Native path: eval history into the child window. Iframe
  // path: same-origin (proxied localhost) frames honor contentWindow
  // history; cross-origin throws → quiet no-op.
  const goHistory = useCallback((direction: 'back' | 'forward') => {
    if (nativeEnabled && activeTab?.url) {
      void browserViewEval(direction === 'back' ? 'history.back()' : 'history.forward()');
      return;
    }
    try {
      const win = iframeRef.current?.contentWindow;
      if (direction === 'back') win?.history.back();
      else win?.history.forward();
    } catch {
      // cross-origin — nothing we can do from here
    }
  }, [activeTab?.url, nativeEnabled]);

  const iframeSrc = activeTab?.url ? browserFrameSrc(activeTab.url) : '';

  // Origin-sensitive SPAs (Clerk/OAuth) render BLANK when proxied to our origin
  // — their frontend rejects the mismatched origin. Give the proxied page a
  // moment to hydrate; if it's same-origin but still empty, the proxy broke it,
  // so hand the url to the engine pane, which drives it in real Chrome (renders,
  // human-interactive, and agent-grabbable via surface:'engine').
  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    const url = activeTab?.url;
    const loadedTabId = activeTab?.id;
    // Real page title in the tab — readable whenever the
    // frame is same-origin (all proxied localhost pages). Cross-origin
    // throws → hostname stays.
    if (iframe && loadedTabId) {
      try {
        const liveTitle = iframe.contentDocument?.title?.trim();
        if (liveTitle) {
          setTabs((prev) => prev.map((t) => (t.id === loadedTabId && t.title !== liveTitle ? { ...t, title: liveTitle } : t)));
        }
      } catch {
        // cross-origin — keep the hostname title
      }
    }
    if (!iframe || !url || !isLoopbackBrowserUrl(url) || engineUrls.has(url)) return;
    window.setTimeout(() => {
      if (iframeRef.current !== iframe) return; // navigated away
      try {
        const doc = iframe.contentDocument;
        if (!doc) return; // already cross-origin — nothing to do
        // No visible text after the hydrate window → the proxy broke it
        // (origin-sensitive SPA, or an empty redirect body) → use the engine.
        const empty = (doc.body?.innerText || '').trim().length < 5;
        if (empty) {
          setEngineUrls((prev) => new Set(prev).add(url));
        }
      } catch {
        // cross-origin — can't inspect; leave it as-is
      }
    }, 1500);
  }, [activeTab?.url, activeTab?.id, engineUrls]);

  // Empty state — shared by both hosts (inline early-return look for slotless
  // hosts, content-area render for slot mode where the strip stays up).
  const emptyState = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      <span style={{ color: 'var(--t-text-faint)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>No active previews</span>
      <button
        type="button"
        onClick={addNewTab}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          paddingTop: 5, paddingRight: 12, paddingBottom: 5, paddingLeft: 12,
          borderRadius: 8, border: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-hover)', color: 'var(--t-text)',
          fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', cursor: 'pointer',
        }}
      >
        + New Tab
      </button>
    </div>
  );

  if (tabs.length === 0 && !tabStripSlot) {
    return emptyState;
  }

  // New Tab page — show port tiles when tab has no URL
  const showNewTabPage = activeTab && !activeTab.url && !activeTab.redacted;

  // Adaptive label density (Q ruling 2026-07-12: "don't want it to look
  // janky with a few things open"): full page title when there's room,
  // hostname when tabs multiply, favicon-only when it's tight. The ACTIVE
  // tab always keeps its label so you never lose your place.
  const labelMode: 'title' | 'host' | 'icon' = tabs.length <= 2 ? 'title' : tabs.length <= 4 ? 'host' : 'icon';

  // Page-tab pills — rendered either in the pane's own tab-bar row (slotless
  // hosts) or PORTALED into the host's header rail (Cursor parity: pages sit
  // next to the state drawer as first-class tabs).
  const tabPills = (
    <>
      {tabs.map(tab => {
          const isActive = tab.id === activeTabId;
          const isHovered = tab.id === hoveredTabId;
          const showLabel = labelMode !== 'icon' || isActive;
          const labelText = labelMode === 'title' ? tab.title : browserTitleFromUrl(tab.url);
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={(event) => {
                draggedTabId.current = tab.id;
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.id);
              }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
              onDrop={(event) => {
                event.preventDefault();
                const draggedId = draggedTabId.current;
                if (!draggedId) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                const position = event.clientX >= bounds.left + bounds.width / 2 ? 'after' : 'before';
                setTabs((current) => reorderBrowserTabs(current, draggedId, tab.id, position));
                draggedTabId.current = null;
              }}
              onDragEnd={() => { draggedTabId.current = null; }}
              onClick={() => { onFocusRequest?.(); setActiveTabId(tab.id); }}
              onMouseEnter={() => setHoveredTabId(tab.id)}
              onMouseLeave={() => setHoveredTabId(null)}
              title={tab.title}
              style={{
                display: 'flex', alignItems: 'center', gap: showLabel ? 6 : 0,
                height: 22, paddingLeft: showLabel ? 9 : 6, paddingRight: showLabel ? 5 : 6,
                borderRadius: 6, cursor: 'pointer',
                background: isActive ? 'var(--t-panel-active, var(--t-input-bg))' : isHovered ? 'var(--t-hover)' : 'transparent',
                maxWidth: labelMode === 'title' ? 180 : labelMode === 'host' ? 120 : isActive ? 140 : 30,
                minWidth: 0, flexShrink: 1,
                transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              {/* Icon-only + hovered: the favicon SWAPS to the close × in
                  place (Chrome behavior) so the pill never widens. */}
              {!showLabel && isHovered ? null : <BrowserTabFavicon url={tab.url} />}
              {showLabel ? (
              <span style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px',
                color: isActive ? 'var(--t-text)' : 'var(--t-text-muted)',
              }}>
                {labelText}
              </span>
              ) : null}
              {/* Close × — labelled pills: on active/hover with a spacer
                  otherwise; icon-only pills: only while hovered (it took the
                  favicon's spot, same footprint). */}
              {(showLabel && (isActive || isHovered)) || (!showLabel && isHovered) ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: showLabel ? 17 : 12, height: showLabel ? 17 : 12, border: 'none', borderRadius: 4,
                    background: 'transparent', cursor: 'pointer', flexShrink: 0, padding: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="3" strokeLinecap="round" style={{ display: 'block', width: 9, height: 9, minWidth: 9, minHeight: 9 }}>
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              ) : showLabel ? <div style={{ width: 17, flexShrink: 0 }} /> : null}
            </div>
          );
        })}
        {/* Add tab button — slotless hosts only. In header mode the strip's
            own [+] is the universal opener (new page + utility surfaces). */}
        {!tabStripSlot ? (
        <button
          type="button"
          onClick={() => { onFocusRequest?.(); addNewTab(); }}
          title="New tab"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, border: 'none', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', flexShrink: 0, padding: 0,
            marginLeft: 2,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block' }}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        ) : null}
    </>
  );

  // URL toolbar pieces — live in the pane's own row for slotless hosts, or
  // travel UP into the header portal next to the tabs (Q ruling 2026-07-12:
  // "move it up" — zero chrome rows inside the panel).
  const urlToolbar = (
    <>
        {/* Back / Forward — leftmost, Cursor order */}
        <button
          type="button"
          onClick={() => goHistory('back')}
          title="Back"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, border: 'none', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', padding: 0,
            opacity: activeTab?.url ? 1 : 0.3,
            transition: 'background 140ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <path d="m12 19-7-7 7-7" />
            <path d="M19 12H5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => goHistory('forward')}
          title="Forward"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, border: 'none', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', padding: 0,
            opacity: activeTab?.url ? 1 : 0.3,
            transition: 'background 140ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <path d="m12 5 7 7-7 7" />
            <path d="M5 12h14" />
          </svg>
        </button>
        {/* Reload */}
        <button
          type="button"
          onClick={handleReload}
          title="Reload"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, border: 'none', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', padding: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        {/* URL input — flat fill, no border: the well reads as one quiet
            surface at Cursor's weight instead of a chunky outlined field. */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center',
          height: 22, paddingLeft: 9, paddingRight: 9,
          borderRadius: 6, background: 'var(--t-input-bg)',
        }}>
          {/* Lock/globe icon */}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: 'block', marginRight: 6 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <input
            ref={urlRef}
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onFocus={(e) => e.target.select()}
            placeholder="Enter URL or search..."
            style={{
              flex: 1, border: 'none', background: 'transparent', outline: 'none',
              color: 'var(--t-text)', fontSize: 11.5,
              fontFamily: 'var(--font-sans-system)',
            }}
          />
        </div>
        {/* Design Mode toggle — arms the app-wide click-to-grab (Cmd+Shift+D
            twin). Active = brand-orange brush, Cursor's solid-state pattern
            in our accent. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('o8:design-mode-request', { detail: { action: 'toggle' } }))}
          title={designActive ? 'Exit Design Mode (Esc)' : 'Design Mode — click any element to grab it (⌘⇧D)'}
          aria-pressed={designActive}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, border: 'none', borderRadius: 6,
            background: designActive ? 'var(--t-input-bg)' : 'transparent',
            cursor: 'pointer', padding: 0,
            transition: 'background 140ms ease',
          }}
          onMouseEnter={(e) => { if (!designActive) e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = designActive ? 'var(--t-input-bg)' : 'transparent'; }}
        >
          {/* Paintbrush — stroke crossfades to brand-orange when the mode arms. */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={designActive ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-secondary)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', transition: 'stroke 140ms ease' }}>
            <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
            <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
          </svg>
        </button>
        {/* Copy current URL */}
        <button
          type="button"
          onClick={() => {
            if (!activeTab?.url) return;
            void navigator.clipboard?.writeText(activeTab.url).then(() => {
              setUrlCopied(true);
              window.setTimeout(() => setUrlCopied(false), 1200);
            });
          }}
          title="Copy current URL"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, border: 'none', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', padding: 0,
            opacity: activeTab?.url ? 1 : 0.3,
            transition: 'background 140ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {urlCopied ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--t-success, #16a34a)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          )}
        </button>
        {/* Open in external browser */}
        <button
          type="button"
          onClick={openExternal}
          title="Open in browser"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, border: 'none', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', padding: 0,
            opacity: activeTab?.url ? 1 : 0.3,
            transition: 'background 140ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {/* External link icon */}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {tabStripSlot ? (
        // Header rail carries TABS ONLY (Q correction 2026-07-12: the URL
        // stays below — manipulation space + room for tabs, same reason
        // Cursor keeps its toolbar row). The [+] up top opens a new page.
        createPortal(
          <div style={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, overflow: 'hidden' }}>
            {tabPills}
          </div>,
          tabStripSlot,
        )
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', height: 30,
          paddingLeft: 5, paddingRight: 5, gap: 1,
          borderBottom: '1px solid var(--t-divider)',
          background: 'transparent', flexShrink: 0,
          overflow: 'hidden',
        }}>
          {tabPills}
        </div>
      )}

      {tabs.length === 0 ? emptyState : (
      <>
      {/* ── URL toolbar — always the pane's own row (Cursor keeps it below
            the tabs too; this is where the operator manipulates the page). ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 3,
        height: 30, paddingLeft: 5, paddingRight: 5,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
      }}>
        {urlToolbar}
      </div>

      {/* ── Content area — the Design Mode draw surface (the ink is confined
            here, Q ruling 2026-07-12: "just in the browser"). ── */}
      <div data-o8-draw-surface style={{ flex: 1, minHeight: 0, position: 'relative', boxShadow: agentGlow ? 'inset 0 0 0 1.5px rgba(245,158,11,0.75)' : 'none', transition: 'box-shadow 200ms ease-out' }}>
        {activeTab?.redacted ? (
          <BrowserRedactedState />
        ) : showNewTabPage ? (
          <BrowserNewTabState previews={previews} onNavigate={navigateTo} />
        ) : nativeEnabled && activeTab?.url ? (
          // Native host-owned child window over this rect — renders origin-
          // sensitive auth apps (Clerk) smoothly AND stays agent-grabbable.
          // Bypasses the proxy/iframe + engine-blank fallback entirely.
          <NativeBrowserSurface url={activeTab.url} agentGlow={agentGlow} />
        ) : activeTab?.url && engineUrls.has(activeTab.url) ? (
          <O8EnginePane url={activeTab.url} agentGlow={agentGlow} />
        ) : activeTab?.url ? (
          <>
            <iframe
              ref={iframeRef}
              key={activeTab.id + '-' + activeTab.url}
              src={iframeSrc}
              title={activeTab.title}
              onLoad={handleIframeLoad}
              data-o8-browser="panel"
              data-o8-active="true"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
              style={{
                width: '100%', height: '100%',
                border: 'none', background: '#ffffff',
              }}
            />
            {/* Hint for non-localhost URLs that may block iframe embedding */}
            {activeTab.url && !activeTab.url.includes('localhost') && !activeTab.url.includes('127.0.0.1') ? (
              <div style={{
                position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
                display: 'flex', alignItems: 'center', gap: 8,
                paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12,
                borderRadius: 8, background: 'rgba(0,0,0,0.75)',
                backdropFilter: 'blur(8px)', fontSize: 11, color: 'rgba(255,255,255,0.7)',
                whiteSpace: 'nowrap',
              }}>
                Site not loading?
                <button
                  type="button"
                  onClick={openExternal}
                  style={{
                    border: 'none', background: 'rgba(255,255,255,0.15)',
                    color: '#60a5fa', fontSize: 11, fontWeight: 600,
                    paddingTop: 2, paddingRight: 8, paddingBottom: 2, paddingLeft: 8,
                    borderRadius: 4, cursor: 'pointer',
                  }}
                >
                  Open in browser
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      </>
      )}
    </div>
  );
}
