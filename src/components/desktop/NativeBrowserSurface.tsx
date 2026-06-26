'use client';

/**
 * NativeBrowserSurface — the placeholder + position-sync layer for the native
 * browser-view child window (docs/native-browser-webview-spec.md, Stage 3).
 *
 * When the operator flag is on, O8BrowserPane renders THIS instead of the iframe
 * for a tab with a URL. It paints a transparent placeholder where the page
 * should be and drives the native host-owned `browser-view` window to sit over
 * that rect: open + navigate on url change, reposition on resize, hide when the
 * pane scrolls offscreen / the tab isn't visible / it unmounts.
 *
 * Self-contained visibility: an IntersectionObserver detects whether the
 * placeholder is actually on screen (the Browser tab can be `display:none` while
 * mounted), so this needs no `active` prop threaded through O8Panel's two mount
 * sites. The native window composites ABOVE o8's web content — occlusion of
 * overlays that cross this rect is handled in Stage 5.
 *
 * Everything no-ops outside Tauri/macOS (the iframe path is the default there).
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  isTauri,
  browserViewOpen,
  browserViewSetRect,
  browserViewHide,
  type BrowserViewRect,
} from '@/lib/tauri/bridge';
import { NATIVE_BROWSER_AGENT_SOURCE } from '@/lib/browser/native-agent-source';

interface NativeBrowserSurfaceProps {
  /** The active tab's URL — the page the native window navigates to. */
  url: string;
  /** Agent-driving glow (framed around the surface while a verb lands). */
  agentGlow?: boolean;
}

function rectKey(r: BrowserViewRect): string {
  return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`;
}

export function NativeBrowserSurface({ url, agentGlow }: NativeBrowserSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRect = useRef<string>('');
  /** Whether the placeholder is currently on screen (driven by the observer). */
  const visibleRef = useRef<boolean>(false);
  /** The URL currently shown by the native window (so we navigate on change). */
  const shownUrl = useRef<string>('');
  /** Page-zoom factor: visual-viewport px ÷ layout (CSS) px. 1 at 100%. */
  const zoomRef = useRef<number>(1);

  /** Measure the o8 webview's page zoom (Cmd +/-). getBoundingClientRect returns
   *  CSS px in the (possibly zoomed) LAYOUT viewport, but the native child window
   *  lives in the VISUAL viewport (window.innerWidth/innerHeight). Their ratio is
   *  the zoom factor — at 90% zoom, a 100vh element measures ~898 while
   *  innerHeight is 808, so coords must be scaled by 808/898 before they reach
   *  Rust or the native window lands too far right/down. Cached + remeasured on
   *  resize (zoom changes fire resize) so syncRect's hot path stays cheap. */
  const measureZoom = useCallback(() => {
    try {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:100vh;pointer-events:none;visibility:hidden';
      document.body.appendChild(probe);
      const vh = probe.getBoundingClientRect().height;
      probe.remove();
      zoomRef.current = vh > 1 ? window.innerHeight / vh : 1;
    } catch {
      zoomRef.current = 1;
    }
  }, []);

  const computeRect = useCallback((): BrowserViewRect | null => {
    const el = ref.current;
    if (!el) return null;
    const z = zoomRef.current;
    const r = el.getBoundingClientRect();
    // Convert layout (CSS) px → VISUAL px by the zoom factor, then clamp to the
    // visible content area. The native child window is a SEPARATE OS window, NOT
    // clipped by o8's CSS overflow:hidden the way an iframe is — so without the
    // clamp it paints PAST o8's window edges. We also stop the bottom at the
    // FOOTER (DesktopStatusBar) top so the native window never covers the status
    // bar (operator video, 2026-06-25).
    let footerTop = window.innerHeight;
    const footer = document.querySelector('[data-mcp-scope="desktop-status-bar"]');
    if (footer) {
      const ft = footer.getBoundingClientRect().top * z;
      if (ft > 0 && ft <= window.innerHeight) footerTop = ft;
    }
    const left = Math.max(0, r.left * z);
    const top = Math.max(0, r.top * z);
    const right = Math.min(window.innerWidth, r.right * z);
    const bottom = Math.min(window.innerHeight, footerTop, r.bottom * z);
    const w = right - left;
    const h = bottom - top;
    if (w < 1 || h < 1) return null;
    return { x: left, y: top, w, h };
  }, []);

  /** Push the current rect to the native window, deduped. */
  const syncRect = useCallback(() => {
    if (!visibleRef.current) return;
    const rect = computeRect();
    if (!rect) return;
    const key = rectKey(rect);
    if (key === lastRect.current) return;
    lastRect.current = key;
    void browserViewSetRect(rect);
  }, [computeRect]);

  /** Open/navigate the native window over the placeholder (only when visible). */
  const openHere = useCallback(() => {
    if (!visibleRef.current || !url) return;
    measureZoom();
    const rect = computeRect();
    if (!rect) {
      // Layout not settled yet — retry next frame.
      requestAnimationFrame(() => {
        if (!visibleRef.current || !url) return;
        const retry = computeRect();
        if (!retry) return;
        lastRect.current = rectKey(retry);
        shownUrl.current = url;
        void browserViewOpen(url, retry, NATIVE_BROWSER_AGENT_SOURCE);
      });
      return;
    }
    lastRect.current = rectKey(rect);
    shownUrl.current = url;
    void browserViewOpen(url, rect, NATIVE_BROWSER_AGENT_SOURCE);
  }, [url, computeRect, measureZoom]);

  // Visibility: open when the placeholder appears on screen, hide when it leaves
  // (tab switched away → display:none → not intersecting). The native window is a
  // separate OS window, so it won't auto-hide with the React pane — this is what
  // keeps it from floating over an unrelated tab.
  useEffect(() => {
    if (!isTauri()) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nowVisible = !!entry && entry.isIntersecting && entry.intersectionRatio > 0;
        if (nowVisible === visibleRef.current) return;
        visibleRef.current = nowVisible;
        if (nowVisible) openHere();
        else void browserViewHide();
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [openHere]);

  // Navigate when the URL changes while visible (tab switch / URL bar).
  useEffect(() => {
    if (!isTauri()) return;
    if (!visibleRef.current || !url || url === shownUrl.current) return;
    openHere();
  }, [url, openHere]);

  // Reposition on container/window resize + scroll. Live drag-resize jank +
  // overlay occlusion are handled in Stage 5 (hide + snapshot on settle).
  useEffect(() => {
    if (!isTauri()) return;
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => syncRect());
    ro.observe(el);
    // A window resize is also where page-zoom changes surface (Cmd +/- changes
    // innerWidth/innerHeight) — remeasure the zoom before repositioning. Scroll
    // and panel-divider drags (ResizeObserver) don't change zoom, so they skip it.
    const onResize = () => { measureZoom(); syncRect(); };
    const onScroll = () => syncRect();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [syncRect, measureZoom]);

  // Hide the native window on unmount (keep it alive for a fast re-show — the
  // Browser tab closing entirely is what triggers browser_view_close upstream).
  useEffect(() => {
    return () => {
      if (isTauri()) void browserViewHide();
    };
  }, []);

  return (
    <div
      ref={ref}
      data-o8-native-browser="panel"
      style={{
        width: '100%',
        height: '100%',
        background: 'transparent',
        boxShadow: agentGlow ? 'inset 0 0 0 1.5px rgba(245,158,11,0.75)' : 'none',
        transition: 'box-shadow 200ms ease-out',
      }}
    />
  );
}
