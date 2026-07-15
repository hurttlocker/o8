import { NextRequest, NextResponse } from 'next/server';
import {
  PREVIEW_HOST_MESSAGE_SOURCE,
  PREVIEW_MESSAGE_SOURCE,
  PREVIEW_PROXY_ROUTE,
} from '@/lib/panel/preview';
import { isSensitivePreviewRequestHeader, parseLocalPreviewTarget } from '@/lib/panel/preview-proxy-security';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const FRAME_BUSTING_RESPONSE_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'x-frame-options',
];
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
const URL_ATTR_RE = /\b(src|href|action|poster)=("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SRCSET_ATTR_RE = /\bsrcset=("([^"]*)"|'([^']*)')/gi;
const STYLE_ATTR_RE = /\bstyle=("([^"]*)"|'([^']*)')/gi;
const STYLE_TAG_RE = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const BASE_TAG_RE = /<base\b[^>]*>/gi;
const FRAME_BUSTING_META_RE = /<meta\b[^>]*http-equiv=(?:"|')?(?:content-security-policy|x-frame-options)(?:"|')?[^>]*>/gi;

function parseLocalTarget(targetUrl: string | null): URL | null {
  return parseLocalPreviewTarget(targetUrl);
}

function isSameLocalApp(candidate: URL, target: URL): boolean {
  return (
    candidate.protocol === target.protocol
    && candidate.port === target.port
    && LOCAL_HOSTS.has(candidate.hostname)
    && LOCAL_HOSTS.has(target.hostname)
  );
}

function isSkippableReference(value: string): boolean {
  return (
    !value
    || value.startsWith('#')
    || value.startsWith('about:')
    || value.startsWith('blob:')
    || value.startsWith('data:')
    || value.startsWith('javascript:')
    || value.startsWith('mailto:')
    || value.startsWith('tel:')
    || value.startsWith(PREVIEW_PROXY_ROUTE)
  );
}

function buildProxyUrl(targetUrl: string): string {
  return `${PREVIEW_PROXY_ROUTE}?url=${encodeURIComponent(targetUrl)}`;
}

function resolveProxyCandidate(value: string, currentUrl: URL): string | null {
  if (isSkippableReference(value)) return null;

  try {
    const resolved = value.startsWith('//')
      ? new URL(`${currentUrl.protocol}${value}`)
      : new URL(value, currentUrl);

    return isSameLocalApp(resolved, currentUrl) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function rewriteAssetReference(value: string, currentUrl: URL): string {
  const candidate = resolveProxyCandidate(value, currentUrl);
  return candidate ? buildProxyUrl(candidate) : value;
}

function rewriteSrcSet(value: string, currentUrl: URL): string {
  return value
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return trimmed;
      const [urlPart, ...descriptor] = trimmed.split(/\s+/);
      const rewritten = rewriteAssetReference(urlPart, currentUrl);
      return [rewritten, ...descriptor].filter(Boolean).join(' ');
    })
    .join(', ');
}

function rewriteCssText(css: string, currentUrl: URL): string {
  const rewrittenUrls = css.replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, quote: string, rawValue: string) => {
    const rewritten = rewriteAssetReference(rawValue.trim(), currentUrl);
    if (rewritten === rawValue.trim()) return match;
    return `url(${quote}${rewritten}${quote})`;
  });

  return rewrittenUrls.replace(/@import\s+(?!url\()(["'])([^"']+)\1/gi, (match, quote: string, rawValue: string) => {
    const rewritten = rewriteAssetReference(rawValue.trim(), currentUrl);
    if (rewritten === rawValue.trim()) return match;
    return `@import ${quote}${rewritten}${quote}`;
  });
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('\'', '&#39;')
    .replaceAll('"', '&quot;');
}

function escapeInlineScript(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

function buildPreviewClientScript(currentUrl: URL): string {
  const targetUrl = JSON.stringify(currentUrl.toString());
  const targetOrigin = JSON.stringify(currentUrl.origin);
  const proxyRoute = JSON.stringify(PREVIEW_PROXY_ROUTE);
  const messageSource = JSON.stringify(PREVIEW_MESSAGE_SOURCE);
  const hostMessageSource = JSON.stringify(PREVIEW_HOST_MESSAGE_SOURCE);

  return `
(() => {
  if (window.__cortexPreviewBootstrap) return;
  window.__cortexPreviewBootstrap = true;

  const TARGET_URL = ${targetUrl};
  const TARGET_ORIGIN = ${targetOrigin};
  const PROXY_ROUTE = ${proxyRoute};
  const MESSAGE_SOURCE = ${messageSource};
  const HOST_MESSAGE_SOURCE = ${hostMessageSource};
  const STYLE_KEYS = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'display', 'position'];
  const state = {
    currentUrl: TARGET_URL,
    selectionEnabled: false,
    annotationEnabled: false,
    drawing: false,
    hovered: null,
    overlay: null,
    annotationOverlay: null,
    annotationPath: [],
    observer: null,
  };

  function safeResolve(value, base) {
    if (
      !value
      || value.startsWith('#')
      || value.startsWith('about:')
      || value.startsWith('blob:')
      || value.startsWith('data:')
      || value.startsWith('javascript:')
      || value.startsWith('mailto:')
      || value.startsWith('tel:')
      || value.startsWith(PROXY_ROUTE)
    ) {
      return null;
    }

    try {
      const current = new URL(base || state.currentUrl);
      const resolved = value.startsWith('//')
        ? new URL(current.protocol + value)
        : new URL(value, current);
      return resolved.origin === TARGET_ORIGIN ? resolved.toString() : null;
    } catch {
      return null;
    }
  }

  function toProxyUrl(value, base) {
    const resolved = safeResolve(String(value), base);
    return resolved ? PROXY_ROUTE + '?url=' + encodeURIComponent(resolved) : value;
  }

  function rewriteSrcsetValue(value, base) {
    return String(value)
      .split(',')
      .map((entry) => {
        const trimmed = entry.trim();
        if (!trimmed) return trimmed;
        const parts = trimmed.split(/\\s+/);
        const rewritten = toProxyUrl(parts[0], base);
        return [rewritten, ...parts.slice(1)].filter(Boolean).join(' ');
      })
      .join(', ');
  }

  function rewriteCssText(value, base) {
    return String(value).replace(/url\\((['"]?)([^'")]+)\\1\\)/gi, (match, quote, rawValue) => {
      const rewritten = toProxyUrl(rawValue.trim(), base);
      if (rewritten === rawValue.trim()) return match;
      return 'url(' + quote + rewritten + quote + ')';
    });
  }

  function rewriteElement(element) {
    if (!(element instanceof Element)) return;

    ['src', 'href', 'action', 'poster'].forEach((attr) => {
      const value = element.getAttribute(attr);
      if (!value) return;
      const rewritten = toProxyUrl(value, state.currentUrl);
      if (rewritten !== value) element.setAttribute(attr, rewritten);
    });

    if (element.hasAttribute('srcset')) {
      const srcset = element.getAttribute('srcset') || '';
      const rewritten = rewriteSrcsetValue(srcset, state.currentUrl);
      if (rewritten !== srcset) element.setAttribute('srcset', rewritten);
    }

    if (element.hasAttribute('style')) {
      const styleValue = element.getAttribute('style') || '';
      const rewritten = rewriteCssText(styleValue, state.currentUrl);
      if (rewritten !== styleValue) element.setAttribute('style', rewritten);
    }

    if (element.tagName === 'STYLE' && element.textContent) {
      const rewritten = rewriteCssText(element.textContent, state.currentUrl);
      if (rewritten !== element.textContent) element.textContent = rewritten;
    }
  }

  function rewriteTree(root) {
    if (!(root instanceof Element)) return;
    rewriteElement(root);
    root.querySelectorAll('*').forEach((child) => rewriteElement(child));
  }

  function observeDom() {
    if (state.observer) return;
    state.observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'attributes' && record.target instanceof Element) {
          rewriteElement(record.target);
          return;
        }

        record.addedNodes.forEach((node) => {
          if (node instanceof Element) rewriteTree(node);
        });
      });
    });

    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'action', 'poster', 'srcset', 'style'],
    });
  }

  function installNetworkPatches() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof input === 'string') return nativeFetch(toProxyUrl(input, state.currentUrl), init);
      if (input instanceof URL) return nativeFetch(toProxyUrl(input.toString(), state.currentUrl), init);
      if (input instanceof Request) {
        const proxied = toProxyUrl(input.url, state.currentUrl);
        if (proxied !== input.url) return nativeFetch(new Request(proxied, input), init);
      }
      return nativeFetch(input, init);
    };

    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return nativeOpen.call(this, method, toProxyUrl(String(url), state.currentUrl), ...rest);
    };

    if (navigator.sendBeacon) {
      const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => nativeSendBeacon(toProxyUrl(String(url), state.currentUrl), data);
    }

    if (window.EventSource) {
      const NativeEventSource = window.EventSource;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.EventSource = function(url, config) {
        return new NativeEventSource(toProxyUrl(String(url), state.currentUrl), config);
      } as unknown as typeof EventSource;
      window.EventSource.prototype = NativeEventSource.prototype;
      Object.setPrototypeOf(window.EventSource, NativeEventSource);
    }

    if (window.WebSocket) {
      const NativeWebSocket = window.WebSocket;
      const toSocketUrl = (url) => {
        const resolved = safeResolve(String(url), state.currentUrl);
        if (!resolved) return url;
        const next = new URL(resolved);
        next.protocol = next.protocol === 'https:' ? 'wss:' : 'ws:';
        return next.toString();
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.WebSocket = function(url, protocols) {
        const nextUrl = toSocketUrl(url);
        return protocols === undefined
          ? new NativeWebSocket(nextUrl)
          : new NativeWebSocket(nextUrl, protocols);
      } as unknown as typeof WebSocket;
      window.WebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(window.WebSocket, NativeWebSocket);
    }
  }

  function installNavigationPatches() {
    const nativePushState = history.pushState.bind(history);
    history.pushState = function(historyState, unused, url) {
      if (typeof url === 'string') {
        const resolved = safeResolve(url, state.currentUrl);
        if (resolved) state.currentUrl = resolved;
      }
      return nativePushState(historyState, unused, url);
    };

    const nativeReplaceState = history.replaceState.bind(history);
    history.replaceState = function(historyState, unused, url) {
      if (typeof url === 'string') {
        const resolved = safeResolve(url, state.currentUrl);
        if (resolved) state.currentUrl = resolved;
      }
      return nativeReplaceState(historyState, unused, url);
    };

    window.addEventListener('popstate', () => {
      state.hovered = null;
      if (state.overlay) state.overlay.style.display = 'none';
    });

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!target) return;
      const href = target.getAttribute('href');
      if (!href) return;
      const proxied = toProxyUrl(href, state.currentUrl);
      if (proxied === href) return;
      event.preventDefault();
      state.currentUrl = safeResolve(href, state.currentUrl) || state.currentUrl;
      window.location.assign(proxied);
    }, true);
  }

  function ensureOverlay() {
    if (state.overlay) return state.overlay;
    const overlay = document.createElement('div');
    overlay.setAttribute('data-cortex-preview-overlay', 'true');
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0px',
      left: '0px',
      width: '0px',
      height: '0px',
      border: '2px solid rgba(37, 99, 235, 0.95)',
      background: 'rgba(37, 99, 235, 0.08)',
      boxShadow: '0 0 0 1px rgba(255,255,255,0.9) inset',
      pointerEvents: 'none',
      zIndex: '2147483646',
      borderRadius: '6px',
      display: 'none',
    });
    document.documentElement.appendChild(overlay);
    state.overlay = overlay;
    return overlay;
  }

  function elementFromPoint(root, x, y) {
    const element = root.elementFromPoint(x, y);
    if (!element) return null;
    if (element.shadowRoot) {
      return elementFromPoint(element.shadowRoot, x, y) || element;
    }
    return element;
  }

  function updateOverlay(element) {
    const overlay = ensureOverlay();
    if (!element || !(element instanceof Element)) {
      overlay.style.display = 'none';
      return;
    }

    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = Math.max(rect.width, 0) + 'px';
    overlay.style.height = Math.max(rect.height, 0) + 'px';
  }

  function ensureAnnotationOverlay() {
    if (state.annotationOverlay) return state.annotationOverlay;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-cortex-preview-annotation', 'true');
    Object.assign(svg.style, {
      position: 'fixed',
      inset: '0px',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '2147483647',
      overflow: 'visible',
      display: 'none',
    });
    document.documentElement.appendChild(svg);
    state.annotationOverlay = svg;
    return svg;
  }

  function clearAnnotationOverlay() {
    state.annotationPath = [];
    const overlay = ensureAnnotationOverlay();
    overlay.style.display = 'none';
    overlay.innerHTML = '';
  }

  function normalizePoint(event) {
    return {
      x: Math.round(event.clientX * 10) / 10,
      y: Math.round(event.clientY * 10) / 10,
    };
  }

  function renderAnnotationPath() {
    const overlay = ensureAnnotationOverlay();
    if (!state.annotationEnabled || state.annotationPath.length < 1) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      return;
    }

    overlay.style.display = 'block';
    const points = state.annotationPath.map((point) => point.x + ',' + point.y).join(' ');
    const end = state.annotationPath[state.annotationPath.length - 1];
    overlay.innerHTML =
      '<defs><marker id="cortex-annotation-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#f97316"></path></marker></defs>' +
      '<polyline points="' + points + '" fill="none" stroke="#f97316" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#cortex-annotation-arrow)" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.28));"></polyline>' +
      '<circle cx="' + end.x + '" cy="' + end.y + '" r="5" fill="#f97316"></circle>';
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  }

  function buildSelector(element) {
    const parts = [];
    let current = element;
    let depth = 0;

    while (current && current instanceof Element && depth < 4) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += '#' + cssEscape(current.id);
        parts.unshift(part);
        break;
      }

      const classes = Array.from(current.classList).slice(0, 2).map((name) => '.' + cssEscape(name));
      if (classes.length > 0) {
        part += classes.join('');
      } else if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }

      parts.unshift(part);
      current = current.parentElement;
      depth += 1;
    }

    return parts.join(' > ');
  }

  function buildDomTargetPayload(element) {
    if (!(element instanceof Element) || element.closest('[data-cortex-preview-overlay="true"], [data-cortex-preview-annotation="true"]')) {
      return null;
    }
    const computed = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const text = (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
    const snippet = (element.outerHTML || '').replace(/\\s+/g, ' ').trim().slice(0, 320);
    const styles = Object.fromEntries(
      STYLE_KEYS
        .map((key) => [key, computed[key]])
        .filter(([, value]) => Boolean(value))
    );

    return {
      selector: buildSelector(element),
      tagName: element.tagName,
      id: element.id || null,
      classes: Array.from(element.classList),
      role: element.getAttribute('role'),
      name: element.getAttribute('aria-label') || element.getAttribute('name'),
      text,
      snippet,
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      styles,
    };
  }

  function buildSelectionPayload(element) {
    return {
      targetUrl: state.currentUrl,
      pageTitle: document.title || '',
      ...buildDomTargetPayload(element),
    };
  }

  function dedupeDomTargets(elements) {
    const bySelector = new Map();
    elements.forEach((element) => {
      const target = buildDomTargetPayload(element);
      if (!target || bySelector.has(target.selector)) return;
      bySelector.set(target.selector, target);
    });
    return Array.from(bySelector.values());
  }

  function annotationBounds(path) {
    const xs = path.map((point) => point.x);
    const ys = path.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  function buildAnnotationPayload(path) {
    const start = path[0];
    const end = path[path.length - 1];
    const stride = Math.max(1, Math.floor(path.length / 14));
    const sampledElements = [];
    for (let index = 0; index < path.length; index += stride) {
      const point = path[index];
      const element = elementFromPoint(document, point.x, point.y);
      if (element) sampledElements.push(element);
    }

    const startElement = elementFromPoint(document, start.x, start.y);
    const endElement = elementFromPoint(document, end.x, end.y);
    if (startElement) sampledElements.unshift(startElement);
    if (endElement) sampledElements.push(endElement);

    return {
      targetUrl: state.currentUrl,
      pageTitle: document.title || '',
      kind: 'arrow',
      createdAt: new Date().toISOString(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      annotation: {
        start,
        end,
        path,
        bounds: annotationBounds(path),
      },
      domMap: {
        start: buildDomTargetPayload(startElement),
        end: buildDomTargetPayload(endElement),
        touched: dedupeDomTargets(sampledElements).slice(0, 16),
      },
    };
  }

  function setAnnotationMode(enabled) {
    state.annotationEnabled = Boolean(enabled);
    state.drawing = false;
    if (state.annotationEnabled) {
      state.selectionEnabled = false;
      state.hovered = null;
      updateOverlay(null);
      clearAnnotationOverlay();
    }
    document.documentElement.style.cursor = state.annotationEnabled ? 'crosshair' : (state.selectionEnabled ? 'crosshair' : '');
    if (!state.annotationEnabled) clearAnnotationOverlay();
  }

  function setSelectionMode(enabled) {
    state.selectionEnabled = Boolean(enabled);
    if (state.selectionEnabled) setAnnotationMode(false);
    state.hovered = null;
    document.documentElement.style.cursor = state.selectionEnabled ? 'crosshair' : '';
    updateOverlay(null);
  }

  document.addEventListener('mousemove', (event) => {
    if (!state.selectionEnabled) return;
    const next = elementFromPoint(document, event.clientX, event.clientY);
    state.hovered = next;
    updateOverlay(next);
  }, true);

  document.addEventListener('click', (event) => {
    if (!state.selectionEnabled) return;
    const target = state.hovered || (event.target instanceof Element ? event.target : null);
    if (!target || target.closest('[data-cortex-preview-overlay="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    window.parent?.postMessage({
      source: MESSAGE_SOURCE,
      type: 'selection',
      selection: buildSelectionPayload(target),
    }, '*');
  }, true);

  document.addEventListener('pointerdown', (event) => {
    if (!state.annotationEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    state.drawing = true;
    state.annotationPath = [normalizePoint(event)];
    renderAnnotationPath();
  }, true);

  document.addEventListener('pointermove', (event) => {
    if (!state.annotationEnabled || !state.drawing) return;
    event.preventDefault();
    event.stopPropagation();
    const point = normalizePoint(event);
    const previous = state.annotationPath[state.annotationPath.length - 1];
    if (!previous || Math.abs(previous.x - point.x) > 2 || Math.abs(previous.y - point.y) > 2) {
      state.annotationPath.push(point);
      renderAnnotationPath();
    }
  }, true);

  function finishAnnotation(event) {
    if (!state.annotationEnabled || !state.drawing) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    state.drawing = false;
    state.annotationPath.push(normalizePoint(event));
    const path = state.annotationPath.slice();
    if (path.length >= 2) {
      window.parent?.postMessage({
        source: MESSAGE_SOURCE,
        type: 'annotation',
        annotation: buildAnnotationPayload(path),
      }, '*');
    }
    state.annotationEnabled = false;
    document.documentElement.style.cursor = state.selectionEnabled ? 'crosshair' : '';
    window.parent?.postMessage({ source: MESSAGE_SOURCE, type: 'annotation-mode', enabled: false }, '*');
  }

  document.addEventListener('pointerup', finishAnnotation, true);
  document.addEventListener('pointercancel', (event) => {
    if (!state.annotationEnabled) return;
    event.preventDefault();
    state.drawing = false;
    clearAnnotationOverlay();
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selectionEnabled) {
      setSelectionMode(false);
      window.parent?.postMessage({ source: MESSAGE_SOURCE, type: 'selection-mode', enabled: false }, '*');
    }
    if (event.key === 'Escape' && state.annotationEnabled) {
      setAnnotationMode(false);
      window.parent?.postMessage({ source: MESSAGE_SOURCE, type: 'annotation-mode', enabled: false }, '*');
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== HOST_MESSAGE_SOURCE) return;
    if (data.type === 'selection-mode') {
      setSelectionMode(data.enabled);
      return;
    }
    if (data.type === 'annotation-mode') {
      setAnnotationMode(data.enabled);
    }
  });

  rewriteTree(document.documentElement);
  observeDom();
  installNetworkPatches();
  installNavigationPatches();
  window.parent?.postMessage({ source: MESSAGE_SOURCE, type: 'ready', url: state.currentUrl }, '*');
})();
`;
}

function rewriteHtmlDocument(html: string, currentUrl: URL): string {
  let rewritten = html
    .replace(BASE_TAG_RE, '')
    .replace(FRAME_BUSTING_META_RE, '');

  rewritten = rewritten.replace(URL_ATTR_RE, (match, attr: string, quoted: string, doubleValue: string | undefined, singleValue: string | undefined, bareValue: string | undefined) => {
    const value = doubleValue ?? singleValue ?? bareValue ?? '';
    const nextValue = rewriteAssetReference(value, currentUrl);
    if (nextValue === value) return match;

    if (doubleValue !== undefined) return `${attr}="${escapeHtmlAttr(nextValue)}"`;
    if (singleValue !== undefined) return `${attr}='${escapeHtmlAttr(nextValue)}'`;
    return `${attr}="${escapeHtmlAttr(nextValue)}"`;
  });

  rewritten = rewritten.replace(SRCSET_ATTR_RE, (match, doubleValue: string | undefined, singleValue: string | undefined) => {
    const value = doubleValue ?? singleValue ?? '';
    const nextValue = rewriteSrcSet(value, currentUrl);
    if (nextValue === value) return match;
    if (doubleValue !== undefined) return `srcset="${escapeHtmlAttr(nextValue)}"`;
    return `srcset='${escapeHtmlAttr(nextValue)}'`;
  });

  rewritten = rewritten.replace(STYLE_ATTR_RE, (match, doubleValue: string | undefined, singleValue: string | undefined) => {
    const value = doubleValue ?? singleValue ?? '';
    const nextValue = rewriteCssText(value, currentUrl);
    if (nextValue === value) return match;
    if (doubleValue !== undefined) return `style="${escapeHtmlAttr(nextValue)}"`;
    return `style='${escapeHtmlAttr(nextValue)}'`;
  });

  rewritten = rewritten.replace(STYLE_TAG_RE, (match, attrs: string, css: string) => {
    const nextCss = rewriteCssText(css, currentUrl);
    return nextCss === css ? match : `<style${attrs}>${nextCss}</style>`;
  });

  const baseHref = escapeHtmlAttr(buildProxyUrl(new URL('.', currentUrl).toString()));
  const injectedMarkup = `<base href="${baseHref}"><script>${escapeInlineScript(buildPreviewClientScript(currentUrl))}</script>`;

  if (/<head\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<head([^>]*)>/i, `<head$1>${injectedMarkup}`);
  }

  if (/<html\b[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<html([^>]*)>/i, `<html$1><head>${injectedMarkup}</head>`);
  }

  return `<head>${injectedMarkup}</head>${rewritten}`;
}

function buildUpstreamHeaders(req: NextRequest, targetUrl: URL): Headers {
  const headers = new Headers();

  req.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lowerKey)) return;
    if (isSensitivePreviewRequestHeader(lowerKey)) return;
    if (lowerKey.startsWith('sec-')) return;
    if (lowerKey.startsWith('x-forwarded-')) return;

    if (lowerKey === 'origin') {
      headers.set('origin', targetUrl.origin);
      return;
    }

    if (lowerKey === 'referer') {
      headers.set('referer', targetUrl.toString());
      return;
    }

    headers.set(key, value);
  });

  headers.set('accept-encoding', 'identity');
  if (!headers.has('accept')) headers.set('accept', '*/*');
  return headers;
}

