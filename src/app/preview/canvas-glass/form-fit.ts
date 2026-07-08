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
const TARGET_CELL_ASPECT = 1.6; // preferred cell w/h — cards read landscape
/** How hard a partial last row is penalized. Balance is the OCD priority: a lone
 *  card centered under a full row (6 → 5+1) reads broken. This weight makes the
 *  packer prefer a FULL grid (6 → 3×2) over a perfect-aspect lopsided one, while
 *  still letting aspect break ties between balanced options (3×2 vs 6×1). */
const BALANCE_WEIGHT = 0.7;

/** Column count for `count` cards in an area. Balance-first: minimize the holes
 *  in the last row (so 6 → 3×2, never 5+1), then tie-break toward landscape
 *  cells. Tuned so composites land as clean rectangles and the cells stay
 *  card-shaped rather than slivers. */
export function columnsFor(count: number, areaW: number, areaH: number, gap = DEFAULT_GAP): number {
  if (count <= 1) return 1;
  let best = 1;
  let bestScore = Infinity;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cellW = (areaW - gap * (cols - 1)) / cols;
    const cellH = (areaH - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const holes = cols * rows - count; // empty cells in the last row
    const aspectDev = Math.abs(cellW / cellH - TARGET_CELL_ASPECT);
    const score = holes * BALANCE_WEIGHT + aspectDev;
    if (score < bestScore) {
      bestScore = score;
      best = cols;
    }
  }
  return best;
}

/** Per-kind target aspect (w / h) for grid tiles. Terminals, files, browsers and
 *  diffs read landscape and want width; chat / brain / markdown carry a column of
 *  text and read tall. The justified packer sizes each tile to its kind's aspect,
 *  so a terminal lands WIDER than an agent tile sharing its row — the grid stops
 *  squaring every card to one cell (the "funny looking" equal-size pack). */
export const KIND_ASPECT: Record<string, number> = {
  term: 1.62,
  file: 1.5,
  diff: 1.46,
  browser: 1.5,
  spec: 1.42,
  image: 1.4,
  video: 1.5,
  agent: 1.3,
  packet: 1.32,
  chat: 1.08,
  brain: 0.96,
  markdown: 0.98,
};
export const DEFAULT_ASPECT = 1.4;

/** Row-height band (canvas px). The packer aims for a card-shaped row height
 *  given the count + area, then clamps here so a couple of cards don't balloon
 *  and a wall of them doesn't sliver. */
export const GRID_MIN_ROW_H = 160;
export const GRID_MAX_ROW_H = 300;

const aspectOf = (kind: string): number => KIND_ASPECT[kind] ?? DEFAULT_ASPECT;

/** Grid slots (TOTAL rects) for items in their given order, packed as JUSTIFIED
 *  ROWS that fill `area` width and CENTER in `area` height. Each tile takes its
 *  kind's aspect, so a row mixes widths (wide terminal, narrow agent) on a shared
 *  row height — one `gap` gutter everywhere, aligned row bands, no ragged
 *  near-misses. A short final row keeps the target height (never stretches a lone
 *  tile giant) and centers. Pure + deterministic: same items + area + gap → same
 *  slots. */
export function computeGrid(items: GridItem[], area: Slot, gap = DEFAULT_GAP): Map<number, Slot> {
  const slots = new Map<number, Slot>();
  const n = items.length;
  if (n === 0 || area.w <= 0 || area.h <= 0) return slots;

  // Target row height: N tiles of average aspect A tiling W×H → h ≈ √(W·H / (N·A)).
  const avgAspect = items.reduce((s, it) => s + aspectOf(it.kind), 0) / n;
  const ideal = Math.sqrt((area.w * area.h) / (n * avgAspect));
  const targetRowH = Math.max(GRID_MIN_ROW_H, Math.min(GRID_MAX_ROW_H, ideal));

  // Greedy justified rows: grow a row until its natural width (tiles at
  // targetRowH + gutters) reaches the area width, then close it.
  const rows: GridItem[][] = [];
  let row: GridItem[] = [];
  let sumAspect = 0;
  for (let i = 0; i < n; i += 1) {
    row.push(items[i]);
    sumAspect += aspectOf(items[i].kind);
    if (sumAspect * targetRowH + gap * (row.length - 1) >= area.w) {
      rows.push(row);
      row = [];
      sumAspect = 0;
    }
  }
  if (row.length) rows.push(row);

  // Height per row: justify so its tiles fill the width. A short FINAL row keeps
  // the target height (a lone last tile never blows up) and centers instead.
  const rowHeights = rows.map((r, ri) => {
    const sa = r.reduce((s, it) => s + aspectOf(it.kind), 0);
    const justified = (area.w - gap * (r.length - 1)) / sa;
    const isLast = ri === rows.length - 1;
    if (isLast && justified > targetRowH * 1.12) return targetRowH;
    return Math.max(GRID_MIN_ROW_H, Math.min(GRID_MAX_ROW_H, justified));
  });

  // Center the packed block vertically; scale ROW HEIGHTS (not the fixed gutters)
  // to fit if it would overflow, so the block lands exactly inside the height.
  const rowsTotal = rowHeights.reduce((s, h) => s + h, 0);
  const gapsTotal = gap * (rows.length - 1);
  const avail = Math.max(0, area.h - gapsTotal);
  const vScale = rowsTotal > avail && rowsTotal > 0 ? avail / rowsTotal : 1;
  const blockH = rowsTotal * vScale + gapsTotal;
  let y = area.y + Math.max(0, (area.h - blockH) / 2);

  rows.forEach((r, ri) => {
    let h = rowHeights[ri] * vScale;
    let widths = r.map((it) => aspectOf(it.kind) * h);
    let rowW = widths.reduce((s, w) => s + w, 0) + gap * (r.length - 1);
    // Never let a row exceed the width — re-justify its height down if it would.
    if (rowW > area.w) {
      const inner = area.w - gap * (r.length - 1);
      const fit = inner / (rowW - gap * (r.length - 1));
      h *= fit;
      widths = widths.map((w) => w * fit);
      rowW = area.w;
    }
    // Full rows fill the width (start flush); a capped/narrower row centers.
    let x = area.x + Math.max(0, (area.w - rowW) / 2);
    r.forEach((it, ci) => {
      slots.set(it.id, { x, y, w: widths[ci], h });
      x += widths[ci] + gap;
    });
    y += h + gap;
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
    x: Math.round(slot.x),
    y: Math.round(slot.y),
    w: Math.round(slot.w),
    h: Math.max(GRID_MIN_BODY_H, Math.round(slot.h - chrome)),
  };
}
