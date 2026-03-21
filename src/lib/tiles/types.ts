export type TileSplitDirection = 'horizontal' | 'vertical';

export type TileContentKind =
  | 'workspace'
  | 'terminal'
  | 'preview'
  | 'canvas'
  | 'thoughts'
  | 'bottom-terminal';

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
  kind: 'bottom-terminal';
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
  version: 1;
  root: TileNode;
}

export function isTileLeafNode(node: TileNode): node is TileLeafNode {
  return node.type === 'leaf';
}

export function isTileSplitNode(node: TileNode): node is TileSplitNode {
  return node.type === 'split';
}
