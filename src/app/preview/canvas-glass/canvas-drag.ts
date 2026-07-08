/**
 * Canvas drag boundary resistance (#1232 design-eng tip — "drag resistance near
 * boundaries"). Cards used to fling off-screen or bury under the chrome; this
 * gives every floating-card drag SOFT WALLS at the usable workspace edges (left
 * spawn rail, right dock, bottom composer, top bar): the card rubber-bands a few
 * px past, then springs back in-bounds on release.
 *
 * Why a manual helper and NOT framer's `drag`/`dragConstraints`: the card layer
 * carries a CSS `zoom` (--cnv-zoom), and framer maps pointer deltas → transform
 * in UNzoomed space — the same mismatch the manual handlers already divide out
 * with canvasZoom(). So resistance lives where the zoom math already does.
 *
 * Coordinate space: the card layer is `inset: 0` + `zoom` (no pan), so a card at
 * canvas (x, y) paints on screen at (x·zoom, y·zoom). Chrome is fixed screen px,
 * so each inset converts to canvas space by ÷ zoom.
 */
import { animate, type AnimationPlaybackControls } from 'framer-motion';
import { canvasZoom } from './ui';

/** Chrome insets in SCREEN px — the workspace region clear of fixed chrome.
 *  Side chrome (left rail / right dock) is full-height; the top bar + composer
 *  are centered pills, so a uniform box is a hair conservative at the top/bottom
 *  corners — which keeps cards in the comfortable central field. */
// Symmetric side clearance: the ProximityDock spawn rail's glyphs end at ~57px,
// so 64 clears them — and using the SAME inset on both sides centers the grid
// when the dock is closed (was 96 left / 32 right, which read off-center). When
// the dock is open it replaces the right inset (real chrome, asymmetry is right).
const INSET_SIDE = 64;
const INSET_TOP = 70; // top control pill (top:18 + height:40, + margin)
const INSET_BOTTOM = 88; // bottom composer (bottom:24 + ~56 tall, + margin) — the FLOOR

/** Rubber-band stiffness past a wall — the card follows at 8% of the overdrag
 *  (drag 100px past → 8px past), so the edge reads as a soft wall, not a cliff.
 *  Matches the design-eng tip's dragElastic={0.08}. */
const ELASTIC = 0.08;

export interface DragBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Reserve (screen px) the right dock eats — stamped on documentElement by the
 *  page like --cnv-zoom (0 when the dock is closed). Source: dock.tsx right:24 +
 *  width:400 = 424. */
function readDockReserve(): number {
  if (typeof document === 'undefined') return 0;
  const raw = Number.parseFloat(document.documentElement.style.getPropertyValue('--cnv-dock-reserve'));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Reserve (screen px) the bottom chrome STACK eats — the composer plus the
 *  DispatchDock agents tray that grows above it (and taller again when the tray
 *  is expanded). Measured live off `[data-canvas-bottom-stack]` elements (the
 *  composer + the tray column) so the grid ends above the real rendered stack in
 *  BOTH tray states — same spirit as layoutGrid's `chromeOf` offsetHeight probe.
 *  Reserve = distance from the viewport bottom to the TOPMOST stack element +
 *  a small margin, floored at INSET_BOTTOM so it never under-clears the composer
 *  (and so a pre-hydration / unmounted stack falls back to the old constant). */
function readBottomStackReserve(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') return INSET_BOTTOM;
  let top = Infinity;
  document.querySelectorAll('[data-canvas-bottom-stack]').forEach((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    // Skip collapsed nodes (the tray wrapper is mounted but zero-height while no
    // lane is dispatching) so an empty wrapper never inflates the reserve.
    if (r.width < 1 || r.height < 1) return;
    if (r.top < top) top = r.top;
  });
  if (!Number.isFinite(top)) return INSET_BOTTOM;
  const MARGIN = 12; // breathing room between the grid's last row and the stack
  return Math.max(INSET_BOTTOM, window.innerHeight - top + MARGIN);
}

/** Grid mode keeps the viewport fence; free mode is the infinite canvas. */
function readGridMode(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.style.getPropertyValue('--cnv-grid') === '1';
}

/** Allowed box for a card's ORIGIN (top-left) in canvas px. In FREE mode this is
 *  effectively unbounded — the infinite canvas, where cards roam the plane and
 *  the navigator ball is how you find them. In GRID mode it fences to the usable
 *  viewport so a reorder drag stays sane. */
export function dragBounds(cardW: number, cardH: number): DragBounds {
  if (!readGridMode()) {
    return { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };
  }
  const zoom = canvasZoom();
  const vw = typeof window === 'undefined' ? 1600 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
  const dockReserve = readDockReserve();
  const right = dockReserve > 0 ? dockReserve : INSET_SIDE;
  const minX = INSET_SIDE / zoom;
  const minY = INSET_TOP / zoom;
  let maxX = (vw - right) / zoom - cardW;
  let maxY = (vh - INSET_BOTTOM) / zoom - cardH;
  // Card wider/taller than the usable field → pin to the near edge rather than
  // invert the box (an inverted box would resist toward the chrome).
  if (maxX < minX) maxX = minX;
  if (maxY < minY) maxY = minY;
  return { minX, minY, maxX, maxY };
}

/** The usable workspace as a rect in CANVAS px (the same box dragBounds fences
 *  to, but expressed as origin + size). The form-fit grid packs into this. */
export function usableCanvasArea(): { x: number; y: number; w: number; h: number } {
  const zoom = canvasZoom();
  const vw = typeof window === 'undefined' ? 1600 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
  const dockReserve = readDockReserve();
  const right = dockReserve > 0 ? dockReserve : INSET_SIDE;
  const bottom = readBottomStackReserve();
  return {
    x: INSET_SIDE / zoom,
    y: INSET_TOP / zoom,
    w: Math.max(0, vw - right - INSET_SIDE) / zoom,
    h: Math.max(0, vh - bottom - INSET_TOP) / zoom,
  };
}

let reduceMotion: boolean | null = null;
function prefersReducedMotion(): boolean {
  if (reduceMotion !== null) return reduceMotion;
  reduceMotion =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
  return reduceMotion;
}

/** One axis of rubber-band: 1:1 inside [min, max], 8% follow past either wall.
 *  Under prefers-reduced-motion the wall is hard (clamp, no give). */
export function resistAxis(v: number, min: number, max: number): number {
  if (prefersReducedMotion()) return Math.min(Math.max(v, min), max);
  if (v < min) return min - (min - v) * ELASTIC;
  if (v > max) return max + (v - max) * ELASTIC;
  return v;
}

/** On release, spring the card from its (slightly-past) position back to the
 *  nearest in-bounds rest. No-op (returns null) when already in-bounds. Under
 *  prefers-reduced-motion it hard-snaps in one onMove. Returns the animation so
 *  the caller can `.stop()` it if the card is re-grabbed mid-settle. */
export function settleInBounds(
  x: number,
  y: number,
  bounds: DragBounds,
  onMove: (x: number, y: number) => void,
): AnimationPlaybackControls | null {
  const restX = Math.min(Math.max(x, bounds.minX), bounds.maxX);
  const restY = Math.min(Math.max(y, bounds.minY), bounds.maxY);
  if (restX === x && restY === y) return null;
  if (prefersReducedMotion()) {
    onMove(restX, restY);
    return null;
  }
  return animate(0, 1, {
    type: 'spring',
    stiffness: 700,
    damping: 42,
    restDelta: 0.5,
    onUpdate: (t) => onMove(x + (restX - x) * t, y + (restY - y) * t),
  });
}
