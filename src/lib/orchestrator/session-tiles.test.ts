import { describe, expect, it } from 'vitest';
import {
  addSessionToLayout,
  collectSessionKeys,
  collectSessionLeaves,
  computeSessionTileLayout,
  createDefaultSessionTileLayout,
  resizeSessionSplit,
  type SessionTileLayout,
  type SessionTileNode,
  type SessionTileSplit,
} from './session-tiles';

function addSessions(keys: string[]): SessionTileLayout {
  let layout = createDefaultSessionTileLayout();
  for (const key of keys) layout = addSessionToLayout(layout, key);
  return layout;
}

function parentOfSession(node: SessionTileNode, sessionKey: string): SessionTileSplit | null {
  if (node.type === 'leaf') return null;
  for (const child of node.children) {
    if (child.type === 'leaf' && child.kind === 'session' && child.sessionKey === sessionKey) {
      return node;
    }
    const nested = parentOfSession(child, sessionKey);
    if (nested) return nested;
  }
  return null;
}

function countChatLeaves(node: SessionTileNode): number {
  if (node.type === 'leaf') return node.kind === 'chat' ? 1 : 0;
  return countChatLeaves(node.children[0]) + countChatLeaves(node.children[1]);
}

function ratiosById(node: SessionTileNode, ratios = new Map<string, number>()): Map<string, number> {
  if (node.type === 'leaf') return ratios;
  ratios.set(node.id, node.ratio);
  ratiosById(node.children[0], ratios);
  ratiosById(node.children[1], ratios);
  return ratios;
}

describe('addSessionToLayout', () => {
  it('opens the first worker to the right of chat in every viewport shape', () => {
    const layout = addSessionToLayout(
      createDefaultSessionTileLayout(),
      'session:one',
      { left: 0, top: 0, width: 400, height: 800 },
    );

    expect(layout.root.type).toBe('split');
    expect(layout.root).toHaveProperty('direction', 'vertical');
    expect(collectSessionKeys(layout.root)).toEqual(['session:one']);
    expect(countChatLeaves(layout.root)).toBe(1);
  });

  it('splits the tall first-worker leaf horizontally for the second worker', () => {
    const layout = addSessions(['session:one', 'session:two']);
    const parent = parentOfSession(layout.root, 'session:one');

    expect(parent?.direction).toBe('horizontal');
    expect(new Set(parent ? collectSessionKeys(parent) : [])).toEqual(
      new Set(['session:one', 'session:two']),
    );
  });

  it('uses stable reading order when equal-area leaves tie', () => {
    const layout = addSessions(['session:one', 'session:two', 'session:three']);
    const parent = parentOfSession(layout.root, 'session:one');

    expect(new Set(parent ? collectSessionKeys(parent) : [])).toEqual(
      new Set(['session:one', 'session:three']),
    );
  });

  it('balances four workers across equal-area leaves', () => {
    const layout = addSessions(['s:1', 's:2', 's:3', 's:4']);
    const { leafRects } = computeSessionTileLayout(layout.root);
    const areas = collectSessionLeaves(layout.root).map((leaf) => {
      const rect = leafRects.get(leaf.id);
      return rect ? rect.width * rect.height : 0;
    });

    expect(areas).toHaveLength(4);
    for (const area of areas) expect(area).toBeCloseTo(0.125);
    expect(countChatLeaves(layout.root)).toBe(1);
  });

  it('balances eight workers and keeps exactly one chat', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `s:${index + 1}`);
    const layout = addSessions(keys);
    const { leafRects } = computeSessionTileLayout(layout.root);
    const areas = collectSessionLeaves(layout.root).map((leaf) => {
      const rect = leafRects.get(leaf.id);
      return rect ? rect.width * rect.height : 0;
    });

    expect(new Set(collectSessionKeys(layout.root))).toEqual(new Set(keys));
    for (const area of areas) expect(area).toBeCloseTo(0.0625);
    expect(countChatLeaves(layout.root)).toBe(1);
  });

  it('returns the same layout for a duplicate or ninth worker', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `s:${index + 1}`);
    const layout = addSessions(keys);

    expect(addSessionToLayout(layout, 's:1')).toBe(layout);
    expect(addSessionToLayout(layout, 's:9')).toBe(layout);
  });

  it('uses a resized split to choose the largest leaf and its direction', () => {
    let layout = addSessions(['s:1', 's:2']);
    expect(layout.root.type).toBe('split');
    if (layout.root.type !== 'split') return;
    const workerRegion = layout.root.children[1];
    expect(workerRegion.type).toBe('split');
    if (workerRegion.type !== 'split') return;

    layout = resizeSessionSplit(layout, workerRegion.id, 0.8);
    layout = addSessionToLayout(layout, 's:3');
    const selectedParent = parentOfSession(layout.root, 's:1');

    expect(selectedParent?.direction).toBe('horizontal');
    expect(new Set(selectedParent ? collectSessionKeys(selectedParent) : [])).toEqual(
      new Set(['s:1', 's:3']),
    );
  });

  it('preserves every existing split ratio when a worker is added', () => {
    let layout = addSessions(['s:1', 's:2']);
    expect(layout.root.type).toBe('split');
    if (layout.root.type !== 'split') return;
    const workerRegion = layout.root.children[1];
    expect(workerRegion.type).toBe('split');
    if (workerRegion.type !== 'split') return;

    layout = resizeSessionSplit(layout, layout.root.id, 0.3);
    layout = resizeSessionSplit(layout, workerRegion.id, 0.7);
    const before = ratiosById(layout.root);
    const after = ratiosById(addSessionToLayout(layout, 's:3').root);

    for (const [splitId, ratio] of before) expect(after.get(splitId)).toBe(ratio);
  });
});
