'use client';

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TileHeader } from '@/components/desktop/TileHeader';
import { HeaderPillStrip } from '@/components/desktop/shell/WorkspaceHeaderStrip';
import { SplitPaneCloseButton } from '@/components/desktop/shell/SplitPaneCloseButton';
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
  paneLabels?: ReadonlyMap<string, string>;
  paneSessions?: ReadonlyMap<string, {
    workspaceId: string;
    tabs: Array<{ id: string; label: string; kind: string; runtime: string | null; packetStatus: string | null }>;
    activeTabId: string | null;
    finishedTabCount: number;
  }>;
  layout: TileLayout;
  registry: TileContentRegistry;
  onActivateTile: (tileId: string) => void;
  onCloseTile: (tileId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onSplitTile: (tileId: string, direction: TileSplitDirection, initialTab?: WorkspaceTabDragKind, placeBefore?: boolean, exactPlacement?: boolean) => void;
}

const HANDLE_SIZE = 12;
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
  paneLabels,
  paneSessions,
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
  const allTerminalPanes = leaves.every((leaf) => leaf.content.kind === 'terminal');
  const showPaneHeader = allTerminalPanes && totalLeaves > 1;

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
      data-pane-layout="split"
      style={{
        position: 'relative',
        display: 'block',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: '0%',
        minWidth: 0,
        minHeight: 0,
        overflowX: 'hidden',
        overflowY: 'hidden',
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
        const paneSession = paneSessions?.get(leaf.id);
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
              onSplitTile(leaf.id, zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal', kind, zone === 'left' || zone === 'above', true);
            }}
            style={{
              position: 'absolute',
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              paddingLeft: padLeft,
              paddingRight: padRight,
              paddingTop: padTop,
              paddingBottom: padBottom,
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
                borderTopLeftRadius: radiusTL,
                borderTopRightRadius: radiusTR,
                borderBottomLeftRadius: radiusBL,
                borderBottomRightRadius: radiusBR,
                backgroundColor: 'var(--t-bg, transparent)',
              }}
            >
              {showPaneHeader ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, minHeight: 34, paddingLeft: 12, paddingRight: 8, borderBottom: '1px solid var(--t-divider-subtle)', color: 'var(--t-text-secondary)', fontSize: 11, fontFamily: 'var(--font-sans-system)' }}>
                  <span style={{ flexShrink: 0, fontWeight: isActive ? 500 : 300, color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)' }}>Pane {index + 1}</span>
                  {paneSession && paneSession.tabs.length > 1 ? (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <HeaderPillStrip
                        tabs={paneSession.tabs}
                        activeTabId={paneSession.activeTabId}
                        workspaceId={paneSession.workspaceId}
                        finishedTabCount={paneSession.finishedTabCount}
                        ariaLabel={`Open sessions in pane ${index + 1}`}
                      />
                    </div>
                  ) : <span title={paneLabels?.get(leaf.id) ?? undefined} style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontWeight: 300 }}>· {paneLabels?.get(leaf.id) ?? 'New session'}</span>}
                  <SplitPaneCloseButton onClick={() => onCloseTile(leaf.id)} paneLabel={`pane ${index + 1}`} />
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

      {splitFrames.map((frame) => (
        <ResizeHandle
          key={frame.id}
          frame={frame}
          onMouseDown={makeResizeStart(frame.id, frame.direction, frame.container)}
          onResize={(ratio) => onResizeSplit(frame.id, ratio)}
        />
      ))}
    </div>
  );
}

function ResizeHandle({
  frame,
  onMouseDown,
  onResize,
}: {
  frame: TileSplitFrame;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onResize: (ratio: number) => void;
}) {
  const isVertical = frame.direction === 'vertical';
  const ratio = isVertical
    ? (frame.boundary.left - frame.container.left) / frame.container.width
    : (frame.boundary.top - frame.container.top) / frame.container.height;
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
      role="separator"
      aria-label="Resize terminal panes"
      aria-orientation={isVertical ? 'vertical' : 'horizontal'}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={(event) => {
        const step = isVertical
          ? (event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0)
          : (event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0);
        if (!step) return;
        event.preventDefault();
        onResize(ratio + step);
      }}
      onMouseEnter={(e) => {
        const bar = e.currentTarget.lastElementChild as HTMLElement | null;
        if (bar) bar.style.opacity = '1';
      }}
      onMouseLeave={(e) => {
        const bar = e.currentTarget.lastElementChild as HTMLElement | null;
        if (bar) bar.style.opacity = '0.65';
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
      <div aria-hidden style={{ position: 'absolute', width: isVertical ? 1 : '100%', height: isVertical ? '100%' : 1, backgroundColor: 'var(--t-divider-subtle)', pointerEvents: 'none' }} />
      <div
        style={{
          width: isVertical ? 3 : 42,
          height: isVertical ? 42 : 3,
          borderRadius: 999,
          backgroundColor: 'var(--t-drag-handle)',
          opacity: 0.65,
          transition: 'opacity 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
    </div>
  );
}
