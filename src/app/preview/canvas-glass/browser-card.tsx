'use client';

/**
 * Browser cards — the browser pane on the canvas (#1232). Local development
 * pages ride the same-origin live proxy so Design Mode and agent verbs can
 * inspect them. Only the visible tab is mounted; inactive tabs keep their URL
 * and title without keeping a background web app alive indefinitely.
 *
 * Element picker: the crosshair arms an inspector for SAME-ORIGIN pages
 * (your localhost apps) — hover highlights the element + live selector,
 * click copies the selector. Cross-origin iframes can't be instrumented;
 * the readout says so instead of failing silently.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { installBrowserAgent } from '@/lib/browser-agent/page-agent';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  browserFrameSrc,
  browserTitleFromUrl,
  isLoopbackBrowserUrl,
  normalizeBrowserUrl,
} from '@/lib/browser/url';
import { O8EnginePane } from '@/components/desktop/O8EnginePane';
import { CHROME, FONT, TERM_MIN_H, TERM_MIN_W } from './ui';
import { GlassCardShell } from './card-shell';
import { IconButton } from './icon-button';

export interface BrowserTab {
  id: number;
  url: string;
  title?: string;
}

export interface BrowserCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  tabs: BrowserTab[];
  activeTabId: number;
}

function tabLabel(tab: BrowserTab | undefined): string {
  if (!tab) return 'Browser';
  if (engineScope(tab.url)) return tab.title || 'Agent Chrome';
  return tab.title?.trim() || browserTitleFromUrl(tab.url);
}

/** `o8-engine://<scope>` tabs are live views of the headless engine Chrome
 *  (#1232 phase 3) — the agent drives, the operator watches. */
const ENGINE_PREFIX = 'o8-engine://';

function engineScope(url: string): string | null {
  return url.startsWith(ENGINE_PREFIX) ? url.slice(ENGINE_PREFIX.length) || 'operator' : null;
}

const ENGINE_POLL_MS = 1800;

function EngineLiveView({ scope, active }: { scope: string; active: boolean }) {
  const [tick, setTick] = useState(0);
  const [meta, setMeta] = useState<{ active: boolean; url?: string; title?: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), ENGINE_POLL_MS);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!active || tick % 3 !== 0) return undefined;
    const controller = new AbortController();
    fetch(`/api/browser/engine/view?scope=${encodeURIComponent(scope)}&meta=1`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data: { active: boolean; url?: string; title?: string }) => setMeta(data))
      .catch(() => undefined);
    return () => controller.abort();
  }, [active, scope, tick]);
  const live = meta?.active !== false;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff' }}>
      {!active ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: CHROME.bodySize, fontWeight: 300, color: 'rgba(0,0,0,0.4)' }}>
          Browser paused offscreen
        </div>
      ) : live ? (
        // eslint-disable-next-line @next/next/no-img-element -- no-store engine frames cannot use the image optimizer.
        <img
          src={`/api/browser/engine/view?scope=${encodeURIComponent(scope)}&t=${tick}`}
          alt="Agent Chrome live view"
          draggable={false}
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'top center' }}
        />
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: CHROME.bodySize, fontWeight: 300, color: 'rgba(0,0,0,0.45)', textAlign: 'center', paddingLeft: 24, paddingRight: 24 }}>
          Engine idle — agents land here when they open an external URL.
        </div>
      )}
      {live && meta?.url ? (
        <div style={{ position: 'absolute', left: 8, bottom: 8, maxWidth: 'calc(100% - 16px)', paddingTop: 3, paddingBottom: 3, paddingLeft: 8, paddingRight: 8, borderRadius: 7, background: 'rgba(17,17,17,0.78)', color: 'rgba(255,255,255,0.92)', fontSize: CHROME.captionSize, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Agent Chrome · {meta.url}
        </div>
      ) : null}
    </div>
  );
}

