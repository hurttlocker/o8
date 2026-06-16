'use client';

/**
 * Browser cards — a REAL browser pane on the canvas (#1232). URL bar +
 * iframe in the shared GlassCardShell every canvas modal uses. Defaults to
 * the app's own dashboard (always frameable); external sites work when
 * they allow framing, and the hint line says so when they don't.
 *
 * Element picker: the crosshair arms an inspector for SAME-ORIGIN pages
 * (your localhost apps) — hover highlights the element + live selector,
 * click copies the selector. Cross-origin iframes can't be instrumented;
 * the readout says so instead of failing silently.
 */

import { useEffect, useRef, useState } from 'react';
import { installBrowserAgent } from '@/lib/browser-agent/page-agent';
import { FONT, TERM_MIN_H, TERM_MIN_W } from './ui';
import { GlassCardShell } from './card-shell';

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

export interface BrowserTab {
  id: number;
  url: string;
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

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^localhost[:/]/.test(value) || /^127\.0\.0\.1[:/]/.test(value)) return `http://${value}`;
  return `https://${value}`;
}

/** The picker proxy re-serves LOCAL pages from our origin so their DOM
 *  becomes inspectable (other localhost ports are cross-origin by port).
 *  Tabs may carry proxied URLs; the bar and labels always show the real one. */
const PROXY_PATH = '/api/browser/proxy?url=';
const LOCAL_PAGE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i;

function toProxyUrl(url: string): string {
  return `${PROXY_PATH}${encodeURIComponent(url)}`;
}

function fromProxyUrl(url: string): string {
  const index = url.indexOf(PROXY_PATH);
  if (index === -1) return url;
  try {
    return decodeURIComponent(url.slice(index + PROXY_PATH.length));
  } catch {
    return url;
  }
}

function tabLabel(url: string): string {
  if (engineScope(url)) return 'Agent Chrome';
  return fromProxyUrl(url).replace(/^https?:\/\//i, '').replace(/\/$/, '') || 'New tab';
}

/** `o8-engine://<scope>` tabs are live views of the headless engine Chrome
 *  (#1232 phase 3) — the agent drives, the operator watches. */
const ENGINE_PREFIX = 'o8-engine://';

function engineScope(url: string): string | null {
  return url.startsWith(ENGINE_PREFIX) ? url.slice(ENGINE_PREFIX.length) || 'operator' : null;
}

function EngineLiveView({ scope, active }: { scope: string; active: boolean }) {
  const [tick, setTick] = useState(0);
  const [meta, setMeta] = useState<{ active: boolean; url?: string; title?: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1200);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!active || tick % 3 !== 0) return undefined;
    let stale = false;
    fetch(`/api/browser/engine/view?scope=${encodeURIComponent(scope)}&meta=1`)
      .then((response) => response.json())
      .then((data: { active: boolean; url?: string; title?: string }) => { if (!stale) setMeta(data); })
      .catch(() => undefined);
    return () => { stale = true; };
  }, [active, scope, tick]);
  const live = meta?.active !== false;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff' }}>
      {live ? (
        <img
          src={`/api/browser/engine/view?scope=${encodeURIComponent(scope)}&t=${tick}`}
          alt="Agent Chrome live view"
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'top center' }}
        />
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 300, color: 'rgba(0,0,0,0.45)', textAlign: 'center', paddingLeft: 24, paddingRight: 24 }}>
          Engine idle — agents land here when they open an external URL.
        </div>
      )}
      {live && meta?.url ? (
        <div style={{ position: 'absolute', left: 8, bottom: 8, maxWidth: 'calc(100% - 16px)', paddingTop: 3, paddingBottom: 3, paddingLeft: 8, paddingRight: 8, borderRadius: 7, background: 'rgba(17,17,17,0.78)', color: 'rgba(255,255,255,0.92)', fontSize: 10.5, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Agent Chrome · {meta.url}
        </div>
      ) : null}
    </div>
  );
}

/** Shortest selector that still uniquely hits the element in its doc. */
function cssSelectorFor(el: Element): string {
  const doc = el.ownerDocument;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node !== doc.documentElement && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const classes = [...node.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
    if (classes) part += classes;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    const candidate = parts.join(' > ');
    try {
      if (doc.querySelectorAll(candidate).length === 1) return candidate;
    } catch {
      // bad escape — keep walking
    }
    node = parent;
  }
  return parts.join(' > ');
}

