import { describe, expect, it } from 'vitest';
import {
  addSessionToLayout,
  collectSessionKeys,
  collectSessionKeysByArrival,
  collectSessionLeaves,
  closeSessionLeaf,
  computeSessionTileLayout,
  createDefaultSessionTileLayout,
  deserializeSessionTileLayout,
  findSessionLeafByKey,
  resizeSessionSplit,
  reconcileSessionTileParticipants,
  serializeSessionTileLayout,
  splitChatWithSession,
  splitLeafWithThread,
  type SessionTileLayout,
  type SessionTileNode,
  type SessionTileSplit,
} from './session-tiles';
import { collectSessionTileMeshGroups } from './session-tile-mesh';

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

  it('keeps one through four workers as full transcript splits', () => {
    for (let count = 1; count <= 4; count += 1) {
      const keys = Array.from({ length: count }, (_, index) => `full:${index + 1}`);
      const layout = addSessions(keys);

      expect(collectSessionTileMeshGroups(layout.root)).toEqual([]);
      expect(collectSessionKeysByArrival(layout.root)).toEqual(keys);
    }
  });

  it('switches to one compact mesh when a fifth worker arrives', () => {
    const keys = Array.from({ length: 5 }, (_, index) => `mesh:${index + 1}`);
    const groups = collectSessionTileMeshGroups(addSessions(keys).root);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.leaves).toHaveLength(5);
  });

  it('keeps eight workers in one contiguous mesh beside chat', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `s:${index + 1}`);
    const layout = addSessions(keys);
    const groups = collectSessionTileMeshGroups(layout.root);

    expect(new Set(collectSessionKeys(layout.root))).toEqual(new Set(keys));
    expect(collectSessionKeysByArrival(layout.root)).toEqual(keys);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.leaves).toHaveLength(8);
    expect(groups[0]?.internalSplitIds).toHaveLength(7);
    expect(countChatLeaves(layout.root)).toBe(1);
  });

  it('retains workers beyond eight in the automatic mesh tree', () => {
    const keys = Array.from({ length: 12 }, (_, index) => `s:${index + 1}`);
    const layout = keys.reduce((current, key) => addSessionToLayout(current, key), createDefaultSessionTileLayout());
    const groups = collectSessionTileMeshGroups(layout.root);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.leaves).toHaveLength(12);
  });

  it('returns the same layout for a duplicate and keeps the ninth worker', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `s:${index + 1}`);
    const layout = addSessions(keys);

    expect(addSessionToLayout(layout, 's:1')).toBe(layout);
    expect(collectSessionKeys(addSessionToLayout(layout, 's:9').root)).toContain('s:9');
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

  it('assigns stable arrival order when the tree reading order rotates', () => {
    let layout = addSessions(['s:1', 's:2', 's:3']);
    const firstLeaf = collectSessionLeaves(layout.root)
      .find((leaf) => leaf.sessionKey === 's:1');
    expect(firstLeaf).toBeTruthy();
    if (!firstLeaf) return;

    layout = closeSessionLeaf(layout, firstLeaf.id);
    layout = addSessionToLayout(layout, 's:4');

    expect(collectSessionKeysByArrival(layout.root)).toEqual(['s:2', 's:3', 's:4']);
  });

  it('keeps manually split thread panes outside worker mesh groups', () => {
    let layout = addSessions(['s:1', 's:2']);
    const target = collectSessionLeaves(layout.root)[0];
    expect(target).toBeTruthy();
    if (!target) return;
    layout = splitLeafWithThread(layout, target.id, {
      threadId: 'thread:manual',
      title: 'Manual thread',
      mode: 'chat',
    }, 'vertical');

    expect(collectSessionTileMeshGroups(layout.root)).toEqual([]);
  });

  it('keeps an authored session pane outside a later seven-worker mesh', () => {
    let layout = splitChatWithSession(
      createDefaultSessionTileLayout(),
      'manual:one',
      'vertical',
      0.65,
    );
    for (let index = 1; index <= 7; index += 1) {
      layout = addSessionToLayout(layout, `automatic:${index}`);
    }

    const manual = findSessionLeafByKey(layout.root, 'manual:one');
    const groups = collectSessionTileMeshGroups(layout.root);
    expect(manual?.sessionSurface).toBe('split');
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]?.leaves.map((leaf) => leaf.sessionKey))).toEqual(
      new Set(Array.from({ length: 7 }, (_, index) => `automatic:${index + 1}`)),
    );
    expect(groups[0]?.leaves).not.toContain(manual);
  });

  it('retargets a rotated session without changing participant, leaf, arrival, or focus identity', () => {
    const initial = addSessionToLayout(createDefaultSessionTileLayout(), 'session:old');
    const stamped = reconcileSessionTileParticipants(initial, [{
      participantId: 'packet:stable',
      packetId: 'packet:stable',
      laneId: 'lane:one',
      sessionKey: 'session:old',
      repoPath: '/repo/external',
      runtime: 'codex',
      taskSummary: 'Inspect external repo',
      launchContext: {
        source: 'cli',
        presentation: 'split',
        repoContext: 'transient',
      },
    }]);
    const before = collectSessionLeaves(stamped.root)[0];
    const persisted = deserializeSessionTileLayout(serializeSessionTileLayout(stamped));
    expect(persisted).not.toBeNull();
    const rotated = reconcileSessionTileParticipants(persisted!, [{
      participantId: 'packet:stable',
      packetId: 'packet:stable',
      laneId: 'lane:one',
      sessionKey: 'session:new',
    }]);
    const after = collectSessionLeaves(rotated.root)[0];

    expect(after).toMatchObject({
      id: before?.id,
      participantId: 'packet:stable',
      packetId: 'packet:stable',
      laneId: 'lane:one',
      sessionKey: 'session:new',
      arrivalOrder: before?.arrivalOrder,
      repoPath: '/repo/external',
      runtime: 'codex',
      title: 'Inspect external repo',
      launchContext: { source: 'cli' },
    });
    expect(collectSessionKeysByArrival(rotated.root)).toEqual(['session:new']);
  });
});
