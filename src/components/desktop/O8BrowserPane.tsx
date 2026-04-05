'use client';

/**
 * O8BrowserPane — Chrome-like browser tab experience inside the O8 panel.
 *
 * Tab bar + URL bar + iframe content. Localhost previews seed as initial tabs.
 * New Tab page shows detected ports as clickable tiles.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import {
  createElementPickerBridgeScript,
  ELEMENT_PICKER_START_EVENT,
  ELEMENT_PICKER_STOP_EVENT,
  ELEMENT_PICKER_RESULT_EVENT,
  type PickedElement,
} from '@/lib/browser/element-picker-bridge';
import { O8ElementPanel } from './O8ElementPanel';

// ── Types ──

interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

interface O8BrowserPaneProps {
  previews?: DetectedLocalhostPreview[];
  onEditWithAI?: (context: string) => void;
  onOpenFile?: (filePath: string) => void;
  navigateToUrl?: string | null;
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

export function O8BrowserPane({ previews = [], onEditWithAI, onOpenFile, navigateToUrl }: O8BrowserPaneProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const seeded = useRef(false);
  const [pickerActive, setPickerActive] = useState(false);
  const [selectedElement, setSelectedElement] = useState<PickedElement | null>(null);

  // Seed tabs from previews on first render
  useEffect(() => {
    if (seeded.current || previews.length === 0) return;
    seeded.current = true;
    const initial: BrowserTab[] = previews.map(p => ({
      id: newTabId(),
      url: p.url || `http://localhost:${p.port}`,
      title: `localhost:${p.port}`,
    }));
    setTabs(initial);
    setActiveTabId(initial[0].id);
    setUrlInput(initial[0].url);
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
      setActiveTabId(existing.id);
      setUrlInput(normalized);
      return;
    }
    // Create a new tab for this URL
    const id = newTabId();
    const newTab: BrowserTab = { id, url: normalized, title: titleFromUrl(normalized) };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(id);
    setUrlInput(normalized);
  }, [navigateToUrl, tabs]);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;

  // Sync URL input when switching tabs
  useEffect(() => {
    setUrlInput(activeTab?.url ?? '');
  }, [activeTabId, activeTab?.url]);

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
    if (activeTab?.url) window.open(activeTab.url, '_blank');
  }, [activeTab]);

  // ── Element Picker ──

  const togglePicker = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    if (pickerActive) {
      iframe.contentWindow.postMessage({ type: ELEMENT_PICKER_STOP_EVENT }, '*');
      setPickerActive(false);
      return;
    }
    // Inject bridge script (same-origin only)
    try {
      const doc = iframe.contentDocument;
      if (doc && !doc.getElementById('o8-picker-bridge')) {
        const script = doc.createElement('script');
        script.id = 'o8-picker-bridge';
        script.textContent = createElementPickerBridgeScript();
        doc.body.appendChild(script);
      }
      iframe.contentWindow.postMessage({ type: ELEMENT_PICKER_START_EVENT }, '*');
      setPickerActive(true);
      setSelectedElement(null);
    } catch {
      console.warn('[o8-browser] Cannot inject picker — cross-origin iframe');
    }
  }, [pickerActive]);

  // Listen for picker results
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === ELEMENT_PICKER_RESULT_EVENT && e.data.element) {
        setSelectedElement(e.data.element as PickedElement);
        setPickerActive(false);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // If no tabs, show empty state with option to add
  if (tabs.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>No active previews</span>
        <button
          type="button"
          onClick={addNewTab}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            paddingTop: 6, paddingRight: 14, paddingBottom: 6, paddingLeft: 14,
            borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)',
            fontSize: 12, fontWeight: 500, cursor: 'pointer',
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
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(0,0,0,0.15)', flexShrink: 0,
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
                background: isActive ? 'rgba(255,255,255,0.1)' : isHovered ? 'rgba(255,255,255,0.05)' : 'transparent',
                maxWidth: 180, minWidth: 0, flexShrink: 1,
                transition: 'background 100ms ease',
              }}
            >
              {/* Globe favicon */}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: 'block', width: 12, height: 12, minWidth: 12 }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontSize: 11, fontWeight: 500,
                color: isActive ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)',
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
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="3" strokeLinecap="round" style={{ display: 'block', width: 10, height: 10, minWidth: 10, minHeight: 10 }}>
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
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block' }}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* ── URL bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        height: 36, paddingLeft: 6, paddingRight: 6,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
      }}>
        {/* Element Picker toggle */}
        <button
          type="button"
          onClick={togglePicker}
          title={pickerActive ? 'Cancel element picker' : 'Select element'}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, border: 'none', borderRadius: 6,
            background: pickerActive ? 'rgba(37,99,235,0.2)' : 'transparent',
            cursor: 'pointer', padding: 0,
          }}
          onMouseEnter={(e) => { if (!pickerActive) e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={(e) => { if (!pickerActive) e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={pickerActive ? '#3b82f6' : 'rgba(255,255,255,0.5)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: 14, height: 14, minWidth: 14, minHeight: 14, flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="22" y1="12" x2="18" y2="12" />
            <line x1="6" y1="12" x2="2" y2="12" />
            <line x1="12" y1="6" x2="12" y2="2" />
            <line x1="12" y1="22" x2="12" y2="18" />
          </svg>
        </button>
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
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        {/* URL input */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center',
          height: 26, paddingLeft: 10, paddingRight: 10,
          borderRadius: 8, background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          {/* Lock/globe icon */}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: 'block', marginRight: 6 }}>
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
              color: 'rgba(255,255,255,0.75)', fontSize: 12,
              fontFamily: '-apple-system, system-ui, sans-serif',
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
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {/* External link icon */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
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
                      transition: 'background 120ms ease, border-color 120ms ease',
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
              src={activeTab.url}
              title={activeTab.title}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
              style={{
                width: '100%', height: selectedElement ? 'calc(100% - 32px)' : '100%',
                border: 'none', background: '#ffffff',
              }}
            />
            {/* Selected element info bar */}
            {selectedElement ? (
              <div style={{
                height: 32, display: 'flex', alignItems: 'center', gap: 8,
                paddingLeft: 10, paddingRight: 10,
                borderTop: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(37,99,235,0.08)', flexShrink: 0,
                fontSize: 11, fontFamily: '"SF Mono", ui-monospace, monospace',
                color: 'rgba(255,255,255,0.75)',
              }}>
                <span style={{ color: '#60a5fa', fontWeight: 600 }}>&lt;{selectedElement.tagName.toLowerCase()}&gt;</span>
                {selectedElement.classList.length > 0 ? (
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>.{selectedElement.classList.slice(0, 3).join('.')}</span>
                ) : null}
                {selectedElement.textContent ? (
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(255,255,255,0.5)' }}>
                    &quot;{selectedElement.textContent.slice(0, 60)}&quot;
                  </span>
                ) : <div style={{ flex: 1 }} />}
                <button
                  type="button"
                  onClick={() => setSelectedElement(null)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 18, height: 18, border: 'none', borderRadius: 4,
                    background: 'transparent', cursor: 'pointer', padding: 0,
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="3" strokeLinecap="round" style={{ display: 'block' }}>
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ) : null}
            {/* Element editing panel */}
            {selectedElement ? (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
              }}>
                <O8ElementPanel
                  element={selectedElement}
                  onClose={() => setSelectedElement(null)}
                  onEditWithAI={onEditWithAI}
                  onOpenSource={onOpenFile ? (file) => onOpenFile(file) : undefined}
                />
              </div>
            ) : null}
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
