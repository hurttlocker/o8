export type TileSplitDirection = 'horizontal' | 'vertical';

export type TileContentKind =
  | 'workspace'
  | 'terminal'
  | 'preview'
  | 'thoughts'
  | 'contextual-panel'
  // Legacy — migrated on deserialization but kept for type compat
  | 'canvas';

export interface WorkspaceTileContent {
  kind: 'workspace';
}

export interface TerminalTileContent {
  kind: 'terminal';
}

export interface PreviewTileContent {
  kind: 'preview';
  selectedPreviewId?: string | null;
}

export interface CanvasTileContent {
  kind: 'canvas';
}

export interface ThoughtsTileContent {
  kind: 'thoughts';
}

export interface BottomTerminalTileContent {
  kind: 'contextual-panel';
}

export type TileContent =
  | WorkspaceTileContent
  | TerminalTileContent
  | PreviewTileContent
  | CanvasTileContent
  | ThoughtsTileContent
  | BottomTerminalTileContent;

export interface TileLeafNode {
  type: 'leaf';
  id: string;
  content: TileContent;
}

export interface TileSplitNode {
  type: 'split';
  id: string;
  direction: TileSplitDirection;
  ratio: number;
  children: [TileNode, TileNode];
}

export type TileNode = TileLeafNode | TileSplitNode;

export interface TileLayout {
  version: number;
  root: TileNode;
}

export function isTileLeafNode(node: TileNode): node is TileLeafNode {
  return node.type === 'leaf';
}

export function isTileSplitNode(node: TileNode): node is TileSplitNode {
  return node.type === 'split';
}
