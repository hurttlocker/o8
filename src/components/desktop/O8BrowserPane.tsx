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
import { openExternalUrl } from '@/lib/desktop/open-external';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import { installBrowserAgent } from '@/lib/browser-agent/page-agent';

// ── live proxy ──
// Loading a localhost dev server directly makes the iframe cross-origin with
// our dashboard (different port), which blocks both agent driving and the
// Design Mode grab. Routing local URLs through our own origin
// (`/api/browser/proxy?url=...`) makes the page same-origin and inspectable
// WITHOUT stripping scripts, so the SPA still boots and stays interactive.
// External URLs load directly (best-effort; grabbing them routes to the engine).
const PROXY_PATH = '/api/browser/proxy?url=';

function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    return (
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host === '::1'
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return false;
  }
}

function liveSrc(url: string): string {
  return isLoopbackUrl(url)
    ? `${PROXY_PATH}${encodeURIComponent(url.replace('0.0.0.0', 'localhost'))}`
    : url;
}

// ── Types ──

interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

interface O8BrowserPaneProps {
  previews?: DetectedLocalhostPreview[];
  navigateToUrl?: string | null;
  // Bubbles the currently-loaded URL up to the dashboard so the TitleBar
  // Browser button can render a hover-preview iframe pointed at it.
  onActiveUrlChange?: (url: string | null) => void;
}

// ── Helpers ──

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('localhost') || trimmed.match(/^\d+\.\d+\.\d+\.\d+/)) return 'http://' + trimmed;
  return 'https://' + trimmed;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      return `localhost:${u.port || '80'}`;
    }
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url || 'New Tab';
  }
}

let tabCounter = 0;
function newTabId(): string {
  tabCounter += 1;
  return `btab-${tabCounter}-${Date.now()}`;
}

// ── Component ──

export function O8BrowserPane({ previews = [], navigateToUrl, onActiveUrlChange }: O8BrowserPaneProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const seeded = useRef(false);

  // Agent verbs (o8_browser_* / `o8 browser`) drive this pane's iframe too.
  useEffect(() => { installBrowserAgent(); }, []);

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
      setTabs(initial);
      setActiveTabId(initial[0].id);
      setUrlInput(initial[0].url);
    });
    return () => { cancelled = true; };
  }, [previews]);

  // Navigate to externally-provided URL (e.g. from port popover)
  const lastNavigatedUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!navigateToUrl || navigateToUrl === lastNavigatedUrl.current) return;
    lastNavigatedUrl.current = navigateToUrl;
    const normalized = normalizeUrl(navigateToUrl);
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
    const newTab: BrowserTab = { id, url: normalized, title: titleFromUrl(normalized) };
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
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    setTabs(prev => prev.map(t =>
      t.id === activeTabId ? { ...t, url: normalized, title: titleFromUrl(normalized) } : t
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
  }, [activeTab, activeTabId]);

  const openExternal = useCallback(() => {
    if (activeTab?.url) openExternalUrl(activeTab.url);
  }, [activeTab]);

  const iframeSrc = activeTab?.url ? liveSrc(activeTab.url) : '';

  // If no tabs, show empty state with option to add
  if (tabs.length === 0) {
    return (
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
  }

  // New Tab page — show port tiles when tab has no URL
  const showNewTabPage = activeTab && !activeTab.url;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ── Tab bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', height: 34,
        paddingLeft: 6, paddingRight: 6, gap: 1,
        borderBottom: '1px solid var(--t-divider)',
        background: 'transparent', flexShrink: 0,
        overflow: 'hidden',
      }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId;
          const isHovered = tab.id === hoveredTabId;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              onMouseEnter={() => setHoveredTabId(tab.id)}
              onMouseLeave={() => setHoveredTabId(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                height: 26, paddingLeft: 10, paddingRight: 6,
                borderRadius: 6, cursor: 'pointer',
                background: isActive ? 'var(--t-panel-active, var(--t-input-bg))' : isHovered ? 'var(--t-hover)' : 'transparent',
                maxWidth: 180, minWidth: 0, flexShrink: 1,
                transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              {/* Globe favicon */}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: 'block', width: 12, height: 12, minWidth: 12 }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px',
                color: isActive ? 'var(--t-text)' : 'var(--t-text-muted)',
              }}>
                {tab.title}
              </span>
              {/* Close button */}
              {(isActive || isHovered) ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 20, height: 20, border: 'none', borderRadius: 4,
                    background: 'transparent', cursor: 'pointer', flexShrink: 0, padding: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="3" strokeLinecap="round" style={{ display: 'block', width: 10, height: 10, minWidth: 10, minHeight: 10 }}>
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              ) : <div style={{ width: 20, flexShrink: 0 }} />}
            </div>
          );
        })}
        {/* Add tab button */}
        <button
          type="button"
          onClick={addNewTab}
          title="New tab"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, border: 'none', borderRadius: 6,
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
      </div>

      {/* ── URL bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        height: 36, paddingLeft: 6, paddingRight: 6,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
      }}>
        {/* Reload */}
        <button
          type="button"
          onClick={handleReload}
          title="Reload"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, border: 'none', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', padding: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        {/* URL input */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center',
          height: 26, paddingLeft: 10, paddingRight: 10,
          borderRadius: 8, background: 'var(--t-input-bg)',
          border: '1px solid var(--t-divider)',
        }}>
          {/* Lock/globe icon */}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: 'block', marginRight: 6 }}>
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
              color: 'var(--t-text)', fontSize: 12,
              fontFamily: 'var(--font-sans-system)',
            }}
          />
        </div>
        {/* Open in external browser */}
        <button
          type="button"
          onClick={openExternal}
          title="Open in browser"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, border: 'none', borderRadius: 6,
            background: 'transparent', cursor: 'pointer', padding: 0,
            opacity: activeTab?.url ? 1 : 0.3,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {/* External link icon */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      </div>

      {/* ── Content area ── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {showNewTabPage ? (
          <div style={{
            height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32,
          }}>
            <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, fontWeight: 500 }}>
              Enter a URL above, or open a running port:
            </span>
            {previews.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                {previews.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      const url = p.url || `http://localhost:${p.port}`;
                      navigateTo(url);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      paddingTop: 10, paddingRight: 16, paddingBottom: 10, paddingLeft: 14,
                      borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)',
                      background: 'rgba(255,255,255,0.04)', cursor: 'pointer',
                      transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                    }}
                  >
                    <div style={{
                      width: 28, height: 28, borderRadius: 8,
                      background: 'rgba(37,99,235,0.15)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
                      <span style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: 600 }}>
                        :{p.port}
                      </span>
                      <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>
                        localhost
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 12 }}>
                No ports detected
              </span>
            )}
          </div>
        ) : activeTab?.url ? (
          <>
            <iframe
              ref={iframeRef}
              key={activeTab.id + '-' + activeTab.url}
              src={iframeSrc}
              title={activeTab.title}
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
    </div>
  );
}
