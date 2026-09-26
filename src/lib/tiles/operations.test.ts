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

import { closeTile, collectLeafNodes, computeTileLayout, createDefaultTileLayout, deserializeTileLayout, hasUserArrangedSplit, insertBalancedTerminalTile, rebalanceTerminalTiles, resizeTile, serializeTileLayout, splitTile } from './operations';

const leaf = (id: string, kind: string) => ({ type: 'leaf', id, content: { kind } });
const split = (id: string, children: unknown[]) => ({
  type: 'split', id, direction: 'horizontal', ratio: 0.5, children,
});

describe('balanced terminal panes', () => {
  const terminal = { kind: 'terminal' as const, createdFromSplit: true, initialTab: 'terminal' as const };

  it('gives three real terminals equal full-height columns and survives reload', () => {
    const initial = createDefaultTileLayout();
    const second = insertBalancedTerminalTile(initial.root, 'tile-root', 'vertical', terminal);
    const third = insertBalancedTerminalTile(second.root, second.newTileId!, 'horizontal', terminal);
    const ids = collectLeafNodes(third.root).map((item) => item.id);
    expect(ids).toEqual(['tile-root', second.newTileId, third.newTileId]);
    const rects = computeTileLayout(third.root).leafRects;
    expect(ids.map((id) => rects.get(id)?.width)).toEqual([expect.closeTo(1 / 3), expect.closeTo(1 / 3), expect.closeTo(1 / 3)]);
    expect(ids.map((id) => rects.get(id)?.height)).toEqual([1, 1, 1]);
    const restored = deserializeTileLayout(serializeTileLayout({ ...initial, root: third.root }));
    expect(restored && collectLeafNodes(restored.root).map((item) => item.id)).toEqual(ids);
  });

  it('reflows four terminals into equal quadrants and three after a close', () => {
    const initial = createDefaultTileLayout();
    const second = insertBalancedTerminalTile(initial.root, 'tile-root', 'vertical', terminal);
    const third = insertBalancedTerminalTile(second.root, second.newTileId!, 'vertical', terminal);
    const fourth = insertBalancedTerminalTile(third.root, third.newTileId!, 'vertical', terminal);
    const ids = collectLeafNodes(fourth.root).map((item) => item.id);
    const rects = computeTileLayout(fourth.root).leafRects;
    expect(ids.map((id) => rects.get(id))).toEqual([
      { left: 0, top: 0, width: 0.5, height: 0.5 },
      { left: 0.5, top: 0, width: 0.5, height: 0.5 },
      { left: 0, top: 0.5, width: 0.5, height: 0.5 },
      { left: 0.5, top: 0.5, width: 0.5, height: 0.5 },
    ]);
    const closed = closeTile(fourth.root, ids[1]);
    const reflowed = rebalanceTerminalTiles(closed.root, 'vertical');
    expect(collectLeafNodes(reflowed).map((item) => item.id)).toEqual(ids.filter((id) => id !== ids[1]));
    expect(Array.from(computeTileLayout(reflowed).leafRects.values()).map((rect) => rect.width)).toEqual([
      expect.closeTo(1 / 3), expect.closeTo(1 / 3), expect.closeTo(1 / 3),
    ]);
  });

  it('puts the fourth pane in the open lower-right cell regardless of which pane owns Add', () => {
    const initial = createDefaultTileLayout();
    const second = insertBalancedTerminalTile(initial.root, 'tile-root', 'vertical', terminal);
    const third = insertBalancedTerminalTile(second.root, second.newTileId!, 'vertical', terminal);
    const fourth = insertBalancedTerminalTile(third.root, 'tile-root', 'vertical', terminal);
    const ids = collectLeafNodes(fourth.root).map((item) => item.id);
    expect(ids).toEqual(['tile-root', second.newTileId, third.newTileId, fourth.newTileId]);
    expect(computeTileLayout(fourth.root).leafRects.get(fourth.newTileId!)).toEqual({
      left: 0.5, top: 0.5, width: 0.5, height: 0.5,
    });
  });

  it('repairs an existing uneven three-terminal split without resetting later manual resizing', () => {
    const initial = createDefaultTileLayout();
    const second = splitTile(initial.root, 'tile-root', 'vertical', terminal);
    const oldThird = splitTile(second.root, second.newTileId!, 'horizontal', terminal);
    const migrated = deserializeTileLayout(serializeTileLayout({ ...initial, root: oldThird.root }));
    expect(migrated).not.toBeNull();
    const ids = collectLeafNodes(migrated!.root).map((item) => item.id);
    expect(ids.map((id) => computeTileLayout(migrated!.root).leafRects.get(id)?.height)).toEqual([1, 1, 1]);
    const manual = resizeTile(migrated!.root, migrated!.root.id, 0.42);
    const restoredManual = deserializeTileLayout(serializeTileLayout({ ...initial, root: manual }));
    expect(restoredManual?.root.type === 'split' && restoredManual.root.ratio).toBe(0.42);
  });

  it('keeps an exact edge drop in the same place after reload', () => {
    const initial = createDefaultTileLayout();
    const second = insertBalancedTerminalTile(initial.root, 'tile-root', 'vertical', terminal);
    const third = insertBalancedTerminalTile(second.root, 'tile-root', 'vertical', terminal);
    const dropped = splitTile(third.root, 'tile-root', 'horizontal', terminal, 0.5, false, true);
    expect(hasUserArrangedSplit(dropped.root)).toBe(true);
    const before = computeTileLayout(dropped.root).leafRects;
    const restored = deserializeTileLayout(serializeTileLayout({ ...initial, root: dropped.root }));
    expect(restored).not.toBeNull();
    expect(computeTileLayout(restored!.root).leafRects).toEqual(before);
  });
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

  it('keeps a deliberate chat pane and its initial tab after saving and loading', () => {
    const initial = createDefaultTileLayout();
    const result = splitTile(initial.root, 'tile-root', 'horizontal', {
      kind: 'terminal', repoPath: null, createdFromSplit: true, initialTab: 'chat',
    });
    const restored = deserializeTileLayout(serializeTileLayout({ ...initial, root: result.root }));
    expect(restored?.root.type).toBe('split');
    if (restored?.root.type === 'split') {
      expect(restored.root.children[1].type).toBe('leaf');
      if (restored.root.children[1].type === 'leaf') {
        expect(restored.root.children[1].content).toMatchObject({
          kind: 'terminal', createdFromSplit: true, initialTab: 'chat',
        });
      }
    }
  });

  it('places a dropped terminal before its target on left or above drops', () => {
    const initial = createDefaultTileLayout();
    const result = splitTile(initial.root, 'tile-root', 'vertical', {
      kind: 'terminal', createdFromSplit: true, initialTab: 'terminal',
    }, 0.5, true);
    expect(result.root.type).toBe('split');
    if (result.root.type === 'split') {
      expect(result.root.children[0].id).toBe(result.newTileId);
      expect(result.root.children[1].id).toBe('tile-root');
    }
  });
});
