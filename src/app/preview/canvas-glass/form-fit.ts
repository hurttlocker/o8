/**
 * Form-fit grid engine (#1239 — the canvas "hard placement" mode). Packs every
 * card into a grid that FILLS the usable viewport: cards snap to slots and
 * RESIZE (w + h) to fit — form-fit packing (vs free-flow,
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
  tree: 63,
  image: 28,
  browser: 92,
  chat: 63,
  diff: 36,
  // The o8.md card uses the default pill header (SHELL_CHROME_H = 63 in
  // card-shell.tsx), not the 44 an earlier estimate assumed. This is only the
  // FALLBACK — the live pack measures real chrome — but an undercount here made
  // the fallback body too tall (chrome + body > slot) and reintroduced the
  // exact overlap this file guards against.
  spec: 63,
  brain: 92,
};

/** Body height a grid card WANTS at rest — guaranteed by the row-height floor
 *  (GRID_MIN_ROW_H below) whenever the viewport has room, NOT re-applied after
 *  the pack. It is never used to floor a card ABOVE its slot: doing that (the
 *  old behaviour) is exactly what let a short-slot card — worst on the
 *  tall-chrome o8.md spec card — paint past its cell and overlap its neighbours
 *  when the viewport shrank and rows scaled down. In grid mode a card takes an
 *  undersized, scrolling body before it is ever allowed to overflow its slot. */
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
  tree: 1.08,
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

/** Row-height floor (canvas px). The packer fills the area's HEIGHT (rows split
 *  it evenly), so there is no fixed max — a light load in a big area gets tall
 *  rows on purpose ("see the most stuff"). The floor keeps a dense wall of cards
 *  from slivering below a readable height; if honoring it would overflow, the
 *  block scales back down to fit (see computeGrid). The old fixed GRID_MAX_ROW_H
 *  (300) was the bug: it capped row height so a light load never closed a row →
 *  one short band centered in a huge area, dead space above and below. */
export const GRID_MIN_ROW_H = 160;

const aspectOf = (kind: string): number => KIND_ASPECT[kind] ?? DEFAULT_ASPECT;

/** Cap on how far a SHORT row's tiles stretch past their natural width before we
 *  stop justifying and center them instead — so a 2-tile final row doesn't
 *  balloon to fill a wide area. Mirrors the old final-row height cap. */
const FINAL_ROW_STRETCH_CAP = 1.12;

/** Grid slots (TOTAL rects) for items in their given order, packed to FILL both
 *  axes of `area`. The optimal ROW COUNT is derived from the area's aspect first
 *  (r ≈ √(N·A·H / W) for N tiles of average aspect A), items split into that many
 *  balanced rows in reading order (6 → 3+3, 7 → 4+3, never 5+1), each row given an
 *  equal share of the height and its tiles justified across the width by kind
 *  aspect (a wide terminal beside a narrow agent on a shared row height). Because
 *  row height comes from the AREA (not a fixed cap), a light load in a big area
 *  gets tall rows that fill the viewport instead of one short centered band; a
 *  taller area yields taller rows. Pure + deterministic: same items + area + gap →
 *  same slots. */
export function computeGrid(items: GridItem[], area: Slot, gap = DEFAULT_GAP): Map<number, Slot> {
  const slots = new Map<number, Slot>();
  const n = items.length;
  if (n === 0 || area.w <= 0 || area.h <= 0) return slots;

  // Optimal row count: r rows of N/r tiles at average aspect A tiling W×H solves
  // to r ≈ √(N·A·H / W). Clamp to [1, n]. Deriving the COUNT from the area's
  // aspect (rather than capping row height at a fixed 300) is the fill fix.
  const avgAspect = items.reduce((s, it) => s + aspectOf(it.kind), 0) / n;
  const r = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * avgAspect * area.h) / area.w))));

  // Balanced distribution into r rows, reading order preserved: the first `rem`
  // rows carry one extra tile, so rows never differ by more than one — no lone
  // card stranded under a full row.
  const base = Math.floor(n / r);
  const rem = n % r;
  const rows: GridItem[][] = [];
  let idx = 0;
  for (let ri = 0; ri < r; ri += 1) {
    const len = base + (ri < rem ? 1 : 0);
    rows.push(items.slice(idx, idx + len));
    idx += len;
  }

  // Row height fills the area height (floor at GRID_MIN_ROW_H); if honoring the
  // floor would overflow, scale the block back down so it still fits exactly.
  const gapsTotal = gap * (r - 1);
  const rowHClamped = Math.max(GRID_MIN_ROW_H, Math.min(area.h, (area.h - gapsTotal) / r));
  const rowsTotal = rowHClamped * r;
  const avail = Math.max(0, area.h - gapsTotal);
  const vScale = rowsTotal > avail && rowsTotal > 0 ? avail / rowsTotal : 1;
  const rowH = rowHClamped * vScale;

  // Center the packed block vertically — a full grid lands flush at the top
  // (blockH === area.h); the clamp only leaves a margin for a sparse tall stack.
  const blockH = rowH * r + gapsTotal;
  let y = area.y + Math.max(0, (area.h - blockH) / 2);

  rows.forEach((row) => {
    const sa = row.reduce((s, it) => s + aspectOf(it.kind), 0);
    const innerW = area.w - gap * (row.length - 1);
    const naturalW = sa * rowH;
    // Justify tile widths to fill the row (shared row height, kind-aspect widths).
    // Shrink freely if the row is naturally too wide; cap the STRETCH of a short
    // row so it centers at ~natural width instead of ballooning across the area.
    const scale = Math.min(FINAL_ROW_STRETCH_CAP, innerW / naturalW);
    const widths = row.map((it) => aspectOf(it.kind) * rowH * scale);
    const rowW = widths.reduce((s, w) => s + w, 0) + gap * (row.length - 1);
    // Full rows fill the width (flush); a capped/narrower row centers.
    let x = area.x + Math.max(0, (area.w - rowW) / 2);
    row.forEach((it, ci) => {
      slots.set(it.id, { x, y, w: widths[ci], h: rowH });
      x += widths[ci] + gap;
    });
    y += rowH + gap;
  });

  return slots;
}

/** Convert a TOTAL slot rect into the geometry a card array stores: full width,
 *  body height (chrome subtracted), positioned at the slot origin. `chromeOverride`
 *  is a measured chrome height (preferred over the per-kind estimate) so the
 *  card's TOTAL height matches the slot exactly — no overlap, symmetric rows.
 *
 *  The body is ALWAYS `slot.h − chrome` (floored only at 0 so it never goes
 *  negative). It is deliberately NOT floored at a fixed minimum: a body min
 *  bigger than `slot.h − chrome` would make `chrome + body` exceed the slot, so
 *  the card would paint past its cell and overlap the disjoint slots above and
 *  below it. That was the grid-mode overlap bug — worst on the o8.md spec card,
 *  whose header is the tallest chrome — which surfaced whenever the viewport
 *  shrank and computeGrid's vScale pushed rows below chrome + the old floor. The
 *  usable-body minimum is instead honoured up-front by GRID_MIN_ROW_H (the row
 *  never floors shorter than a readable card unless the whole block must scale
 *  to fit); once it does scale, cards shrink WITH their slots and stay disjoint. */
export function slotToCardGeom(slot: Slot, kind: string, chromeOverride?: number): Slot {
  const chrome = chromeOverride ?? CARD_CHROME[kind] ?? 40;
  return {
    x: Math.round(slot.x),
    y: Math.round(slot.y),
    w: Math.round(slot.w),
    h: Math.max(0, Math.round(slot.h - chrome)),
  };
}
