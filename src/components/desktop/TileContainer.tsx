'use client';

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TileHeader } from '@/components/desktop/TileHeader';
import { HeaderPlayButton } from '@/components/desktop/shell/HeaderPlayButton';
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
import { WORKSPACE_TAB_DRAG_TYPE, workspaceTabDropZone, type WorkspaceTabDragKind, type WorkspaceTabDropZone } from '@/lib/tiles/workspace-tab-drag';

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
  gridMode?: boolean;
  layout: TileLayout;
  registry: TileContentRegistry;
  onActivateTile: (tileId: string) => void;
  onCloseTile: (tileId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onSplitTile: (tileId: string, direction: TileSplitDirection, initialTab?: WorkspaceTabDragKind, placeBefore?: boolean) => void;
}

const HANDLE_SIZE = 8;
// Per-leaf gap + squircle. Each leaf gets HALF the gap as inner padding on
// every edge that faces a sibling, so the sum of two adjacent paddings
// equals LEAF_GAP. Corners that face a gap get rounded; corners flush
// against the workspace edge stay square so the leaves align with the
// surrounding chrome.
const LEAF_GAP = 10;
const LEAF_RADIUS = 14;

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
  gridMode = false,
  layout,
  registry,
  onActivateTile,
  onCloseTile,
  onResizeSplit,
  onSplitTile,
}: TileContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tabDrop, setTabDrop] = useState<{ tileId: string; zone: WorkspaceTabDropZone } | null>(null);

  useEffect(() => {
    const clearDropPreview = () => setTabDrop(null);
    window.addEventListener('dragend', clearDropPreview);
    return () => window.removeEventListener('dragend', clearDropPreview);
  }, []);

  const { leaves, leafRects, splitFrames } = useMemo(() => {
    const { leafRects, splitFrames } = computeTileLayout(layout.root);
    const leaves = collectLeafNodes(layout.root);
    return { leaves, leafRects, splitFrames };
  }, [layout.root]);

  const totalLeaves = leaves.length;
  const showGrid = gridMode && totalLeaves > 1 && leaves.every((leaf) => leaf.content.kind === 'terminal');

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
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTabDrop(null);
      }}
      // Paint anchor for the pre-ship boot gate: the workspace subtree only
      // carries this once TileContainer actually renders, so a white-screen /
      // empty render can't report healthy. See DashboardHydrationMarker.
      data-o8-workspace="1"
      data-pane-layout={showGrid ? 'grid' : 'split'}
      style={{
        position: 'relative',
        display: showGrid ? 'grid' : 'block',
        gridTemplateColumns: showGrid ? 'repeat(auto-fit, minmax(min(560px, 100%), 1fr))' : undefined,
        gridAutoRows: showGrid ? (totalLeaves === 2 ? 'minmax(360px, 1fr)' : 'minmax(360px, 55vh)') : undefined,
        alignContent: showGrid ? 'start' : undefined,
        gap: showGrid ? LEAF_GAP : undefined,
        padding: showGrid ? LEAF_GAP : undefined,
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: '0%',
        minWidth: 0,
        minHeight: 0,
        overflowX: 'hidden',
        overflowY: showGrid ? 'auto' : 'hidden',
        // Transparent so the dashboard chrome shows through any unclaimed
        // pixels (e.g. the hair-width handle strip between two leaves).
        backgroundColor: 'transparent',
      }}
    >
      {leaves.map((leaf, index) => {
        const rect = leafRects.get(leaf.id);
        if (!rect) return null;
        const definition = registry[leaf.content.kind];
        const isActive = leaf.id === activeTileId;
        // Per-edge: half the gap on edges facing siblings; zero on edges
        // flush with the workspace boundary. Adjacent leaves contribute
        // half + half = LEAF_GAP visible in the middle, fully transparent
        // so the chrome shows through.
        const epsilon = 0.001;
        const halfGap = LEAF_GAP / 2;
        const padLeft = rect.left > epsilon ? halfGap : 0;
        const padRight = rect.left + rect.width < 1 - epsilon ? halfGap : 0;
        const padTop = rect.top > epsilon ? halfGap : 0;
        const padBottom = rect.top + rect.height < 1 - epsilon ? halfGap : 0;
        // Round only corners adjacent to a gap so the leaves keep the
        // workspace boundary crisp.
        const radiusTL = (padTop || padLeft) ? LEAF_RADIUS : 0;
        const radiusTR = (padTop || padRight) ? LEAF_RADIUS : 0;
        const radiusBL = (padBottom || padLeft) ? LEAF_RADIUS : 0;
        const radiusBR = (padBottom || padRight) ? LEAF_RADIUS : 0;
        return (
          <div
            key={leaf.id}
            data-testid={`tile-leaf-${leaf.id}`}
            data-tile-id={leaf.id}
            data-tile-kind={leaf.content.kind}
            data-tile-active={isActive ? 'true' : 'false'}
            onMouseDown={() => onActivateTile(leaf.id)}
            onDragOver={(event) => {
              if (leaf.content.kind !== 'terminal' || !Array.from(event.dataTransfer.types).includes(WORKSPACE_TAB_DRAG_TYPE)) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'copy';
              const zone = workspaceTabDropZone(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
              setTabDrop((current) => current?.tileId === leaf.id && current.zone === zone
                ? current : { tileId: leaf.id, zone });
            }}
            onDropCapture={(event) => {
              if (leaf.content.kind !== 'terminal') return;
              const kind = event.dataTransfer.getData(WORKSPACE_TAB_DRAG_TYPE);
              if (kind !== 'chat' && kind !== 'terminal') return;
              event.preventDefault();
              event.stopPropagation();
              setTabDrop(null);
              const zone = workspaceTabDropZone(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
              if (zone === 'center') {
                window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', {
                  detail: { kind: kind === 'chat' ? 'orchestrator' : 'terminal', tileId: leaf.id },
                }));
                return;
              }
              onSplitTile(leaf.id, zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal', kind, zone === 'left' || zone === 'above');
            }}
            style={{
              position: showGrid ? 'relative' : 'absolute',
              left: showGrid ? undefined : `${rect.left * 100}%`,
              top: showGrid ? undefined : `${rect.top * 100}%`,
              width: showGrid ? '100%' : `${rect.width * 100}%`,
              height: showGrid ? '100%' : `${rect.height * 100}%`,
              paddingLeft: showGrid ? 0 : padLeft,
              paddingRight: showGrid ? 0 : padRight,
              paddingTop: showGrid ? 0 : padTop,
              paddingBottom: showGrid ? 0 : padBottom,
              boxSizing: 'border-box',
              backgroundColor: 'transparent',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                borderTopLeftRadius: showGrid ? LEAF_RADIUS : radiusTL,
                borderTopRightRadius: showGrid ? LEAF_RADIUS : radiusTR,
                borderBottomLeftRadius: showGrid ? LEAF_RADIUS : radiusBL,
                borderBottomRightRadius: showGrid ? LEAF_RADIUS : radiusBR,
                backgroundColor: 'var(--t-bg, transparent)',
              }}
            >
              {showGrid ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, minHeight: 34, paddingLeft: 12, paddingRight: 8, borderBottom: '1px solid var(--t-divider-subtle)', color: 'var(--t-text-secondary)', fontSize: 11, fontFamily: 'var(--font-sans-system)' }}>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: isActive ? 600 : 400, color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)' }}>Pane {index + 1}</span>
                  <HeaderPlayButton
                    ariaSuffix={`pane ${index + 1}`}
                    gridMode
                    onSpawnChat={() => window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind: 'orchestrator', tileId: leaf.id } }))}
                    onSpawnTerminal={() => window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind: 'terminal', tileId: leaf.id } }))}
                    onSplitTab={(kind, direction) => onSplitTile(leaf.id, direction === 'right' ? 'vertical' : 'horizontal', kind)}
                  />
                  <button type="button" aria-label={`Close pane ${index + 1}`} title="Close pane" onClick={() => onCloseTile(leaf.id)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderWidth: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden><path d="M5 5l14 14M19 5 5 19" /></svg>
                  </button>
                </div>
              ) : !definition?.hideHeader && (
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
              {tabDrop?.tileId === leaf.id ? (
                <div aria-hidden style={{
                  position: 'absolute',
                  left: tabDrop.zone === 'right' ? '55%' : 0,
                  top: tabDrop.zone === 'below' ? '55%' : 0,
                  width: tabDrop.zone === 'left' ? '45%' : tabDrop.zone === 'right' ? '45%' : '100%',
                  height: tabDrop.zone === 'above' ? '45%' : tabDrop.zone === 'below' ? '45%' : '100%',
                  background: 'color-mix(in srgb, var(--t-accent) 13%, transparent)',
                  boxShadow: 'inset 0 0 0 1px var(--t-accent)',
                  borderRadius: 12,
                  pointerEvents: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--t-text)',
                  fontSize: 13,
                  zIndex: 20,
                }}>Open {tabDrop.zone === 'center' ? 'in this pane' : tabDrop.zone === 'above' ? 'above' : tabDrop.zone}</div>
              ) : null}
            </div>
          </div>
        );
      })}

      {!showGrid && splitFrames.map((frame) => (
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
          transition: 'opacity 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
    </div>
  );
}
