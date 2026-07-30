'use client';

/**
 * NativeBrowserSurface — the placeholder + position-sync layer for the native
 * browser-view child window (docs/internals/native-browser-webview-spec.md, Stage 3).
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
  browserViewShow,
  browserViewCapture,
  browserViewClose,
  type BrowserViewRect,
} from '@/lib/tauri/bridge';
import { NATIVE_BROWSER_AGENT_SOURCE } from '@/lib/browser/native-agent-source';
import { cropRegionBase64, type CropRect } from '@/lib/browser/region-crop';

interface NativeBrowserSurfaceProps {
  /** The active tab's URL — the page the native window navigates to. */
  url: string;
  /** Agent-driving glow (framed around the surface while a verb lands). */
  agentGlow?: boolean;
}

function rectKey(r: BrowserViewRect): string {
  return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`;
}

let lastShownNativeBrowserUrl = '';

export function NativeBrowserSurface({ url, agentGlow }: NativeBrowserSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRect = useRef<string>('');
  /** Whether the placeholder is currently on screen (driven by the observer). */
  const visibleRef = useRef<boolean>(false);
  /** The URL currently shown by the native window (so we navigate on change). */
  const shownUrl = useRef<string>(lastShownNativeBrowserUrl);
  /** Page-zoom factor: visual-viewport px ÷ layout (CSS) px. 1 at 100%. */
  const zoomRef = useRef<number>(1);
  /** Occlusion state (Stage 5): the native window composites ABOVE o8's web
   *  content, so any overlay (⌘K palette, modal, dictation pill) that crosses the
   *  browser rect would render BEHIND it. When detected we hide the native window
   *  and paint a last-frame snapshot, then restore on close. */
  const occludedRef = useRef<boolean>(false);
  /** Sticky occlusion forced by the dashboard (Design Mode grab card open): the
   *  card lands over the BOTTOM of the native rect, which the geometric sampler
   *  misses, so the dashboard tells us to hide explicitly. While true, the
   *  geometric checkOcclusion must not un-hide. */
  const forceOccludeRef = useRef<boolean>(false);
  /** Cached base64 PNG of the page (no data: prefix) painted while occluded. */
  const snapshotRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (!visibleRef.current || occludedRef.current) return;
    const rect = computeRect();
    if (!rect) return;
    const key = rectKey(rect);
    if (key === lastRect.current) return;
    lastRect.current = key;
    void browserViewSetRect(rect);
  }, [computeRect]);

  /** Capture a fresh snapshot for the occlusion swap, debounced — only while the
   *  window is visible + NOT occluded (else screencapture grabs the overlay or a
   *  hidden region). The frozen frame is stale-tolerant (shown under an overlay
   *  the user is focused on), so exact timing doesn't matter. */
  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimer.current) clearTimeout(snapshotTimer.current);
    snapshotTimer.current = setTimeout(() => {
      if (!visibleRef.current || occludedRef.current) return;
      void browserViewCapture().then((png) => { if (png) snapshotRef.current = png; });
    }, 900);
  }, []);

  /** Enter/leave the occluded state: hide the native window + paint the snapshot
   *  so the o8 overlay underneath shows without a blank gap; restore on leave. */
  const setOccluded = useCallback((occluded: boolean) => {
    if (occluded === occludedRef.current) return;
    occludedRef.current = occluded;
    const img = imgRef.current;
    if (occluded) {
      if (img) {
        if (snapshotRef.current) {
          img.src = `data:image/png;base64,${snapshotRef.current}`;
          img.style.display = 'block';
        } else {
          img.style.display = 'none';
        }
      }
      void browserViewHide();
    } else {
      void browserViewShow();
      // The layout may have shifted while hidden — force a reposition.
      lastRect.current = '';
      syncRect();
      // Hold the snapshot a beat so the native window paints before we drop it
      // (no one-frame gap during the show), then refresh it for next time.
      if (img) setTimeout(() => { img.style.display = 'none'; }, 220);
      scheduleSnapshot();
    }
  }, [syncRect, scheduleSnapshot]);

  /** Detect an o8 overlay painting over the browser rect: sample the rect's
   *  center + corners with elementsFromPoint (CSS/layout coords). A hit only
   *  counts as occluding if it actually PAINTS something visible — walk up from
   *  the hit element and require a non-transparent background / image / blur
   *  before reaching the placeholder. This skips the transparent full-screen
   *  click-catcher wrappers that popovers/menus mount (which cover the rect but
   *  paint nothing — a false hide otherwise). The snapshot img is
   *  pointer-events:none so it's transparent to this probe. */
  const checkOcclusion = useCallback(() => {
    const el = ref.current;
    if (!el || !visibleRef.current) return;
    // Dashboard-forced occlusion (grab card open) wins over geometry — the card
    // only covers the bottom of the rect, so the sampler would falsely un-hide.
    if (forceOccludeRef.current) { setOccluded(true); return; }
    const r = el.getBoundingClientRect();
    // A degenerate anchor means a HIDDEN ancestor (Settings takeover's
    // display:none workspace, the width-0 collapsed right panel) — the native
    // child window ignores CSS, so treat it as occluded and hide explicitly
    // instead of keeping the last state (reviewer hardening, 2026-07-16).
    // Geometry returning >4px un-occludes through the normal probe below.
    if (r.width < 4 || r.height < 4) { setOccluded(true); return; }
    const paintsVisibly = (hit: Element): boolean => {
      let n: Element | null = hit;
      for (let i = 0; i < 6 && n && n !== document.body; i++) {
        if (n === el || el.contains(n)) return false; // reached the placeholder — not an occluder
        // Design Mode's overlay covers the whole screen but is meant to interact
        // WITH the native browser (Stage 4b click-to-grab), not hide it — skip it
        // so the native window stays visible + clickable while grabbing.
        if (n.getAttribute('data-design-mode-overlay') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
        if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
        const bg = cs.backgroundColor || '';
        if (bg && bg !== 'transparent') {
          const m = bg.match(/rgba?\(([^)]+)\)/);
          const parts = m ? m[1].split(',') : [];
          const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
          if (alpha > 0.02) return true;
        }
        n = n.parentElement;
      }
      return false;
    };
    // PORTAL RECT SWEEP (root fix, operator 2026-07-06). Point sampling kept
    // missing popovers whose overlap band dodged the probe grid (the context
    // meter cut a vertical strip between all three left-column probes). Every
    // o8 popover/menu portals into <body> with position:fixed, so instead of
    // guessing points we intersect each portal's PAINTED rect with the browser
    // rect exactly. A portal wrapper is often a transparent full-screen
    // click-catcher — when it doesn't paint, we look for its first painted
    // descendant and use THAT rect (bounded walk).
    const intersects = (a: DOMRect): boolean => {
      const ox = Math.min(a.right, r.right) - Math.max(a.left, r.left);
      const oy = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
      return ox > 12 && oy > 12;
    };
    const paintedRectIntersects = (root: Element): boolean => {
      if (root === el || el.contains(root) || root.contains(el)) return false;
      if (root.getAttribute('data-design-mode-overlay') === 'true') return false;
      const queue: Element[] = [root];
      let budget = 40;
      while (queue.length && budget-- > 0) {
        const n = queue.shift()!;
        const nr = n.getBoundingClientRect();
        if (nr.width < 2 || nr.height < 2) continue;
        if (paintsVisibly(n)) return intersects(nr);
        queue.push(...Array.from(n.children));
      }
      return false;
    };
    let occluded = false;
    for (const child of Array.from(document.body.children)) {
      // Skip the app root (huge, always paints) — in-app surfaces are handled
      // by the forced-occlusion channel; this sweep is for portaled overlays.
      if (child.contains(el)) continue;
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
      if (paintedRectIntersects(child)) { occluded = true; break; }
    }
    // Fallback point grid for anything exotic that neither portals nor goes
    // through the forced channel.
    if (!occluded) {
      const inset = 6;
      const xs = [r.left + inset, r.left + r.width / 2, r.right - inset];
      const ys = [r.top + inset, r.top + r.height / 2, r.bottom - inset];
      for (const px of xs) {
        for (const py of ys) {
          const top = document.elementsFromPoint(px, py)[0];
          if (top && top !== el && !el.contains(top) && !top.contains(el) && paintsVisibly(top)) {
            occluded = true;
            break;
          }
        }
        if (occluded) break;
      }
    }
    setOccluded(occluded);
  }, [setOccluded]);

  const showOrOpen = useCallback((rect: BrowserViewRect) => {
    lastRect.current = rectKey(rect);
    lastShownNativeBrowserUrl = url;
    if (shownUrl.current === url) {
      void browserViewSetRect(rect);
      void browserViewShow();
    } else {
      shownUrl.current = url;
      void browserViewOpen(url, rect, NATIVE_BROWSER_AGENT_SOURCE);
    }
    scheduleSnapshot();
  }, [scheduleSnapshot, url]);

  /** Open/navigate the native window over the placeholder (only when visible). */
  const openHere = useCallback(() => {
    if (!visibleRef.current || !url) return;
    occludedRef.current = false;
    if (imgRef.current) imgRef.current.style.display = 'none';
    measureZoom();
    const rect = computeRect();
    if (!rect) {
      // Layout not settled yet — retry next frame.
      requestAnimationFrame(() => {
        if (!visibleRef.current || !url) return;
        const retry = computeRect();
        if (!retry) return;
        showOrOpen(retry);
      });
      return;
    }
    showOrOpen(rect);
    // Self-correct a stale open rect. The panel/window layout may not be settled
    // when the tab first opens — especially right after the operator moves the
    // o8 window between displays (mixed scale factors) — so re-measure the zoom +
    // reposition a couple of beats later. syncRect dedupes, so a no-op when the
    // first rect was already correct.
    [160, 500].forEach((delay) => {
      setTimeout(() => {
        if (visibleRef.current && !occludedRef.current) {
          measureZoom();
          syncRect();
        }
      }, delay);
    });
  }, [url, computeRect, measureZoom, showOrOpen, syncRect]);

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
        if (nowVisible) {
          openHere();
        } else {
          // Tab switched away — drop occlusion state so a stale snapshot/hidden
          // flag never carries into the next show.
          occludedRef.current = false;
          if (imgRef.current) imgRef.current.style.display = 'none';
          void browserViewHide();
        }
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
    // A window resize is also where page-zoom changes surface — remeasure the
    // zoom before repositioning. Scroll and panel-divider drags (ResizeObserver)
    // don't change zoom, so they skip it.
    const onResize = () => { measureZoom(); syncRect(); };
    const onScroll = () => syncRect();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    // The o8 UI-zoom (lib/appearance/ui-zoom.ts) sets html.style.zoom, which does
    // NOT fire a window resize — observe the <html> style so the native window
    // tracks a live zoom change instead of drifting until the next reopen.
    const htmlObserver = new MutationObserver(() => { measureZoom(); syncRect(); });
    htmlObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => {
      ro.disconnect();
      htmlObserver.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [syncRect, measureZoom]);

  // Occlusion detection (Stage 5). o8 overlays (⌘K/⌘⇧K palettes, modals, the
  // dictation pill, settings) portal into <body>, so a body childList mutation
  // is the primary trigger; a slow poll is the safety net for overlays that
  // toggle visibility in place. Each check is one elementsFromPoint sweep,
  // rAF-coalesced so a burst of mutations costs at most one probe per frame.
  useEffect(() => {
    if (!isTauri()) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; checkOcclusion(); });
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true });
    const poll = setInterval(schedule, 500);
    return () => {
      mo.disconnect();
      clearInterval(poll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [checkOcclusion]);

  // Native in-page draw mode owns pointer input while the browser stays live.
  // The host arms it for the visible instance, polls the page-owned result sink,
  // captures the live window at submission, then forwards the draw payload.
  useEffect(() => {
    if (!isTauri()) return;
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopDraw = () => {
      if (poll) clearInterval(poll);
      poll = null;
      void fetch('/api/browser/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verb: 'drawmode', args: { on: false } }),
      }).catch(() => {});
    };
    // The composer thumbnail (Cursor parity, preview only — the REAL payload
    // screenshot is still captured fresh at send). The in-page composer can't
    // screenshot itself, so when the page reports a pending drawn region we
    // capture the live window HERE, crop it, and push it back as a data: URI.
    // Deduped by region so we capture once per stroke.
    let deliveredThumbKey = '';
    const pollThumb = () => {
      void fetch('/api/browser/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'drawpending', args: {} }) })
        .then((reply) => reply.text()).then((text) => {
          if (!text || text === 'null') { deliveredThumbKey = ''; return; }
          let pending: { rect?: CropRect; viewport?: { width: number; height: number } } | null = null;
          try { pending = JSON.parse(text); } catch { return; }
          const rect = pending?.rect;
          if (!rect) return;
          const key = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
          if (key === deliveredThumbKey) return;
          deliveredThumbKey = key;
          void browserViewCapture().then((png) => {
            if (!png) return;
            void cropRegionBase64(png, rect, pending?.viewport ?? null, { maxHeight: 88, pad: 8 }).then((cropB64) => {
              if (!cropB64) return;
              void fetch('/api/browser/agent', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ verb: 'drawthumb', args: { dataUri: `data:image/png;base64,${cropB64}` } }),
              }).catch(() => {});
            });
          }).catch(() => {});
        }).catch(() => {});
    };

    const startPolling = () => {
      if (poll) clearInterval(poll);
      deliveredThumbKey = '';
      poll = setInterval(() => {
        void fetch('/api/browser/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'drawresult', args: {} }) })
          .then((reply) => reply.text()).then((text) => {
            if (!text || text === 'null') { pollThumb(); return; }
            let payload: Record<string, unknown> | null = null;
            try { payload = JSON.parse(text) as Record<string, unknown>; } catch { return; }
            // Esc INSIDE the native page (its keydown never reaches this
            // webview) — tear down and exit Design Mode so the brush and
            // the in-page canvas can't desync.
            if (payload?.escaped === true) {
              if (poll) clearInterval(poll); poll = null;
              stopDraw();
              window.dispatchEvent(new CustomEvent('o8:design-mode-request', { detail: { action: 'close' } }));
              return;
            }
            if (!payload?.ok) { pollThumb(); return; }
            if (poll) clearInterval(poll); poll = null;
            void browserViewCapture().then((screenshotBase64) => {
              window.dispatchEvent(new CustomEvent('o8:design-draw-native', { detail: { ...payload, screenshotBase64 } }));
              stopDraw();
            });
          }).catch(() => {});
      }, 350);
    };

    const armDrawMode = () => fetch('/api/browser/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'drawmode', args: { on: true } }),
    }).then((r) => r.json() as Promise<{ ok?: boolean; error?: string }>);

    // True while Design Mode is armed — the recreate/arm retry loop below
    // must stop the moment the operator toggles the mode off.
    let designArmed = false;

    const onDesignMode = (event: Event) => {
      const active = (event as CustomEvent<{ active?: boolean }>).detail?.active === true;
      if (!active) {
        designArmed = false;
        stopDraw();
        return;
      }
      // Design Mode on: only the VISIBLE instance arms. O8Panel mounts
      // NativeBrowserSurface TWICE (main + utility shell); a hidden instance must
      // do NOTHING here (they drive one shared browser-view).
      if (!visibleRef.current) return;
      designArmed = true;
      void armDrawMode().then(async (resp) => {
        if (!designArmed) return;
        if (resp?.ok) { startPolling(); return; }
        if (!String(resp?.error ?? '').includes('not installed')) return;
        // The agent source injects at WINDOW CREATION, so a window that
        // predates the draw layer (or any code update — page CSP blocks
        // eval-based re-injection) can never learn drawmode in place.
        // RECREATE it. Ordering matters (live-hit 2026-07-12 ×2): window
        // destruction is ASYNC — an immediate reopen finds the dying window
        // still registered and takes Rust's "exists → navigate" path, which
        // never registers the init script. Settle after close, reopen with
        // the CURRENT source, then poll-arm until the fresh page answers.
        const rect = computeRect();
        if (!rect) return;
        await browserViewClose();
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        if (!designArmed) return;
        lastRect.current = '';
        await browserViewOpen(url, rect, NATIVE_BROWSER_AGENT_SOURCE);
        let attempts = 0;
        const tryArm = () => {
          if (!designArmed) return;
          void armDrawMode().then((retry) => {
            if (!designArmed) return;
            if (retry?.ok) { startPolling(); return; }
            attempts += 1;
            if (attempts < 24) window.setTimeout(tryArm, 500);
          }).catch(() => {
            attempts += 1;
            if (designArmed && attempts < 24) window.setTimeout(tryArm, 500);
          });
        };
        window.setTimeout(tryArm, 800);
      }).catch(() => {});
    };
    window.addEventListener('o8:design-mode', onDesignMode);
    return () => {
      designArmed = false;
      window.removeEventListener('o8:design-mode', onDesignMode);
      if (poll) clearInterval(poll);
    };
  }, [computeRect, url]);

  // Dashboard-forced occlusion: the Design Mode grab result card opens over the
  // native window (an always-on-top OS window), so the dashboard signals us to
  // hide it while the card is open + restore on close. The geometric sampler can't
  // see a card that only covers the bottom of the rect, so this is explicit. Only
  // the VISIBLE instance acts (dual-mount — a hidden one hiding the shared window
  // would be wrong).
  useEffect(() => {
    const onForceOcclude = (event: Event) => {
      if (!visibleRef.current) return;
      const occlude = (event as CustomEvent<{ occlude?: boolean }>).detail?.occlude === true;
      forceOccludeRef.current = occlude;
      setOccluded(occlude);
    };
    window.addEventListener('o8:native-browser-occlude', onForceOcclude);
    return () => window.removeEventListener('o8:native-browser-occlude', onForceOcclude);
  }, [setOccluded]);

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
        position: 'relative',
        width: '100%',
        height: '100%',
        background: 'transparent',
        boxShadow: agentGlow ? 'inset 0 0 0 1.5px rgba(245,158,11,0.75)' : 'none',
        transition: 'box-shadow 200ms ease-out',
      }}
    >
      {/* Occlusion snapshot — the page's last frame, painted while the native
          window is hidden for an overlay so the area never goes blank.
          pointer-events:none keeps it transparent to the elementsFromPoint probe
          and to the human's pointer. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- transient base64
          snapshot data-URL, not a remote/LCP image; next/image can't optimize it. */}
      <img
        ref={imgRef}
        alt=""
        aria-hidden="true"
        style={{
          display: 'none',
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'fill',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