export function BrowserGlassCard({
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
  const [urlDraft, setUrlDraft] = useState(fromProxyUrl(activeUrl));
  const iframeRefs = useRef(new Map<number, HTMLIFrameElement>());
  const [picking, setPicking] = useState(false);
  const [readout, setReadout] = useState<string | null>(null);
  const pickerCleanupRef = useRef<(() => void) | null>(null);
  /** Set when arming required a proxy reload — re-arms once the load lands. */
  const pendingArmRef = useRef(false);
  /** Agent-driving glow — pulses when an agent verb lands on this surface. */
  const [agentGlow, setAgentGlow] = useState(false);

  // Switching tabs (or a navigate landing) re-seeds the URL bar.
  useEffect(() => { setUrlDraft(fromProxyUrl(activeUrl)); }, [activeUrl]);

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

  const navigate = (url: string) => {
    onTabsChange(card.id, card.tabs.map((tab) => (tab.id === card.activeTabId ? { ...tab, url } : tab)), card.activeTabId);
  };
  const addTab = () => {
    const nextId = card.tabs.reduce((max, tab) => Math.max(max, tab.id), 0) + 1;
    onTabsChange(card.id, [...card.tabs, { id: nextId, url: `${window.location.origin}/dashboard` }], nextId);
  };
  const closeTab = (tabId: number) => {
    const remaining = card.tabs.filter((tab) => tab.id !== tabId);
    if (remaining.length === 0) {
      onClose(card.id);
      return;
    }
    onTabsChange(card.id, remaining, tabId === card.activeTabId ? remaining[remaining.length - 1].id : card.activeTabId);
  };

  const disarmPicker = () => {
    pickerCleanupRef.current?.();
    pickerCleanupRef.current = null;
    setPicking(false);
  };

  const armPicker = () => {
    if (picking) {
      disarmPicker();
      return;
    }
    const frame = iframeRefs.current.get(card.activeTabId) ?? null;
    let doc: Document | null = null;
    try {
      doc = frame?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc || !doc.body) {
      // Cross-origin-by-port localhost page — reload it through the
      // same-origin picker proxy, then arm once the load lands.
      const realUrl = fromProxyUrl(activeUrl);
      if (LOCAL_PAGE.test(realUrl) && activeUrl === realUrl) {
        pendingArmRef.current = true;
        navigate(toProxyUrl(realUrl));
        setReadout('Reloading through the picker proxy…');
        return;
      }
      setReadout('Picker needs a local page — external sites can’t be instrumented.');
      return;
    }
    const highlight = doc.createElement('div');
    highlight.setAttribute('style', 'position:absolute;pointer-events:none;z-index:2147483600;border:1px solid #f59e0b;background:rgba(245,158,11,0.12);border-radius:2px;display:none;');
    doc.body.appendChild(highlight);

    const onMoveOver = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || target === highlight) return;
      const rect = target.getBoundingClientRect();
      const win = doc!.defaultView;
      highlight.style.display = 'block';
      highlight.style.left = `${rect.left + (win?.scrollX ?? 0)}px`;
      highlight.style.top = `${rect.top + (win?.scrollY ?? 0)}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
      setReadout(`${cssSelectorFor(target)}  ·  ${Math.round(rect.width)}×${Math.round(rect.height)}`);
    };
    const onPick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target as Element | null;
      if (!target) return;
      const selector = cssSelectorFor(target);
      try {
        void navigator.clipboard.writeText(selector);
        setReadout(`${selector}  ·  copied`);
      } catch {
        setReadout(selector);
      }
      disarm();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') disarm();
    };
    const disarm = () => {
      doc!.removeEventListener('mousemove', onMoveOver, true);
      doc!.removeEventListener('click', onPick, true);
      doc!.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onKey, true);
      highlight.remove();
      pickerCleanupRef.current = null;
      setPicking(false);
    };
    doc.addEventListener('mousemove', onMoveOver, true);
    doc.addEventListener('click', onPick, true);
    doc.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onKey, true);
    pickerCleanupRef.current = disarm;
    setPicking(true);
    setReadout('Hover the page, click to copy the selector. Esc cancels.');
  };

  // Navigating away, switching tabs, or unmounting tears the picker down.
  useEffect(() => () => { pickerCleanupRef.current?.(); }, []);
  useEffect(() => {
    pickerCleanupRef.current?.();
    setPicking(false);
  }, [activeUrl, card.activeTabId]);

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={TERM_MIN_W}
      minH={TERM_MIN_H}
      title={tabLabel(activeUrl)}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
    >
        {/* URL bar — stays in the BODY (the shell's grab pill is the drag
            handle now). Globe + address + element picker. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2, paddingBottom: 6, paddingLeft: 16, paddingRight: 16 }}>
          <svg style={{ width: 11, height: 11, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <input
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              const next = normalizeUrl(urlDraft);
              if (next) {
                setUrlDraft(next);
                navigate(next);
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="Browser address"
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
              fontSize: 10.5,
              fontWeight: 300,
              letterSpacing: '-0.05px',
              fontFamily: FONT,
            }}
          />
          <button
            type="button"
            aria-label={picking ? 'Stop picking elements' : 'Pick an element'}
            title={picking ? 'Stop picking' : 'Pick an element — hover highlights, click copies the selector'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={armPicker}
            style={{
              borderWidth: 0,
              background: 'transparent',
              padding: 2,
              paddingLeft: 4,
              paddingRight: 4,
              color: picking ? '#f59e0b' : 'var(--cnv-ink-muted)',
              cursor: 'pointer',
              display: 'inline-flex',
            }}
            onMouseEnter={(event) => { if (!picking) event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { if (!picking) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            <svg style={{ width: 12, height: 12, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
            </svg>
          </button>
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
                aria-label={`Tab — ${tabLabel(tab.url)}`}
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
                  fontSize: 9.5,
                  fontWeight: 300,
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
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 132 }}>{tabLabel(tab.url)}</span>
                {card.tabs.length > 1 ? (
                  <span
                    role="button"
                    aria-label="Close tab"
                    onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
                    style={{ fontSize: 9, lineHeight: 1, paddingLeft: 2, paddingRight: 2, opacity: 0.7, cursor: 'pointer' }}
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
            style={{ borderWidth: 0, background: 'transparent', color: 'var(--cnv-ink-muted)', fontSize: 12, lineHeight: 1, paddingTop: 1, paddingBottom: 1, paddingLeft: 6, paddingRight: 6, cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            +
          </button>
        </div>

        {/* Selector readout — appears while picking / after a pick. */}
        {readout ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2, paddingBottom: 4, paddingLeft: 16, paddingRight: 16, flexShrink: 0 }}>
            <span style={{ flex: 1, fontFamily: MONO, fontSize: 9.5, fontWeight: 300, color: picking ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {readout}
            </span>
            <button
              type="button"
              aria-label="Dismiss selector readout"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setReadout(null)}
              style={{ borderWidth: 0, background: 'transparent', padding: 0, fontSize: 9.5, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT }}
            >
              ✕
            </button>
          </div>
        ) : null}

        {/* The page — solid paper behind the iframes, never glass-through.
            Every tab stays mounted (display toggles) so scroll/form state
            survives switching, like a real browser. The amber ring pulses
            when an agent verb lands on this surface. */}
        <div style={{ height: card.h, position: 'relative', background: '#fff', boxShadow: agentGlow ? 'inset 0 0 0 1.5px rgba(245,158,11,0.75)' : 'none' }}>
          {card.tabs.map((tab) => {
            const liveScope = engineScope(tab.url);
            if (liveScope) {
              return (
                <div key={tab.id} style={{ position: 'absolute', inset: 0, display: tab.id === card.activeTabId ? 'block' : 'none' }}>
                  <EngineLiveView scope={liveScope} active={tab.id === card.activeTabId} />
                </div>
              );
            }
            return (
              <iframe
                key={tab.id}
                ref={(node) => {
                  if (node) iframeRefs.current.set(tab.id, node);
                  else iframeRefs.current.delete(tab.id);
                }}
                src={tab.url}
                title={`Browser — ${tabLabel(tab.url)}`}
                onLoad={() => {
                  if (!pendingArmRef.current || tab.id !== card.activeTabId) return;
                  pendingArmRef.current = false;
                  armPicker();
                }}
                data-o8-browser="canvas"
                data-o8-active={tab.id === card.activeTabId ? 'true' : 'false'}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', borderWidth: 0, display: tab.id === card.activeTabId ? 'block' : 'none' }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            );
          })}
        </div>
    </GlassCardShell>
  );
}
