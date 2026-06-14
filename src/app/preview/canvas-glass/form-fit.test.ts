import { describe, it, expect } from 'vitest';
import { columnsFor, computeGrid, slotToCardGeom, CARD_CHROME, GRID_MIN_BODY_H } from './form-fit';

const AREA = { x: 100, y: 80, w: 1400, h: 800 };

describe('form-fit columnsFor', () => {
  it('packs 6 cards into 3 columns (3x2, like the reference)', () => {
    expect(columnsFor(6, AREA.w, AREA.h)).toBe(3);
  });

  it('1 card is a single column', () => {
    expect(columnsFor(1, AREA.w, AREA.h)).toBe(1);
  });

  it('a very wide area uses more columns than a square one for the same count', () => {
    const wide = columnsFor(8, 2400, 600);
    const squareish = columnsFor(8, 900, 900);
    expect(wide).toBeGreaterThan(squareish);
  });
});

describe('form-fit computeGrid', () => {
  it('returns a slot per item', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: i, kind: 'image' }));
    const slots = computeGrid(items, AREA);
    expect(slots.size).toBe(6);
  });

  it('every slot stays inside the usable area', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: i, kind: 'term' }));
    const slots = computeGrid(items, AREA);
    for (const s of slots.values()) {
      expect(s.x).toBeGreaterThanOrEqual(AREA.x - 0.5);
      expect(s.y).toBeGreaterThanOrEqual(AREA.y - 0.5);
      expect(s.x + s.w).toBeLessThanOrEqual(AREA.x + AREA.w + 0.5);
      expect(s.y + s.h).toBeLessThanOrEqual(AREA.y + AREA.h + 0.5);
    }
  });

  it('cells are uniform in size (form-fit resizes every card the same)', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: i, kind: 'image' }));
    const slots = [...computeGrid(items, AREA).values()];
    const w0 = slots[0].w;
    const h0 = slots[0].h;
    for (const s of slots) {
      expect(s.w).toBeCloseTo(w0, 3);
      expect(s.h).toBeCloseTo(h0, 3);
    }
  });

  it('rows do not vertically overlap', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: i, kind: 'image' }));
    const slots = [...computeGrid(items, AREA).values()].sort((a, b) => a.y - b.y || a.x - b.x);
    // 3 cols → row 0 is the first 3, row 1 the next 3; row 1 starts below row 0's bottom.
    expect(slots[3].y).toBeGreaterThanOrEqual(slots[0].y + slots[0].h - 0.5);
  });

  it('centers a short last row', () => {
    // 3 items, 2 cols → row 0 has 2, row 1 has 1 centered.
    const items = Array.from({ length: 3 }, (_, i) => ({ id: i, kind: 'image' }));
    const slots = computeGrid(items, { x: 0, y: 0, w: 1000, h: 800 });
    const last = slots.get(2)!;
    const center = last.x + last.w / 2;
    expect(center).toBeCloseTo(500, 0); // mid of a 1000-wide area
  });

  it('empty or degenerate area yields no slots', () => {
    expect(computeGrid([], AREA).size).toBe(0);
    expect(computeGrid([{ id: 1, kind: 'term' }], { x: 0, y: 0, w: 0, h: 0 }).size).toBe(0);
  });
});

describe('form-fit slotToCardGeom', () => {
  it('subtracts per-kind chrome to get the body height', () => {
    const geom = slotToCardGeom({ x: 10, y: 20, w: 300, h: 400 }, 'browser');
    expect(geom.h).toBe(400 - CARD_CHROME.browser);
    expect(geom.w).toBe(300);
    expect(geom.x).toBe(10);
  });

  it('clamps body height to the floor', () => {
    const geom = slotToCardGeom({ x: 0, y: 0, w: 200, h: 50 }, 'chat');
    expect(geom.h).toBe(GRID_MIN_BODY_H);
  });

  it('falls back to a default chrome for unknown kinds', () => {
    const geom = slotToCardGeom({ x: 0, y: 0, w: 200, h: 400 }, 'mystery');
    expect(geom.h).toBe(400 - 40);
  });
});
