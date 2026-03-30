'use client';

import type React from 'react';
import { memo, useCallback, useMemo, useRef } from 'react';
import { TileHeader } from '@/components/desktop/TileHeader';
import { countLeaves } from '@/lib/tiles/operations';
import type { TileContent, TileContentKind, TileLayout, TileLeafNode, TileNode, TileSplitDirection, TileSplitNode } from '@/lib/tiles/types';

export interface TileContentRenderProps<TContent extends TileContent = TileContent> {
  active: boolean;
  content: TContent;
  tileId: string;
}

export interface TileContentDefinition<TContent extends TileContent = TileContent> {
  description: string;
  label: string;
  render: (props: TileContentRenderProps<TContent>) => React.ReactNode;
  singleton?: boolean;
  /** If false, the tile cannot be closed by the user. Default: true */
  closable?: boolean;
  /** When true, the surface renders its own header chrome. */
  hideHeader?: boolean;
}

export type TileContentRegistry = Record<TileContentKind, TileContentDefinition>;

interface TileContainerProps {
  activeTileId: string | null;
  layout: TileLayout;
  registry: TileContentRegistry;
  onActivateTile: (tileId: string) => void;
  onCloseTile: (tileId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onSplitTile: (tileId: string, direction: TileSplitDirection) => void;
}

const HANDLE_SIZE = 8;

function ResizeHandle({
  direction,
  onMouseDown,
}: {
  direction: TileSplitDirection;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const isVertical = direction === 'vertical';

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={(e) => { const bar = e.currentTarget.firstElementChild as HTMLElement; if (bar) bar.style.opacity = '1'; }}
      onMouseLeave={(e) => { const bar = e.currentTarget.firstElementChild as HTMLElement; if (bar) bar.style.opacity = '0'; }}
      style={{
        width: isVertical ? HANDLE_SIZE : '100%',
        height: isVertical ? '100%' : HANDLE_SIZE,
        cursor: isVertical ? 'col-resize' : 'row-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        flexGrow: 0,
        position: 'relative',
        backgroundColor: 'transparent',
      }}
    >
      <div style={{
        width: isVertical ? 3 : 42,
        height: isVertical ? 42 : 3,
        borderRadius: 999,
        backgroundColor: 'var(--t-drag-handle)',
        opacity: 0,
        transition: 'opacity 150ms ease',
      }} />
    </div>
  );
}

const SplitView = memo(function SplitView({
  node,
  renderNode,
  onResizeSplit,
}: {
  node: TileSplitNode;
  onResizeSplit: (splitId: string, ratio: number) => void;
  renderNode: (node: TileNode) => React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isVertical = node.direction === 'vertical';

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();

    const handleMove = (moveEvent: MouseEvent) => {
      const ratio = isVertical
        ? (moveEvent.clientX - rect.left) / rect.width
        : (moveEvent.clientY - rect.top) / rect.height;
      onResizeSplit(node.id, ratio);
    };

    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [isVertical, node.id, onResizeSplit]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: isVertical ? 'row' : 'column',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: '0%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: isVertical ? `calc(${node.ratio * 100}% - ${HANDLE_SIZE / 2}px)` : '100%',
          height: isVertical ? '100%' : `calc(${node.ratio * 100}% - ${HANDLE_SIZE / 2}px)`,
          minWidth: isVertical ? 220 : 0,
          minHeight: isVertical ? 0 : 160,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {renderNode(node.children[0])}
      </div>

      <ResizeHandle direction={node.direction} onMouseDown={handleResizeStart} />

      <div
        style={{
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: '0%',
          minWidth: isVertical ? 220 : 0,
          minHeight: isVertical ? 0 : 160,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {renderNode(node.children[1])}
      </div>
    </div>
  );
});

export function TileContainer({
  activeTileId,
  layout,
  registry,
  onActivateTile,
  onCloseTile,
  onResizeSplit,
  onSplitTile,
}: TileContainerProps) {
  const totalLeaves = useMemo(() => countLeaves(layout.root), [layout.root]);

  function renderNode(node: TileNode): React.ReactNode {
    if (node.type === 'split') {
      return (
        <SplitView
          key={node.id}
          node={node}
          onResizeSplit={onResizeSplit}
          renderNode={renderNode}
        />
      );
    }

    return (
      <TileLeafView
        key={node.id}
        active={node.id === activeTileId}
        canClose={totalLeaves > 1}
        node={node}
        registry={registry}
        onActivateTile={onActivateTile}
        onCloseTile={onCloseTile}
        onSplitTile={onSplitTile}
      />
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: '0%',
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden',
      backgroundColor: '#ffffff',
    }}>
      {renderNode(layout.root)}
    </div>
  );
}

function TileLeafView({
  active,
  canClose,
  node,
  registry,
  onActivateTile,
  onCloseTile,
  onSplitTile,
}: {
  active: boolean;
  canClose: boolean;
  node: TileLeafNode;
  registry: TileContentRegistry;
  onActivateTile: (tileId: string) => void;
  onCloseTile: (tileId: string) => void;
  onSplitTile: (tileId: string, direction: TileSplitDirection) => void;
}) {
  const definition = registry[node.content.kind];

  return (
    <div
      data-testid={`tile-leaf-${node.id}`}
      data-tile-id={node.id}
      data-tile-kind={node.content.kind}
      data-tile-active={active ? 'true' : 'false'}
      onMouseDown={() => onActivateTile(node.id)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: '0%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        borderWidth: 0,
        borderStyle: 'none',
        borderColor: 'transparent',
        backgroundColor: 'transparent',
      }}
    >
      {!definition?.hideHeader && (
        <TileHeader
          label={definition?.label ?? 'Tile'}
          active={active}
          canClose={canClose}
          onSplitVertical={() => onSplitTile(node.id, 'vertical')}
          onSplitHorizontal={() => onSplitTile(node.id, 'horizontal')}
          onClose={() => onCloseTile(node.id)}
        />
      )}

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: '0%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}>
        {definition ? (
          definition.render({
            active,
            content: node.content,
            tileId: node.id,
          })
        ) : null}
      </div>
    </div>
  );
}
