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

  const computeRect = useCallback((): BrowserViewRect | null => {
    const el = ref.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
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
  }, [url, computeRect]);

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
    const onMove = () => syncRect();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [syncRect]);

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
