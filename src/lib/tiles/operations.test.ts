/**
 * Tile layout deserialization — the stale-split self-heal (2026-07-02).
 *
 * A persisted split of two `terminal` leaves used to rehydrate as TWO full
 * WorkspaceTerminals side by side (two tab strips, two composers) because
 * `migrateNode` rewrote retired leaf kinds but never collapsed split nodes.
 * These pin the collapse: terminal↔terminal splits heal to one leaf; splits
 * carrying canvas/preview leaves (live, intentional layouts) are preserved.
 */

import { describe, expect, it } from 'vitest';

import { deserializeTileLayout } from './operations';

const leaf = (id: string, kind: string) => ({ type: 'leaf', id, content: { kind } });
const split = (id: string, children: unknown[]) => ({
  type: 'split', id, direction: 'horizontal', ratio: 0.5, children,
});

// Matches the module-private TILE_LAYOUT_VERSION (operations.ts:16) — bump here
// if a migration bumps it there (a mismatch makes every case return null).
const serialize = (root: unknown) => JSON.stringify({ version: 4, root });

describe('deserializeTileLayout — stale split collapse', () => {
  it('collapses a persisted terminal↔terminal split to a single terminal leaf', () => {
    const layout = deserializeTileLayout(serialize(split('s1', [leaf('a', 'terminal'), leaf('b', 'terminal')])));
    expect(layout?.root.type).toBe('leaf');
    expect(layout?.root.type === 'leaf' && layout.root.content.kind).toBe('terminal');
    expect(layout?.root.id).toBe('a');
  });

  it('collapses a split of RETIRED kinds (thoughts/mission-control → terminal) the migration itself creates', () => {
    const layout = deserializeTileLayout(serialize(split('s1', [leaf('a', 'terminal'), leaf('b', 'thoughts')])));
    expect(layout?.root.type).toBe('leaf');
  });

  it('heals the April-2026 dispatch auto-split: a legacy workspace-kind leaf collapses instead of resurrecting a second pane', () => {
    // Split-zombie root fix (2026-07-16): layouts minted by the old
    // auto-open-second-workspace-on-dispatch behavior persisted a
    // 'workspace' leaf the terminal↔terminal collapse never matched, so the
    // phantom pane came back on every boot.
    const layout = deserializeTileLayout(serialize(split('s1', [leaf('a', 'terminal'), leaf('b', 'workspace')])));
    expect(layout?.root.type).toBe('leaf');
    expect(layout?.root.type === 'leaf' && layout.root.content.kind).toBe('terminal');
  });

  it('preserves a terminal↔canvas split (live intentional layout)', () => {
    const layout = deserializeTileLayout(serialize(split('s1', [leaf('a', 'terminal'), leaf('b', 'canvas')])));
    expect(layout?.root.type).toBe('split');
  });

  it('heals a nested stale split bottom-up', () => {
    const nested = split('outer', [
      split('inner', [leaf('a', 'terminal'), leaf('b', 'terminal')]),
      leaf('c', 'canvas'),
    ]);
    const layout = deserializeTileLayout(serialize(nested));
    expect(layout?.root.type).toBe('split');
    if (layout?.root.type === 'split') {
      expect(layout.root.children[0].type).toBe('leaf');
    }
  });

  it('a plain single terminal leaf passes through untouched', () => {
    const layout = deserializeTileLayout(serialize(leaf('root', 'terminal')));
    expect(layout?.root.type).toBe('leaf');
  });
});
