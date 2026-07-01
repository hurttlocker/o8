/**
 * Batched rationale parsing — the pure, schema-tolerant extractor. The live
 * cheap-model call (callHaiku) + heuristic fallback are exercised via the smoke.
 */

import { describe, it, expect } from 'vitest';

import { parseBatchRationales } from './rationale';

describe('parseBatchRationales', () => {
  it('parses a strict JSON array into an index→rationale map', () => {
    const raw = '[{"i":0,"rationale":"91 files import it — ripples widely."},{"i":1,"rationale":"Large + churning."}]';
    const map = parseBatchRationales(raw);
    expect(map.get(0)).toBe('91 files import it — ripples widely.');
    expect(map.get(1)).toBe('Large + churning.');
    expect(map.size).toBe(2);
  });

  it('tolerates code fences / prose around the array', () => {
    const raw = 'Sure:\n```json\n[{"i":2,"rationale":"Central hub, touch with care."}]\n```';
    expect(parseBatchRationales(raw).get(2)).toBe('Central hub, touch with care.');
  });

  it('skips malformed entries (that file keeps its heuristic)', () => {
    const raw = '[{"i":0,"rationale":"ok enough here"},{"i":1},{"rationale":"no index"},{"i":2,"rationale":"x"}]';
    const map = parseBatchRationales(raw);
    expect(map.get(0)).toBe('ok enough here');
    expect(map.has(1)).toBe(false); // missing rationale
    expect(map.has(2)).toBe(false); // too short (< 4 chars)
  });

  it('caps overly long rationales', () => {
    const long = 'x'.repeat(300);
    const out = parseBatchRationales(`[{"i":0,"rationale":"${long}"}]`).get(0)!;
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns an empty map for non-JSON / no array', () => {
    expect(parseBatchRationales('').size).toBe(0);
    expect(parseBatchRationales('sorry, I cannot help').size).toBe(0);
    expect(parseBatchRationales('{"i":0}').size).toBe(0);
  });
});
