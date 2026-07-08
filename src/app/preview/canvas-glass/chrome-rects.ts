/**
 * ONE registry of on-screen floating chrome, expressed in CANVAS px so the
 * placement code (findFreeSpot + the form-fit grid packer) can treat chrome as
 * occupied space — new cards never spawn under it, grid tiles never pack under
 * it.
 *
 * Coordinate space: chrome is FIXED screen-space; cards live under the canvas
 * layer's `zoom` + `translate(pan)`. A card at canvas (x, y) paints on screen at
 * (x·zoom + pan.x, y·zoom + pan.y) — the exact mapping `canvasViewport()` uses in
 * page.tsx (screen 0,0,w,h → canvas via (screen − pan) / zoom). Inverting a
 * screen rect back to canvas is therefore `(left − pan) / zoom, (top − pan) /
 * zoom, width / zoom, height / zoom`. Chrome sits at device 1:1 OUTSIDE the zoom
 * layer, so its `getBoundingClientRect()` is true screen px and converts cleanly.
 *
 * Sources:
 *  - every element tagged `[data-canvas-chrome]` (bottom composer, dispatch dock,
 *    review / sessions / terminal pickers) — measured live so the rect tracks the
 *    element's real state (open/closed, with/without image pills, list length);
 *  - the right orchestrator dock, synthesized from `--cnv-dock-reserve` (the dock
 *    is a shared component we don't tag; the page already stamps its reserve).
 * The left spawn rail + top control pill are already cleared by the placement
 * insets (findFreeSpot's minX / usableCanvasArea's INSET_*), so they aren't
 * re-listed here.
 */
import { canvasZoom } from './ui';

export interface ChromeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Measured floating-chrome rects in CANVAS px (see module header). `pan` is the
 *  live screen-px canvas offset; `zoom` defaults to the stamped `--cnv-zoom`. */
export function chromeRectsCanvas(pan: { x: number; y: number }, zoom = canvasZoom()): ChromeRect[] {
  if (typeof document === 'undefined') return [];
  const z = zoom > 0 ? zoom : 1;
  const toCanvas = (left: number, top: number, width: number, height: number): ChromeRect => ({
    x: (left - pan.x) / z,
    y: (top - pan.y) / z,
    w: width / z,
    h: height / z,
  });

  const rects: ChromeRect[] = [];
  document.querySelectorAll('[data-canvas-chrome]').forEach((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    // Skip collapsed nodes — the dispatch-dock wrapper is always mounted but
    // zero-height while no lane is dispatching.
    if (r.width < 1 || r.height < 1) return;
    rects.push(toCanvas(r.left, r.top, r.width, r.height));
  });

  // Right orchestrator dock — reserve stamped on documentElement (0 when closed).
  const reserve = Number.parseFloat(document.documentElement.style.getPropertyValue('--cnv-dock-reserve'));
  if (Number.isFinite(reserve) && reserve > 0 && typeof window !== 'undefined') {
    rects.push(toCanvas(window.innerWidth - reserve, 0, reserve, window.innerHeight));
  }
  return rects;
}

/** Largest chrome-free sub-rect of `area` (canvas px): guillotine-trim each
 *  overlapping chrome rect off whichever side of `area` keeps the most room. Used
 *  to keep grid tiling clear of a floating panel (e.g. the review picker) that
 *  the static insets don't cover. Deterministic; returns `area` untouched when
 *  nothing overlaps or the chrome engulfs it. */
export function carveChrome(area: ChromeRect, chrome: ChromeRect[]): ChromeRect {
  let a: ChromeRect = { ...area };
  for (const c of chrome) {
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;
    const cx2 = c.x + c.w;
    const cy2 = c.y + c.h;
    const ix = Math.max(a.x, c.x);
    const iy = Math.max(a.y, c.y);
    const ix2 = Math.min(ax2, cx2);
    const iy2 = Math.min(ay2, cy2);
    if (ix2 <= ix || iy2 <= iy) continue; // no overlap
    const candidates: ChromeRect[] = [
      { x: a.x, y: a.y, w: c.x - a.x, h: a.h }, // keep the band LEFT of the chrome
      { x: cx2, y: a.y, w: ax2 - cx2, h: a.h }, // keep the band RIGHT of the chrome
      { x: a.x, y: a.y, w: a.w, h: c.y - a.y }, // keep the band ABOVE the chrome
      { x: a.x, y: cy2, w: a.w, h: ay2 - cy2 }, // keep the band BELOW the chrome
    ].filter((r) => r.w > 80 && r.h > 80);
    if (candidates.length === 0) continue; // chrome swallows the area — leave it
    a = candidates.reduce((best, r) => (r.w * r.h > best.w * best.h ? r : best));
  }
  return a;
}
