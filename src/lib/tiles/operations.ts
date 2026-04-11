import type {
  TileContent,
  TileContentKind,
  TileLayout,
  TileLeafNode,
  TileNode,
  TileSplitDirection,
  TileSplitNode,
} from '@/lib/tiles/types';
import { isTileLeafNode, isTileSplitNode } from '@/lib/tiles/types';

const TILE_LAYOUT_VERSION = 4; // v4: thoughts/mission/history tile kinds retired; Orchestrator lives as a tab now
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

function makeId(prefix: 'tile' | 'split' = 'tile') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampRatio(value: number) {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

export function createTileContent(kind: TileContentKind): TileContent {
  if (kind === 'preview') {
    return { kind, selectedPreviewId: null };
  }
  if (kind === 'terminal') {
    return { kind, repoPath: null };
  }
  if (kind === 'canvas') {
    return { kind, repoPath: null };
  }
  return { kind };
}

export function createLeaf(content: TileContent, id = makeId('tile')): TileLeafNode {
  return {
    type: 'leaf',
    id,
    content,
  };
}

export function createSplit(
  direction: TileSplitDirection,
  ratio: number,
  children: [TileNode, TileNode],
  id = makeId('split'),
): TileSplitNode {
  return {
    type: 'split',
    id,
    direction,
    ratio: clampRatio(ratio),
    children,
  };
}

export function createDefaultTileLayout(): TileLayout {
  // Single terminal leaf is the whole workspace. The orchestrator now lives
  // as a TAB inside WorkspaceTerminal next to "Assistant", not as a split
  // tile — clicking it takes over the full workspace area.
  return {
    version: TILE_LAYOUT_VERSION,
    root: createLeaf(createTileContent('terminal'), 'tile-root'),
  };
}

export function findTile(node: TileNode, tileId: string): TileNode | null {
  if (node.id === tileId) {
    return node;
  }
  if (isTileLeafNode(node)) {
    return null;
  }
  return findTile(node.children[0], tileId) ?? findTile(node.children[1], tileId);
}

export function findLeafByContentKind(node: TileNode, kind: TileContentKind): TileLeafNode | null {
  if (isTileLeafNode(node)) {
    return node.content.kind === kind ? node : null;
  }
  return findLeafByContentKind(node.children[0], kind) ?? findLeafByContentKind(node.children[1], kind);
}

export function getFirstLeaf(node: TileNode): TileLeafNode {
  if (isTileLeafNode(node)) {
    return node;
  }
  return getFirstLeaf(node.children[0]);
}

/**
 * Find the nearest sibling leaf of a given tile. When a tile is closed, focus
 * should move to its sibling rather than the first leaf of the entire tree.
 */
export function findSiblingLeaf(root: TileNode, tileId: string): TileLeafNode | null {
  if (isTileLeafNode(root)) return null;

  const [first, second] = root.children;
  if (isTileLeafNode(first) && first.id === tileId) {
    return getFirstLeaf(second);
  }
  if (isTileLeafNode(second) && second.id === tileId) {
    return getFirstLeaf(first);
  }

  return findSiblingLeaf(first, tileId) ?? findSiblingLeaf(second, tileId);
}

export function countLeaves(node: TileNode): number {
  if (isTileLeafNode(node)) {
    return 1;
  }
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

export function collectLeafContentKinds(node: TileNode): TileContentKind[] {
  if (isTileLeafNode(node)) {
    return [node.content.kind];
  }
  return [
    ...collectLeafContentKinds(node.children[0]),
    ...collectLeafContentKinds(node.children[1]),
  ];
}

export function mapTile(
  node: TileNode,
  tileId: string,
  updater: (current: TileNode) => TileNode,
): TileNode {
  if (node.id === tileId) {
    return updater(node);
  }
  if (isTileLeafNode(node)) {
    return node;
  }
  const firstChild = mapTile(node.children[0], tileId, updater);
  const secondChild = mapTile(node.children[1], tileId, updater);
  if (firstChild === node.children[0] && secondChild === node.children[1]) {
    return node;
  }
  return {
    ...node,
    children: [firstChild, secondChild],
  };
}

export function replaceTileContent(node: TileNode, tileId: string, content: TileContent): TileNode {
  return mapTile(node, tileId, (current) => {
    if (!isTileLeafNode(current)) {
      return current;
    }
    return {
      ...current,
      content,
    };
  });
}

export function splitTile(
  node: TileNode,
  tileId: string,
  direction: TileSplitDirection,
  nextContent: TileContent,
  ratio = 0.5,
): { root: TileNode; newTileId: string | null } {
  let newTileId: string | null = null;

  function walk(current: TileNode): TileNode {
    if (isTileLeafNode(current)) {
      if (current.id !== tileId) {
        return current;
      }
      const nextLeaf = createLeaf(nextContent);
      newTileId = nextLeaf.id;
      return createSplit(direction, ratio, [current, nextLeaf]);
    }

    const firstChild = walk(current.children[0]);
    const secondChild = walk(current.children[1]);
    if (firstChild === current.children[0] && secondChild === current.children[1]) {
      return current;
    }

    return {
      ...current,
      children: [firstChild, secondChild],
    };
  }

  return {
    root: walk(node),
    newTileId,
  };
}

export function wrapRootWithSplit(
  node: TileNode,
  direction: TileSplitDirection,
  nextContent: TileContent,
  ratio = 0.5,
): { root: TileNode; newTileId: string } {
  const nextLeaf = createLeaf(nextContent);
  return {
    root: createSplit(direction, ratio, [node, nextLeaf]),
    newTileId: nextLeaf.id,
  };
}

export function resizeTile(node: TileNode, splitId: string, ratio: number): TileNode {
  return mapTile(node, splitId, (current) => {
    if (!isTileSplitNode(current)) {
      return current;
    }
    return {
      ...current,
      ratio: clampRatio(ratio),
    };
  });
}

export function closeTile(node: TileNode, tileId: string): { root: TileNode; closed: boolean } {
  function walk(current: TileNode): { next: TileNode; closed: boolean } {
    if (isTileLeafNode(current)) {
      return { next: current, closed: false };
    }

    const [firstChild, secondChild] = current.children;
    if (isTileLeafNode(firstChild) && firstChild.id === tileId) {
      return { next: secondChild, closed: true };
    }
    if (isTileLeafNode(secondChild) && secondChild.id === tileId) {
      return { next: firstChild, closed: true };
    }

    const leftResult = walk(firstChild);
    if (leftResult.closed) {
      return {
        next: {
          ...current,
          children: [leftResult.next, secondChild],
        },
        closed: true,
      };
    }

    const rightResult = walk(secondChild);
    if (rightResult.closed) {
      return {
        next: {
          ...current,
          children: [firstChild, rightResult.next],
        },
        closed: true,
      };
    }

    return { next: current, closed: false };
  }

  const result = walk(node);
  return {
    root: result.next,
    closed: result.closed,
  };
}

function isTileContent(value: unknown): value is TileContent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'workspace'
    || kind === 'terminal'
    || kind === 'preview'
    || kind === 'contextual-panel'
    // Legacy kinds — accepted for deserialization, migrated later
    || kind === 'canvas'
    || kind === 'bottom-terminal';
}

function isTileNode(value: unknown): value is TileNode {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    type?: unknown;
    id?: unknown;
    content?: unknown;
    direction?: unknown;
    ratio?: unknown;
    children?: unknown;
  };

  if (candidate.type === 'leaf') {
    return typeof candidate.id === 'string' && isTileContent(candidate.content);
  }

  if (candidate.type === 'split') {
    return typeof candidate.id === 'string'
      && (candidate.direction === 'horizontal' || candidate.direction === 'vertical')
      && typeof candidate.ratio === 'number'
      && Array.isArray(candidate.children)
      && candidate.children.length === 2
      && isTileNode(candidate.children[0])
      && isTileNode(candidate.children[1]);
  }

  return false;
}

