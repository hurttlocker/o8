'use client';

import type React from 'react';
import { useCallback, useMemo, useRef } from 'react';
import { TileHeader } from '@/components/desktop/TileHeader';
import {
  collectLeafNodes,
  computeTileLayout,
  type TileRect,
  type TileSplitFrame,
} from '@/lib/tiles/operations';
import type {
  TileContent,
  TileContentKind,
  TileLayout,
  TileSplitDirection,
} from '@/lib/tiles/types';

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

/**
 * TileContainer — flat, absolutely-positioned tile renderer.
 *
 * The recursive tile tree is walked ONCE per layout change to produce a flat
 * list of (leafId → rect) + (splitId → handle frame). Every leaf is then
 * rendered as a direct sibling of the container, keyed by its leaf.id. When
 * the tree shape changes (splitting, wrapping, closing a sibling) the leaves
 * stay in the SAME React tree position — only their rect changes — so React
 * preserves component state for each leaf. Adding or removing the contextual
 * panel no longer remounts the workspace terminal above it.
 */
export function TileContainer({
  activeTileId,
  layout,
  registry,
  onActivateTile,
  onCloseTile,
  onResizeSplit,
  onSplitTile,
}: TileContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const { leaves, leafRects, splitFrames } = useMemo(() => {
    const { leafRects, splitFrames } = computeTileLayout(layout.root);
    const leaves = collectLeafNodes(layout.root);
    return { leaves, leafRects, splitFrames };
  }, [layout.root]);

  const totalLeaves = leaves.length;

  const makeResizeStart = useCallback(
    (splitId: string, direction: TileSplitDirection, containerRect: TileRect) =>
      (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const tileContainer = containerRef.current;
        if (!tileContainer) return;
        const outerRect = tileContainer.getBoundingClientRect();
        // Convert the split's percent-space container rect to pixels.
        // Drag positions are then interpreted as ratios within this pixel rect.
        const splitPixelRect = {
          left: outerRect.left + outerRect.width * containerRect.left,
          top: outerRect.top + outerRect.height * containerRect.top,
          width: outerRect.width * containerRect.width,
          height: outerRect.height * containerRect.height,
        };

        const handleMove = (moveEvent: MouseEvent) => {
          const ratio = direction === 'vertical'
            ? (moveEvent.clientX - splitPixelRect.left) / splitPixelRect.width
            : (moveEvent.clientY - splitPixelRect.top) / splitPixelRect.height;
          onResizeSplit(splitId, ratio);
        };

        const handleUp = () => {
          document.removeEventListener('mousemove', handleMove);
          document.removeEventListener('mouseup', handleUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };

        document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleUp);
      },
    [onResizeSplit],
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: '0%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        // Transparent so the dashboard chrome shows through any unclaimed
        // pixels (e.g. the hair-width handle strip between two leaves).
        backgroundColor: 'transparent',
      }}
    >
      {leaves.map((leaf) => {
        const rect = leafRects.get(leaf.id);
        if (!rect) return null;
        const definition = registry[leaf.content.kind];
        const isActive = leaf.id === activeTileId;
        return (
          <div
            key={leaf.id}
            data-testid={`tile-leaf-${leaf.id}`}
            data-tile-id={leaf.id}
            data-tile-kind={leaf.content.kind}
            data-tile-active={isActive ? 'true' : 'false'}
            onMouseDown={() => onActivateTile(leaf.id)}
            style={{
              position: 'absolute',
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              backgroundColor: 'transparent',
            }}
          >
            {!definition?.hideHeader && (
              <TileHeader
                label={definition?.label ?? 'Tile'}
                active={isActive}
                canClose={totalLeaves > 1}
                onSplitVertical={() => onSplitTile(leaf.id, 'vertical')}
                onSplitHorizontal={() => onSplitTile(leaf.id, 'horizontal')}
                onClose={() => onCloseTile(leaf.id)}
              />
            )}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: '0%',
                minWidth: 0,
                minHeight: 0,
                overflow: 'hidden',
              }}
            >
              {definition ? definition.render({
                active: isActive,
                content: leaf.content,
                tileId: leaf.id,
              }) : null}
            </div>
          </div>
        );
      })}

      {splitFrames.map((frame) => (
        <ResizeHandle
          key={frame.id}
          frame={frame}
          onMouseDown={makeResizeStart(frame.id, frame.direction, frame.container)}
        />
      ))}
    </div>
  );
}

function ResizeHandle({
  frame,
  onMouseDown,
}: {
  frame: TileSplitFrame;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const isVertical = frame.direction === 'vertical';
  const style: React.CSSProperties = isVertical
    ? {
        position: 'absolute',
        left: `calc(${frame.boundary.left * 100}% - ${HANDLE_SIZE / 2}px)`,
        top: `${frame.boundary.top * 100}%`,
        width: HANDLE_SIZE,
        height: `${frame.boundary.height * 100}%`,
        cursor: 'col-resize',
      }
    : {
        position: 'absolute',
        left: `${frame.boundary.left * 100}%`,
        top: `calc(${frame.boundary.top * 100}% - ${HANDLE_SIZE / 2}px)`,
        width: `${frame.boundary.width * 100}%`,
        height: HANDLE_SIZE,
        cursor: 'row-resize',
      };

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={(e) => {
        const bar = e.currentTarget.firstElementChild as HTMLElement | null;
        if (bar) bar.style.opacity = '1';
      }}
      onMouseLeave={(e) => {
        const bar = e.currentTarget.firstElementChild as HTMLElement | null;
        if (bar) bar.style.opacity = '0';
      }}
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
        zIndex: 10,
      }}
    >
      <div
        style={{
          width: isVertical ? 3 : 42,
          height: isVertical ? 42 : 3,
          borderRadius: 999,
          backgroundColor: 'var(--t-drag-handle)',
          opacity: 0,
          transition: 'opacity 150ms ease',
        }}
      />
    </div>
  );
}