function rewriteRedirectLocation(location: string, currentUrl: URL): string {
  const candidate = resolveProxyCandidate(location, currentUrl);
  return candidate ? buildProxyUrl(candidate) : location;
}

async function proxyRequest(req: NextRequest): Promise<NextResponse> {
  const targetUrl = parseLocalTarget(req.nextUrl.searchParams.get('url'));

  if (!targetUrl) {
    return NextResponse.json(
      { error: 'Invalid url param. Only localhost, 127.0.0.1, 0.0.0.0, and ::1 are allowed.' },
      { status: 400 },
    );
  }

  try {
    const body = BODYLESS_METHODS.has(req.method)
      ? undefined
      : await req.arrayBuffer();

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req, targetUrl),
      body,
      redirect: 'manual',
    });

    const headers = new Headers(upstream.headers);
    FRAME_BUSTING_RESPONSE_HEADERS.forEach((key) => headers.delete(key));

    const location = headers.get('location');
    if (location) headers.set('location', rewriteRedirectLocation(location, targetUrl));

    if (req.method === 'HEAD' || (upstream.status >= 300 && upstream.status < 400)) {
      return new NextResponse(null, { status: upstream.status, headers });
    }

    const contentType = headers.get('content-type') ?? '';

    if (contentType.includes('text/html')) {
      const html = rewriteHtmlDocument(await upstream.text(), targetUrl);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new NextResponse(html, { status: upstream.status, headers });
    }

    if (contentType.includes('text/css')) {
      const css = rewriteCssText(await upstream.text(), targetUrl);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new NextResponse(css, { status: upstream.status, headers });
    }

    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return NextResponse.json(
      { error: `Proxy error: ${error instanceof Error ? error.message : 'unknown'}` },
      { status: 502 },
    );
  }
}

export const dynamic = 'force-dynamic';

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
export const OPTIONS = proxyRequest;
export const HEAD = proxyRequest;
