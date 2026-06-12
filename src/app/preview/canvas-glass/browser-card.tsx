'use client';

/**
 * Browser cards — a REAL browser pane on the canvas (#1232). URL bar +
 * iframe in the same squircle glass shell the terminals use. Defaults to
 * the app's own dashboard (always frameable); external sites work when
 * they allow framing, and the hint line says so when they don't.
 *
 * Element picker: the crosshair arms an inspector for SAME-ORIGIN pages
 * (your localhost apps) — hover highlights the element + live selector,
 * click copies the selector. Cross-origin iframes can't be instrumented;
 * the readout says so instead of failing silently.
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { FONT, TERM_MIN_H, TERM_MIN_W, glass } from './ui';

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

function tabLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '') || 'New tab';
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
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const activeTab = card.tabs.find((tab) => tab.id === card.activeTabId) ?? card.tabs[0];
  const activeUrl = activeTab?.url ?? '';
  const [urlDraft, setUrlDraft] = useState(activeUrl);
  const iframeRefs = useRef(new Map<number, HTMLIFrameElement>());
  const [picking, setPicking] = useState(false);
  const [readout, setReadout] = useState<string | null>(null);
  const pickerCleanupRef = useRef<(() => void) | null>(null);

  // Switching tabs (or a navigate landing) re-seeds the URL bar.
  useEffect(() => { setUrlDraft(activeUrl); }, [activeUrl]);

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
      setReadout('Picker needs a same-origin page — works on your localhost apps.');
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
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.86, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      onPointerDownCapture={() => onFocus(card.id)}
      style={{
        position: 'absolute',
        left: card.x,
        top: card.y,
        width: card.w,
        zIndex: card.z,
      }}
    >
      <SmoothCorners
        corners={{ radius: 14 }}
        shadowStrategy="box-shadow"
        style={{ display: 'flex', flexDirection: 'column', ...glass(true) }}
      >
        {/* Title bar — drag handle + URL bar. */}
        <div
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
            dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            onMove(card.id, Math.max(4, drag.originX + event.clientX - drag.startX), Math.max(40, drag.originY + event.clientY - drag.startY));
          }}
          onPointerUp={() => { dragRef.current = null; setDragging(false); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 7,
            paddingBottom: 7,
            paddingLeft: 12,
            paddingRight: 8,
            borderBottom: '1px solid var(--cnv-edge)',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
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
          <button
            type="button"
            aria-label="Close browser"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{
              borderWidth: 0,
              background: 'transparent',
              padding: 2,
              paddingLeft: 8,
              paddingRight: 8,
              fontSize: 11,
              color: 'var(--cnv-ink-muted)',
              cursor: 'pointer',
              fontFamily: FONT,
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        </div>

        {/* Tab strip — pills, like the default-side browser. Always present so
            the + is one click away; slim enough to cost nothing. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8, borderBottom: '1px solid var(--cnv-edge)', overflowX: 'auto', scrollbarWidth: 'none' } as React.CSSProperties}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, paddingBottom: 4, paddingLeft: 12, paddingRight: 8, borderBottom: '1px solid var(--cnv-edge)' }}>
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
            survives switching, like a real browser. */}
        <div style={{ height: card.h, position: 'relative', background: '#fff' }}>
          {card.tabs.map((tab) => (
            <iframe
              key={tab.id}
              ref={(node) => {
                if (node) iframeRefs.current.set(tab.id, node);
                else iframeRefs.current.delete(tab.id);
              }}
              src={tab.url}
              title={`Browser — ${tabLabel(tab.url)}`}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', borderWidth: 0, display: tab.id === card.activeTabId ? 'block' : 'none', ...(dragging || resizing ? { pointerEvents: 'none' } : {}) }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ))}

          {/* Corner resize grip. */}
          <div
            role="presentation"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
              resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originW: card.w, originH: card.h };
              setResizing(true);
            }}
            onPointerMove={(event) => {
              const resize = resizeRef.current;
              if (!resize || resize.pointerId !== event.pointerId) return;
              onResize(
                card.id,
                Math.max(TERM_MIN_W, resize.originW + event.clientX - resize.startX),
                Math.max(TERM_MIN_H, resize.originH + event.clientY - resize.startY),
              );
            }}
            onPointerUp={() => { resizeRef.current = null; setResizing(false); }}
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 18,
              height: 18,
              cursor: 'nwse-resize',
              touchAction: 'none',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'flex-end',
              paddingRight: 4,
              paddingBottom: 4,
              opacity: resizing ? 1 : 0.55,
            }}
            onMouseEnter={(event) => { event.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(event) => { if (!resizeRef.current) event.currentTarget.style.opacity = '0.55'; }}
          >
            <svg width={9} height={9} viewBox="0 0 9 9" aria-hidden>
              <path d="M8 1 1 8M8 5 5 8" stroke="rgba(0,0,0,0.45)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
            </svg>
          </div>
        </div>
      </SmoothCorners>
    </motion.div>
  );
}
