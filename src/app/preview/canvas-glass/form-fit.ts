/**
 * Form-fit grid engine (#1239 — the canvas "hard placement" mode). Packs every
 * card into a grid that FILLS the usable viewport: cards snap to slots and
 * RESIZE (w + h) to fit, the way the MaxBlade reference does (vs free-flow,
 * where cards keep their size + position). Pure geometry — page.tsx owns the
 * card state and the animated writeback.
 */

export interface GridItem {
  id: number;
  kind: string;
}
export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Chrome height per kind = total card height − the stored body `h`. The grid
 *  computes TOTAL slot rects; the writeback subtracts this to get the body `h`
 *  each card array stores. Mirrors the spawn-collision offsets in page.tsx
 *  (term/file/diff +36, image +28, browser/brain +92) with real values filled
 *  in for the chrome-bearing kinds the collision table approximated at 0. */
export const CARD_CHROME: Record<string, number> = {
  term: 36,
  file: 36,
  image: 28,
  browser: 92,
  chat: 63,
  diff: 36,
  spec: 44,
  brain: 92,
};

/** Min body height a card can shrink to before the grid stops compressing it. */
export const GRID_MIN_BODY_H = 96;

/** Default gap (canvas px) between cells. Callers pass a zoom-aware value so the
 *  gap reads the same on screen at any zoom (a fixed canvas gap shrinks visually
 *  when zoomed out). */
export const DEFAULT_GAP = 24;
const TARGET_CELL_ASPECT = 4 / 3; // preferred cell w/h — keeps cells card-shaped

/** Column count whose resulting cells sit closest to TARGET_CELL_ASPECT for this
 *  item count + area shape (so 6 cards in a wide area land as 3×2, like the
 *  reference, not 6×1 or 1×6). */
export function columnsFor(count: number, areaW: number, areaH: number, gap = DEFAULT_GAP): number {
  if (count <= 1) return 1;
  let best = 1;
  let bestScore = Infinity;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cellW = (areaW - gap * (cols - 1)) / cols;
    const cellH = (areaH - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const score = Math.abs(cellW / cellH - TARGET_CELL_ASPECT);
    if (score < bestScore) {
      bestScore = score;
      best = cols;
    }
  }
  return best;
}

/** Grid slots (TOTAL rects) for items in their given order, filling `area`. A
 *  short final row is centered so the grid reads balanced. */
export function computeGrid(items: GridItem[], area: Slot, gap = DEFAULT_GAP): Map<number, Slot> {
  const slots = new Map<number, Slot>();
  const n = items.length;
  if (n === 0 || area.w <= 0 || area.h <= 0) return slots;
  const cols = columnsFor(n, area.w, area.h, gap);
  const rows = Math.ceil(n / cols);
  const cellW = (area.w - gap * (cols - 1)) / cols;
  const cellH = (area.h - gap * (rows - 1)) / rows;
  items.forEach((item, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = Math.min(cols, n - row * cols);
    // Center a short last row; full rows start flush left (offset 0).
    const rowOffset = (area.w - (inRow * cellW + gap * (inRow - 1))) / 2;
    const x = area.x + (inRow < cols ? rowOffset : 0) + col * (cellW + gap);
    const y = area.y + row * (cellH + gap);
    slots.set(item.id, { x, y, w: cellW, h: cellH });
  });
  return slots;
}

/** Convert a TOTAL slot rect into the geometry a card array stores: full width,
 *  body height (chrome subtracted), positioned at the slot origin. `chromeOverride`
 *  is a measured chrome height (preferred over the per-kind estimate) so the
 *  card's TOTAL height matches the slot exactly — no overlap, symmetric rows. */
export function slotToCardGeom(slot: Slot, kind: string, chromeOverride?: number): Slot {
  const chrome = chromeOverride ?? CARD_CHROME[kind] ?? 40;
  return {
    x: slot.x,
    y: slot.y,
    w: Math.round(slot.w),
    h: Math.max(GRID_MIN_BODY_H, Math.round(slot.h - chrome)),
  };
}
