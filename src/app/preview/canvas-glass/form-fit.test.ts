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

describe('form-fit computeGrid (justified rows)', () => {
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

  it('respects per-kind aspect — a landscape tile is wider than a tall one at equal height', () => {
    // Two cards land in one row → shared row height, widths by kind aspect.
    const slots = computeGrid([{ id: 0, kind: 'term' }, { id: 1, kind: 'brain' }], AREA);
    const term = slots.get(0)!;
    const brain = slots.get(1)!;
    expect(term.h).toBeCloseTo(brain.h, 3); // same row → same height
    expect(term.w).toBeGreaterThan(brain.w); // term reads landscape, brain tall
  });

  it('uses one consistent gutter between tiles in a row', () => {
    const slots = computeGrid([{ id: 0, kind: 'term' }, { id: 1, kind: 'brain' }], AREA, 24);
    const a = slots.get(0)!;
    const b = slots.get(1)!;
    expect(b.x - (a.x + a.w)).toBeCloseTo(24, 3);
  });

  it('no two tiles overlap', () => {
    const kinds = ['term', 'file', 'brain', 'image', 'chat', 'diff', 'agent'];
    const items = kinds.map((kind, i) => ({ id: i, kind }));
    const slots = [...computeGrid(items, AREA).values()];
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        const a = slots[i];
        const b = slots[j];
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        expect(ox * oy).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('centers the packed block in the available height for a light load', () => {
    const slots = [...computeGrid([{ id: 0, kind: 'term' }, { id: 1, kind: 'brain' }], AREA).values()];
    const top = Math.min(...slots.map((s) => s.y));
    // A single centered row sits below the area top, not hugging it.
    expect(top).toBeGreaterThan(AREA.y + 1);
  });

  it('is deterministic — same cards produce the same layout', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i, kind: i % 2 ? 'term' : 'chat' }));
    const a = [...computeGrid(items, AREA).entries()];
    const b = [...computeGrid(items, AREA).entries()];
    expect(a).toEqual(b);
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
