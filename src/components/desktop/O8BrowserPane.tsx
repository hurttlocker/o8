'use client';

/**
 * O8BrowserPane — Chrome-like browser tab experience inside the O8 panel.
 *
 * Tab bar + URL bar + iframe content. Localhost previews seed as initial tabs.
 * New Tab page shows detected ports as clickable tiles.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PREVIEW_HOST_MESSAGE_SOURCE,
  PREVIEW_MESSAGE_SOURCE,
  PREVIEW_PROXY_ROUTE,
  formatPreviewAnnotationContext,
  type DetectedLocalhostPreview,
  type PreviewAnnotationPayload,
} from '@/lib/panel/preview';
import {
  ELEMENT_PICKER_START_EVENT,
  ELEMENT_PICKER_RESULT_EVENT,
  type PickedElement,
} from '@/lib/browser/element-picker-bridge';
import { O8ElementPanel } from './O8ElementPanel';

// ── iframe-proxy helper ──
// The element picker needs the bridge script living inside the iframe's
// document. Loading a dev server directly makes the iframe cross-origin with
// our dashboard, which blocks script injection. Routing the URL through our
// own origin (`/api/panel/iframe-proxy?url=...`) makes it same-origin, lets
// the proxy route inject the bridge, and unblocks the picker. For non-loopback
// URLs we fall back to direct loading — external sites don't support picking.
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

function proxiedPickUrl(url: string): string {
  return isLoopbackUrl(url)
    ? `/api/panel/iframe-proxy?pick=1&url=${encodeURIComponent(url)}`
    : url;
}

function proxiedLiveUrl(url: string): string {
  return isLoopbackUrl(url)
    ? `${PREVIEW_PROXY_ROUTE}?url=${encodeURIComponent(url.replace('0.0.0.0', 'localhost'))}`
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
  onEditWithAI?: (context: string) => void;
  onOpenFile?: (filePath: string) => void;
  navigateToUrl?: string | null;
  // Bubbles the currently-loaded URL up to the dashboard so the TitleBar
  // Browser button can render a hover-preview iframe pointed at it.
  onActiveUrlChange?: (url: string | null) => void;
}

type AnnotationScreenshot = NonNullable<PreviewAnnotationPayload['screenshot']>;

interface AnnotationScreenshotResponse {
  ok?: boolean;
  screenshot?: AnnotationScreenshot;
  error?: string;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function iframePanelRect(iframe: HTMLIFrameElement | null) {
  const rect = iframe?.getBoundingClientRect();
  if (!rect) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
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

function annotationTargetLabel(target: PreviewAnnotationPayload['domMap']['start']): string {
  if (!target) return 'unknown element';
  if (target.id) return `#${target.id}`;
  if (target.classes.length > 0) return `.${target.classes.slice(0, 2).join('.')}`;
  return target.selector || `<${target.tagName.toLowerCase()}>`;
}

function formatAnnotationSummary(annotation: PreviewAnnotationPayload): string {
  return `${annotationTargetLabel(annotation.domMap.start)} -> ${annotationTargetLabel(annotation.domMap.end)}`;
}

let tabCounter = 0;
function newTabId(): string {
  tabCounter += 1;
  return `btab-${tabCounter}-${Date.now()}`;
}

// ── Component ──

export function O8BrowserPane({ previews = [], onEditWithAI, onOpenFile, navigateToUrl, onActiveUrlChange }: O8BrowserPaneProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const seeded = useRef(false);
  const [pickerActive, setPickerActive] = useState(false);
  const [annotationActive, setAnnotationActive] = useState(false);
  const [selectedElement, setSelectedElement] = useState<PickedElement | null>(null);
  const [visualAnnotation, setVisualAnnotation] = useState<PreviewAnnotationPayload | null>(null);
  const [capturingAnnotation, setCapturingAnnotation] = useState(false);
  const [annotationCaptureError, setAnnotationCaptureError] = useState<string | null>(null);

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
    if (activeTab?.url) window.open(activeTab.url, '_blank');
  }, [activeTab]);

  // ── Element Picker ──
  //
  // Default iframe loads the target URL DIRECTLY so the user's SPA boots
  // normally (Next.js, Vite, etc.). Direct load means cross-origin, which
  // blocks the picker bridge — that's fine until the user wants to pick.
  //
  // When the picker is toggled ON we swap the iframe src to the proxy route
  // with `?pick=1`, which serves the same HTML from OUR origin with every
  // `<script>` tag stripped and the bridge pre-installed. The SSR-rendered
  // DOM is fully visible and pickable; there is no runtime to crash with
  // "Application error". When toggled OFF we swap back to the direct URL
  // and the SPA rehydrates.
  const togglePicker = useCallback(() => {
    setPickerActive((prev) => {
      const next = !prev;
      if (next) {
        setSelectedElement(null);
        setVisualAnnotation(null);
        setAnnotationCaptureError(null);
        setAnnotationActive(false);
      }
      return next;
    });
  }, []);

  const syncAnnotationMode = useCallback((enabled: boolean) => {
    const iframe = iframeRef.current;
    iframe?.contentWindow?.postMessage({
      source: PREVIEW_HOST_MESSAGE_SOURCE,
      type: 'annotation-mode',
      enabled,
    }, window.location.origin);
  }, []);

  const toggleAnnotation = useCallback(() => {
    setAnnotationActive((prev) => {
      const next = !prev;
      if (next) {
        setPickerActive(false);
        setSelectedElement(null);
        setVisualAnnotation(null);
        setAnnotationCaptureError(null);
      } else {
        syncAnnotationMode(false);
      }
      return next;
    });
  }, [syncAnnotationMode]);

  // Build the iframe src based on picker state. When picking, proxy + strip
  // scripts. Otherwise direct-load for full SPA functionality.
  const iframeSrc = activeTab?.url
    ? (pickerActive ? proxiedPickUrl(activeTab.url) : annotationActive || visualAnnotation ? proxiedLiveUrl(activeTab.url) : activeTab.url)
    : '';

  // When the proxied iframe finishes loading, kick the bridge script into
  // picker mode with a postMessage. The bridge was injected at the top of
  // `<head>` by the proxy, so by onLoad time it has installed its listeners.
  // When the user toggles picker OFF, the iframe navigates back to the
  // direct URL and the old document is unloaded — no explicit STOP needed.
  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    if (annotationActive) {
      syncAnnotationMode(true);
      return;
    }
    if (!pickerActive) return;
    try {
      iframe.contentWindow.postMessage({ type: ELEMENT_PICKER_START_EVENT }, '*');
    } catch {
      // Target origin is '*' so postMessage rarely throws, but swallow in case
      // the iframe is cross-origin (non-loopback URL) and doesn't hear it.
    }
  }, [annotationActive, pickerActive, syncAnnotationMode]);

  const captureAnnotationScreenshot = useCallback(async (annotation: PreviewAnnotationPayload): Promise<PreviewAnnotationPayload> => {
    setCapturingAnnotation(true);
    setAnnotationCaptureError(null);

    try {
      await nextPaint();
      const response = await fetch('/api/panel/annotation-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotation,
          panelRect: iframePanelRect(iframeRef.current),
        }),
      });
      const payload = await response.json().catch(() => null) as AnnotationScreenshotResponse | null;
      if (!response.ok || !payload?.ok || !payload.screenshot) {
        throw new Error(payload?.error || `Screenshot capture failed with status ${response.status}`);
      }

      const enriched = { ...annotation, screenshot: payload.screenshot };
      setVisualAnnotation(enriched);
      return enriched;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Screenshot capture failed';
      const enriched = {
        ...annotation,
        screenshot: {
          error: message,
          capturedAt: new Date().toISOString(),
        },
      };
      setAnnotationCaptureError(message);
      setVisualAnnotation(enriched);
      return enriched;
    } finally {
      setCapturingAnnotation(false);
    }
  }, []);

  const handleSendVisualAnnotation = useCallback(async () => {
    if (!visualAnnotation || !onEditWithAI || capturingAnnotation) return;
    const enriched = await captureAnnotationScreenshot(visualAnnotation);
    onEditWithAI(formatPreviewAnnotationContext(enriched));
  }, [captureAnnotationScreenshot, capturingAnnotation, onEditWithAI, visualAnnotation]);

  // Listen for picker results
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === ELEMENT_PICKER_RESULT_EVENT && e.data.element) {
        setSelectedElement(e.data.element as PickedElement);
        setPickerActive(false);
        setVisualAnnotation(null);
        setAnnotationCaptureError(null);
        return;
      }

      if (e.origin !== window.location.origin) return;
      const data = e.data as {
        source?: string;
        type?: string;
        enabled?: boolean;
        annotation?: PreviewAnnotationPayload;
      };
      if (!data || data.source !== PREVIEW_MESSAGE_SOURCE) return;

      if (data.type === 'annotation-mode') {
        setAnnotationActive(Boolean(data.enabled));
        return;
      }

      if (data.type === 'annotation' && data.annotation) {
        setVisualAnnotation(data.annotation);
        setAnnotationCaptureError(null);
        setSelectedElement(null);
        setAnnotationActive(false);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // If no tabs, show empty state with option to add
  if (tabs.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 13 }}>No active previews</span>
        <button
          type="button"
          onClick={addNewTab}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            paddingTop: 6, paddingRight: 14, paddingBottom: 6, paddingLeft: 14,
            borderRadius: 8, border: '1px solid var(--t-divider)',
            background: 'var(--t-hover)', color: 'var(--t-text)',
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
                fontSize: 11, fontWeight: 500,
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
          onMouseEnter={(e) => { if (!pickerActive) e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { if (!pickerActive) e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={pickerActive ? '#3b82f6' : 'var(--t-text-secondary)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: 14, height: 14, minWidth: 14, minHeight: 14, flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="22" y1="12" x2="18" y2="12" />
            <line x1="6" y1="12" x2="2" y2="12" />
            <line x1="12" y1="6" x2="12" y2="2" />
            <line x1="12" y1="22" x2="12" y2="18" />
          </svg>
        </button>
        {/* Visual annotation toggle */}
        <button
          type="button"
          onClick={toggleAnnotation}
          title={annotationActive ? 'Cancel visual annotation' : 'Draw visual annotation'}
          disabled={!activeTab?.url || !isLoopbackUrl(activeTab.url)}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, border: 'none', borderRadius: 6,
            background: annotationActive ? 'rgba(249,115,22,0.22)' : 'transparent',
            cursor: activeTab?.url && isLoopbackUrl(activeTab.url) ? 'pointer' : 'default',
            padding: 0,
            opacity: activeTab?.url && isLoopbackUrl(activeTab.url) ? 1 : 0.35,
          }}
          onMouseEnter={(e) => { if (!annotationActive && activeTab?.url && isLoopbackUrl(activeTab.url)) e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { if (!annotationActive) e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={annotationActive ? '#f97316' : 'var(--t-text-secondary)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: 14, height: 14, minWidth: 14, minHeight: 14, flexShrink: 0 }}>
            <path d="M4 20 20 4" />
            <path d="M14 4h6v6" />
            <path d="M5 15c3-1 4 3 7 1" />
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
              onLoad={handleIframeLoad}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
              style={{
                width: '100%', height: selectedElement || visualAnnotation ? 'calc(100% - 32px)' : '100%',
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
            {/* Visual annotation info bar */}
            {visualAnnotation ? (
              <div style={{
                height: 32, display: 'flex', alignItems: 'center', gap: 8,
                paddingLeft: 10, paddingRight: 10,
                borderTop: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(249,115,22,0.10)', flexShrink: 0,
                fontSize: 11, fontFamily: '"SF Mono", ui-monospace, monospace',
                color: 'rgba(255,255,255,0.78)',
              }}>
                <span style={{ color: '#fb923c', fontWeight: 700 }}>arrow</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(255,255,255,0.58)' }}>
                  {formatAnnotationSummary(visualAnnotation)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setVisualAnnotation(null);
                    setAnnotationCaptureError(null);
                  }}
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
            {/* Visual annotation dispatch panel */}
            {visualAnnotation && !capturingAnnotation ? (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
              }}>
                <div
                  style={{
                    margin: '0 12px 0',
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 14,
                    background: 'rgba(20,20,25,0.95)',
                    backdropFilter: 'blur(12px)',
                    boxShadow: '0 22px 40px rgba(0,0,0,0.24)',
                    padding: 14,
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'grid', gap: 5 }}>
                    <div style={{ color: 'rgba(255,255,255,0.88)', fontSize: 13, fontWeight: 700 }}>
                      Visual annotation
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 12, fontFamily: '"SF Mono", ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatAnnotationSummary(visualAnnotation)}
                    </div>
                    {annotationCaptureError ? (
                      <div style={{ color: 'rgba(251,146,60,0.76)', fontSize: 11 }}>
                        Screenshot unavailable; agent will receive DOM map and annotation JSON.
                      </div>
                    ) : visualAnnotation.screenshot?.path ? (
                      <div style={{ color: 'rgba(255,255,255,0.42)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Screenshot attached: {visualAnnotation.screenshot.path}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => { void handleSendVisualAnnotation(); }}
                      disabled={!onEditWithAI || capturingAnnotation}
                      style={{
                        height: 28,
                        border: 'none',
                        borderRadius: 8,
                        background: '#f97316',
                        color: '#ffffff',
                        padding: '0 12px',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: onEditWithAI && !capturingAnnotation ? 'pointer' : 'default',
                        opacity: onEditWithAI && !capturingAnnotation ? 1 : 0.55,
                      }}
                    >
                      Send to agent
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setVisualAnnotation(null);
                        setAnnotationCaptureError(null);
                      }}
                      style={{
                        height: 28,
                        borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'transparent',
                        color: 'rgba(255,255,255,0.78)',
                        padding: '0 12px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
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
