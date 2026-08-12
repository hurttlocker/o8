import type { SessionTileLeaf, SessionTileNode } from './session-tiles';

export interface SessionTileMeshGroup {
  id: string;
  leaves: SessionTileLeaf[];
  /** Split handles wholly owned by the automatic mesh. */
  internalSplitIds: string[];
}

/** Full split transcripts stay readable through four workers. The compact
 * mesh begins with the first worker that would exceed that layout. */
export const MIN_SESSION_TILE_MESH_SIZE = 5;

function automaticMeshLeaves(node: SessionTileNode): SessionTileLeaf[] | null {
  if (node.type === 'leaf') {
    return node.kind === 'session' && node.sessionSurface === 'mesh' ? [node] : null;
  }
  const first = automaticMeshLeaves(node.children[0]);
  const second = automaticMeshLeaves(node.children[1]);
  return first && second ? [...first, ...second] : null;
}

function collectSplitIds(node: SessionTileNode): string[] {
  if (node.type === 'leaf') return [];
  return [
    node.id,
    ...collectSplitIds(node.children[0]),
    ...collectSplitIds(node.children[1]),
  ];
}

/** Coalesce only contiguous outside-worker leaves. Explicit session splits,
 *  dragged threads, and chat panes remain hard layout boundaries. */
export function collectSessionTileMeshGroups(node: SessionTileNode): SessionTileMeshGroup[] {
  const leaves = automaticMeshLeaves(node);
  if (leaves && leaves.length >= MIN_SESSION_TILE_MESH_SIZE) {
    const stableRoot = leaves.reduce((first, leaf, treeIndex) => {
      if (!first) return { leaf, treeIndex };
      const firstOrder = first.leaf.arrivalOrder ?? first.treeIndex;
      const leafOrder = leaf.arrivalOrder ?? treeIndex;
      return leafOrder < firstOrder ? { leaf, treeIndex } : first;
    }, null as { leaf: SessionTileLeaf; treeIndex: number } | null);
    return [{
      id: stableRoot?.leaf.id ?? node.id,
      leaves,
      internalSplitIds: collectSplitIds(node),
    }];
  }
  if (node.type === 'leaf') return [];
  return [
    ...collectSessionTileMeshGroups(node.children[0]),
    ...collectSessionTileMeshGroups(node.children[1]),
  ];
}
