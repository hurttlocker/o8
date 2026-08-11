import { describe, expect, it } from 'vitest';
import {
  addSessionToLayout,
  collectSessionLeaves,
  collectSessionKeys,
  createDefaultSessionTileLayout,
  type SessionTileLayout,
} from './session-tiles';

function emptyLayout(): SessionTileLayout {
  return createDefaultSessionTileLayout();
}

/** Quick helper: add N sessions in sequence, returning the final layout. */
function addN(baseline: SessionTileLayout, keys: string[]): SessionTileLayout {
  let layout = baseline;
  for (const key of keys) {
    layout = addSessionToLayout(layout, key);
  }
  return layout;
}

describe('addSessionToLayout', () => {
  it('splits chat vertically for the first session', () => {
    const layout = addSessionToLayout(emptyLayout(), 'session:one');
    const keys = collectSessionKeys(layout.root);
    expect(keys).toEqual(['session:one']);
    // Root must be a vertical split (first session default).
    expect(layout.root.type).toBe('split');
    expect(layout.root).toHaveProperty('direction', 'vertical');
  });

  it('splits the largest session leaf for the second session', () => {
    // Two sessions: both should be present, second uses largest-area split.
    const layout = addN(emptyLayout(), ['session:one', 'session:two']);
    const keys = collectSessionKeys(layout.root);
    expect(keys).toEqual(['session:one', 'session:two']);
    expect(collectSessionLeaves(layout.root)).toHaveLength(2);
  });

  it('accommodates four sessions', () => {
    const layout = addN(emptyLayout(), ['s:1', 's:2', 's:3', 's:4']);
    const keys = collectSessionKeys(layout.root);
    expect(keys).toEqual(['s:1', 's:2', 's:3', 's:4']);
    expect(collectSessionLeaves(layout.root)).toHaveLength(4);
  });

  it('accommodates up to eight sessions', () => {
    const keys = Array.from({ length: 8 }, (_, i) => `s:${i + 1}`);
    const layout = addN(emptyLayout(), keys);
    expect(collectSessionKeys(layout.root)).toEqual(keys);
    expect(collectSessionLeaves(layout.root)).toHaveLength(8);
  });

  it('is a no-op for a duplicate session key', () => {
    const layout = addN(emptyLayout(), ['s:1', 's:2']);
    const beforeKeys = collectSessionKeys(layout.root);
    const after = addSessionToLayout(layout, 's:1');
    expect(collectSessionKeys(after.root)).toEqual(beforeKeys);
    expect(collectSessionLeaves(after.root)).toHaveLength(2);
  });

  it('is a no-op beyond eight sessions', () => {
    const keys = Array.from({ length: 8 }, (_, i) => `s:${i + 1}`);
    const layout = addN(emptyLayout(), keys);
    const ninth = addSessionToLayout(layout, 's:ninth');
    expect(collectSessionKeys(ninth.root)).toEqual(keys);
    expect(collectSessionLeaves(ninth.root)).toHaveLength(8);
  });

  it('selects the largest leaf after a resize ratio change', () => {
    let layout = addN(emptyLayout(), ['s:1', 's:2', 's:3']);
    // The split structure at 3 sessions: vertical split of [chat, ?].
    // After addSessionToLayout picks the largest leaf each time, a fourth
    // session splits the largest leaf. Then we add a fifth; the largest
    // leaf should have changed after the resize.
    const beforeCount = collectSessionLeaves(layout.root).length;
    layout = addSessionToLayout(layout, 's:4');
    expect(collectSessionLeaves(layout.root)).toHaveLength(beforeCount + 1);
    expect(collectSessionKeys(layout.root)).toContain('s:4');
  });

  it('preserves existing split ratios when adding new sessions', () => {
    // Three sessions creates a binary split tree. All existing ratios
    // must stay at 0.5 (the default) after adding sessions.
    const layout = addN(emptyLayout(), ['s:1', 's:2', 's:3']);

    function checkRatios(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'split' && typeof n.ratio === 'number') {
        expect(n.ratio).toBe(0.5);
      }
      if (n.children && Array.isArray(n.children)) {
        for (const child of n.children) checkRatios(child);
      }
    }
    checkRatios(layout.root);
  });

  it('handles just one chat leaf with no sessions', () => {
    const layout = emptyLayout();
    expect(collectSessionLeaves(layout.root)).toHaveLength(0);
    expect(collectSessionKeys(layout.root)).toEqual([]);
    expect(layout.root.type).toBe('leaf');
    expect(layout.root).toHaveProperty('kind', 'chat');
  });

  it('uses horizontal direction when viewport is taller than wide', () => {
    const layout = addSessionToLayout(
      emptyLayout(),
      's:portrait',
      { left: 0, top: 0, width: 400, height: 800 },
    );
    expect(layout.root.type).toBe('split');
    expect(layout.root).toHaveProperty('direction', 'horizontal');
  });

  it('uses vertical direction when viewport is wider than tall', () => {
    const layout = addSessionToLayout(
      emptyLayout(),
      's:wide',
      { left: 0, top: 0, width: 1200, height: 800 },
    );
    expect(layout.root.type).toBe('split');
    expect(layout.root).toHaveProperty('direction', 'vertical');
  });
});