function normalizeNode(node: TileNode): TileNode {
  if (isTileLeafNode(node)) {
    if (node.content.kind === 'terminal') {
      return {
        ...node,
        content: {
          kind: 'terminal',
          repoPath: typeof node.content.repoPath === 'string' && node.content.repoPath.trim()
            ? node.content.repoPath
            : null,
        },
      };
    }
    if (node.content.kind === 'canvas') {
      return {
        ...node,
        content: {
          kind: 'canvas',
          repoPath: typeof node.content.repoPath === 'string' && node.content.repoPath.trim()
            ? node.content.repoPath
            : null,
        },
      };
    }
    if (node.content.kind === 'preview') {
      return {
        ...node,
        content: {
          kind: 'preview',
          selectedPreviewId: node.content.selectedPreviewId ?? null,
        },
      };
    }
    return node;
  }

  return {
    ...node,
    ratio: clampRatio(node.ratio),
    children: [normalizeNode(node.children[0]), normalizeNode(node.children[1])],
  };
}

export function serializeTileLayout(layout: TileLayout): string {
  return JSON.stringify({
    version: TILE_LAYOUT_VERSION,
    root: normalizeNode(layout.root),
  });
}

/** Migrate old tile kind names to current ones */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateNode(node: any): any {
  if (!node) return node;
  if (node.type === 'leaf' && node.content) {
    const KIND_MAP: Record<string, string> = {
      'bottom-terminal': 'contextual-panel',
      // Retired kinds — orchestrator/mission/history are no longer tiles;
      // they live as the Orchestrator tab inside WorkspaceTerminal. Migrate
      // any saved layouts using these kinds to a plain terminal leaf.
      thoughts: 'terminal',
      'mission-control': 'terminal',
      'orchestrator-history': 'terminal',
    };
    if (KIND_MAP[node.content.kind]) {
      node.content.kind = KIND_MAP[node.content.kind];
    }
  }
  if (node.children) {
    node.children = node.children.map(migrateNode);
  }
  return node;
}

export function deserializeTileLayout(raw: string | null | undefined): TileLayout | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { version?: unknown; root?: unknown };
    // Migrate old tile kinds BEFORE validation
    const migratedRoot = migrateNode(parsed.root);
    if (parsed.version !== TILE_LAYOUT_VERSION || !isTileNode(migratedRoot)) {
      return null;
    }
    return {
      version: TILE_LAYOUT_VERSION,
      root: normalizeNode(migratedRoot),
    };
  } catch {
    return null;
  }
}