function BrowserGlassCardComponent({
  card,
  onMove,
  onResize,
  onFocus,
  onTabsChange,
  onClose,
}: {
  card: BrowserCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onTabsChange: (id: number, tabs: BrowserTab[], activeTabId: number) => void;
  onClose: (id: number) => void;
}) {
  const activeTab = card.tabs.find((tab) => tab.id === card.activeTabId) ?? card.tabs[0];
  const activeUrl = activeTab?.url ?? '';
  const activeEngineScope = engineScope(activeUrl);
  const activeUrlUsesEngine = /^https?:\/\//i.test(activeUrl) && !isLoopbackBrowserUrl(activeUrl);
  const [urlDraft, setUrlDraft] = useState(activeUrl);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [inViewport, setInViewport] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  ));
  const [designActive, setDesignActive] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  /** Agent-driving glow — pulses when an agent verb lands on this surface. */
  const [agentGlow, setAgentGlow] = useState(false);
  const shouldRenderPage = inViewport;

  // Switching tabs (or a navigate landing) re-seeds the URL bar.
  useEffect(() => { setUrlDraft(activeUrl); }, [activeUrl]);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      setInViewport(Boolean(entry?.isIntersecting));
    }, { threshold: 0 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMode = (event: Event) => {
      setDesignActive(Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active));
    };
    window.addEventListener('o8:design-mode', onMode);
    return () => window.removeEventListener('o8:design-mode', onMode);
  }, []);

  // The agent verbs (o8_browser_* / `o8 browser`) drive these iframes.
  useEffect(() => {
    installBrowserAgent();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onPulse = (event: Event) => {
      const surface = (event as CustomEvent<{ surface?: string | null }>).detail?.surface;
      if (surface && surface !== 'canvas') return;
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

  const navigate = useCallback((url: string) => {
    const normalized = normalizeBrowserUrl(url);
    if (!normalized) return;
    if (normalized === activeUrl) setReloadKey((value) => value + 1);
    onTabsChange(
      card.id,
      card.tabs.map((tab) => (
        tab.id === card.activeTabId
          ? { ...tab, url: normalized, title: browserTitleFromUrl(normalized) }
          : tab
      )),
      card.activeTabId,
    );
    setUrlDraft(normalized);
  }, [activeUrl, card.activeTabId, card.id, card.tabs, onTabsChange]);
  const addTab = () => {
    const nextId = card.tabs.reduce((max, tab) => Math.max(max, tab.id), 0) + 1;
    onTabsChange(card.id, [...card.tabs, { id: nextId, url: '', title: 'New Tab' }], nextId);
    window.setTimeout(() => urlInputRef.current?.focus(), 0);
  };
  const closeTab = (tabId: number) => {
    const remaining = card.tabs.filter((tab) => tab.id !== tabId);
    if (remaining.length === 0) {
      onClose(card.id);
      return;
    }
    onTabsChange(card.id, remaining, tabId === card.activeTabId ? remaining[remaining.length - 1].id : card.activeTabId);
  };

  const goHistory = (direction: 'back' | 'forward') => {
    try {
      const history = iframeRef.current?.contentWindow?.history;
      if (direction === 'back') history?.back();
      else history?.forward();
    } catch {
      // Cross-origin frames do not expose history to the host.
    }
  };

  const handleReload = () => setReloadKey((value) => value + 1);

  const handleIframeLoad = () => {
    const frame = iframeRef.current;
    if (!frame || !activeTab) return;
    try {
      const title = frame.contentDocument?.title?.trim();
      if (!title || title === activeTab.title) return;
      onTabsChange(
        card.id,
        card.tabs.map((tab) => (tab.id === activeTab.id ? { ...tab, title } : tab)),
        card.activeTabId,
      );
    } catch {
      // Cross-origin pages retain their hostname title.
    }
  };

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={TERM_MIN_W}
      minH={TERM_MIN_H}
      title={tabLabel(activeTab)}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
    >
        {/* Browser toolbelt — parity with the default-side browser while
            keeping the whole row inside the card body (the shell header drags). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, paddingTop: 2, paddingBottom: 6, paddingLeft: 12, paddingRight: 12 }}>
          <IconButton label="Back" onClick={() => goHistory('back')} size={24}>
            <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
          </IconButton>
          <IconButton label="Forward" onClick={() => goHistory('forward')} size={24}>
            <path d="m12 5 7 7-7 7" /><path d="M5 12h14" />
          </IconButton>
          <IconButton label="Reload" onClick={handleReload} size={24}>
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </IconButton>
          <input
            ref={urlInputRef}
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              navigate(urlDraft);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="Browser address"
            placeholder="Enter URL or search"
            spellCheck={false}
            style={{
              flex: 1,
              borderWidth: 0,
              outline: 'none',
              background: 'var(--cnv-tint)',
              borderRadius: 8,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 8,
              paddingRight: 8,
              color: 'var(--cnv-ink)',
              fontSize: CHROME.fieldSize,
              fontWeight: CHROME.metaWeight,
              letterSpacing: '-0.05px',
              fontFamily: FONT,
            }}
          />
          <IconButton
            label={designActive ? 'Exit Design Mode' : 'Design Mode'}
            title={designActive ? 'Exit Design Mode' : 'Design Mode — grab an element'}
            active={designActive}
            onClick={() => window.dispatchEvent(new CustomEvent('o8:design-mode-request', { detail: { action: 'toggle' } }))}
            size={24}
          >
            <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
            <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
          </IconButton>
          <IconButton
            label="Copy current URL"
            onClick={() => {
              if (!activeUrl) return;
              void navigator.clipboard?.writeText(activeUrl).then(() => {
                setUrlCopied(true);
                window.setTimeout(() => setUrlCopied(false), 1200);
              });
            }}
            size={24}
          >
            {urlCopied ? <path d="M20 6 9 17l-5-5" /> : <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>}
          </IconButton>
          <IconButton label="Open in system browser" onClick={() => { if (activeUrl) openExternalUrl(activeUrl); }} size={24}>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
          </IconButton>
        </div>

        {/* Tab strip — pills, like the default-side browser. Always present so
            the + is one click away; slim enough to cost nothing. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 2, paddingBottom: 4, paddingLeft: 12, paddingRight: 12, overflowX: 'auto', scrollbarWidth: 'none', flexShrink: 0 } as React.CSSProperties}>
          {card.tabs.map((tab) => {
            const active = tab.id === card.activeTabId;
            return (
              <div
                key={tab.id}
                role="button"
                tabIndex={0}
                aria-label={`Tab — ${tabLabel(tab)}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => { if (!active) onTabsChange(card.id, card.tabs, tab.id); }}
                onKeyDown={(event) => { if (event.key === 'Enter' && !active) onTabsChange(card.id, card.tabs, tab.id); }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  paddingTop: 2,
                  paddingBottom: 2,
                  paddingLeft: 8,
                  paddingRight: card.tabs.length > 1 ? 5 : 8,
                  borderRadius: 7,
                  background: active ? 'var(--cnv-tint)' : 'transparent',
                  color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                  fontSize: CHROME.fieldSize,
                  fontWeight: CHROME.metaWeight,
                  fontFamily: FONT,
                  letterSpacing: '-0.05px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  maxWidth: 168,
                  flexShrink: 0,
                  userSelect: 'none',
                }}
                onMouseEnter={(event) => { if (!active) event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                onMouseLeave={(event) => { if (!active) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 132 }}>{tabLabel(tab)}</span>
                {card.tabs.length > 1 ? (
                  <span
                    role="button"
                    aria-label="Close tab"
                    onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
                    style={{ fontSize: CHROME.metaSize, lineHeight: 1, paddingLeft: 2, paddingRight: 2, opacity: 0.7, cursor: 'pointer' }}
                    onMouseEnter={(event) => { event.currentTarget.style.opacity = '1'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.opacity = '0.7'; }}
                  >
                    ✕
                  </span>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            aria-label="New tab"
            title="New tab"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={addTab}
            style={{ borderWidth: 0, background: 'transparent', color: 'var(--cnv-ink-muted)', fontSize: CHROME.iconSize, lineHeight: 1, paddingTop: 1, paddingBottom: 1, paddingLeft: 6, paddingRight: 6, cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            +
          </button>
        </div>

        {/* One live page per card. Switching tabs releases the previous iframe,
            and panning the card offscreen releases the active page as well. */}
        <div ref={viewportRef} style={{ height: card.h, position: 'relative', background: '#fff', boxShadow: agentGlow ? 'inset 0 0 0 1.5px rgba(245,158,11,0.75)' : 'none' }}>
          {!activeTab?.url ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(0,0,0,0.42)', fontSize: CHROME.bodySize, fontWeight: 300 }}>
              Enter an address above
            </div>
          ) : !shouldRenderPage ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(0,0,0,0.42)', fontSize: CHROME.bodySize, fontWeight: 300 }}>
              Browser paused offscreen
            </div>
          ) : activeEngineScope ? (
            <EngineLiveView scope={activeEngineScope} active={pageVisible} />
          ) : activeUrlUsesEngine ? (
            <O8EnginePane
              url={activeTab.url}
              scope={`canvas-${card.id}-${activeTab.id}`}
              agentGlow={agentGlow}
              closeOnUnmount
            />
          ) : (
            <iframe
              key={`${activeTab.id}:${activeTab.url}:${reloadKey}`}
              ref={iframeRef}
              src={browserFrameSrc(activeTab.url)}
              title={`Browser — ${tabLabel(activeTab)}`}
              onLoad={handleIframeLoad}
              data-o8-browser="canvas"
              data-o8-active="true"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', borderWidth: 0 }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            />
          )}
        </div>
    </GlassCardShell>
  );
}

export const BrowserGlassCard = memo(BrowserGlassCardComponent);
BrowserGlassCard.displayName = 'BrowserGlassCard';
