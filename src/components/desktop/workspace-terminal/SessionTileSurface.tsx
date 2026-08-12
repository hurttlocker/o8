'use client';

/**
 * SessionTileSurface — recursive renderer for the orchestrator session tile
 * tree (issue #663). Each leaf hosts either the orchestrator chat (rendered
 * via the `chatSlot` prop) or a SessionTranscriptPane.
 *
 * Mirrors TileContainer's flat-render strategy: walks the tree once per
 * layout change, computes a leaf rect map, then renders every leaf as an
 * absolutely-positioned sibling of the container so React preserves
 * component state across split/resize/close changes.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ConnectedLiveSessionMesh, projectLiveSessionMeshParticipants } from '@/components/desktop/workspace-terminal/LiveSessionMesh';
import { SessionTranscriptPane } from '@/components/desktop/SessionTranscriptPane';
export { projectLiveSessionMeshParticipants };
import { ThreadChatPane } from '@/components/desktop/workspace-terminal/ThreadChatPane';
import {
  collectAllLeaves,
  computeSessionTileLayout,
  type SessionTileLayout,
  type SessionTileRect,
  type SessionTileSplitDirection,
  type SessionTileSplitFrame,
} from '@/lib/orchestrator/session-tiles';
import { collectSessionTileMeshGroups } from '@/lib/orchestrator/session-tile-mesh';

interface SessionTileSurfaceProps {
  layout: SessionTileLayout;
  focusedSessionKey: string | null;
  chatSlot: ReactNode;
  /** Repo scope inherited by thread panes (drag-to-split). */
  repoPath?: string | null;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onCloseLeaf: (leafId: string) => void;
  onFocusSession: (sessionKey: string) => void;
}

const HANDLE_SIZE = 8;
const MORPH_TRANSITION = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';

export function SessionTileSurface({
  layout,
  focusedSessionKey,
  chatSlot,
  repoPath,
  onResizeSplit,
  onCloseLeaf,
  onFocusSession,
}: SessionTileSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Track listeners so we can remove them on unmount-during-drag (issue #818).
  const dragListenersRef = useRef<{
    handleMove: (event: MouseEvent) => void;
    handleUp: () => void;
  } | null>(null);

  // Cleanup: if component unmounts while a drag is in progress, reset the
  // body cursor and remove any dangling document listeners so they don't
  // persist after the surface is gone.
  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (dragListenersRef.current) {
        document.removeEventListener('mousemove', dragListenersRef.current.handleMove);
        document.removeEventListener('mouseup', dragListenersRef.current.handleUp);
        dragListenersRef.current = null;
      }
    };
  }, []);

  const { leaves, leafRects, splitFrames, meshFrames, meshedLeafIds } = useMemo(() => {
    const { leafRects, splitFrames } = computeSessionTileLayout(layout.root);
    const leaves = collectAllLeaves(layout.root);
    const meshGroups = collectSessionTileMeshGroups(layout.root);
    const meshedLeafIds = new Set(meshGroups.flatMap((group) => (
      group.leaves.map((leaf) => leaf.id)
    )));
    const meshFrames = meshGroups.flatMap((group) => {
      const rects = group.leaves
        .map((leaf) => leafRects.get(leaf.id))
        .filter((rect): rect is SessionTileRect => Boolean(rect));
      if (rects.length === 0) return [];
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.left + rect.width));
      const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
      return [{
        ...group,
        rect: { left, top, width: right - left, height: bottom - top },
      }];
    });
    const internalMeshSplitIds = new Set(
      meshGroups.flatMap((group) => group.internalSplitIds),
    );
    return {
      leaves,
      leafRects,
      splitFrames: splitFrames.filter((frame) => !internalMeshSplitIds.has(frame.id)),
      meshFrames,
      meshedLeafIds,
    };
  }, [layout.root]);

  // FLIP morph (motion audit 003): the percentage rect stays the resting
  // layout — untransitioned, so a live terminal never relayouts mid-tween —
  // and a split/merge is played back as a transform-only tween from the old
  // box to the new one. Split-handle drags change ratios only; those snap so
  // the panes track the handle instead of lagging a tween behind it.
  const leafNodesRef = useRef(new Map<string, HTMLDivElement>());
  const prevRectsRef = useRef<Map<string, SessionTileRect> | null>(null);

  useLayoutEffect(() => {
    const prev = prevRectsRef.current;
    prevRectsRef.current = leafRects;
    const container = containerRef.current;
    if (!prev || !container) return;

    const structural = prev.size !== leafRects.size
      || Array.from(leafRects.keys()).some((id) => !prev.has(id));
    if (!structural) return;

    const box = container.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;

    const morphing: HTMLDivElement[] = [];
    leafRects.forEach((rect, id) => {
      const before = prev.get(id);
      const node = leafNodesRef.current.get(id);
      if (!before || !node || rect.width <= 0 || rect.height <= 0) return;
      const dx = (before.left - rect.left) * box.width;
      const dy = (before.top - rect.top) * box.height;
      const sx = before.width / rect.width;
      const sy = before.height / rect.height;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return;
      node.style.transition = 'none';
      node.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      morphing.push(node);
    });
    if (morphing.length === 0) return;

    const frame = requestAnimationFrame(() => {
      for (const node of morphing) {
        node.style.transition = MORPH_TRANSITION;
        node.style.transform = 'none';
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const node of morphing) {
        node.style.transition = '';
        node.style.transform = '';
      }
    };
  }, [leafRects]);

  useEffect(() => {
    const meshed = new Set(meshFrames.flatMap((mesh) => (
      mesh.leaves.map((leaf) => leaf.id)
    )));
    for (const leafId of meshed) leafNodesRef.current.delete(leafId);
  }, [meshFrames]);

  const makeResizeStart = useCallback(
    (splitId: string, direction: SessionTileSplitDirection, container: SessionTileRect) =>
      (event: ReactMouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const surface = containerRef.current;
        if (!surface) return;
        const rect = surface.getBoundingClientRect();
        const splitPx = {
          left: rect.left + rect.width * container.left,
          top: rect.top + rect.height * container.top,
          width: rect.width * container.width,
          height: rect.height * container.height,
        };
        const handleMove = (moveEvent: MouseEvent) => {
          const ratio = direction === 'vertical'
            ? (moveEvent.clientX - splitPx.left) / splitPx.width
            : (moveEvent.clientY - splitPx.top) / splitPx.height;
          onResizeSplit(splitId, ratio);
        };
        const handleUp = () => {
          document.removeEventListener('mousemove', handleMove);
          document.removeEventListener('mouseup', handleUp);
          dragListenersRef.current = null;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
        dragListenersRef.current = { handleMove, handleUp };
        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleUp);
      },
    [onResizeSplit],
  );

  return (
    <div
      ref={containerRef}
      data-session-tile-surface="true"
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        background: 'var(--t-chat-surface-bg, #ffffff)',
      }}
    >
      {leaves.filter((leaf) => !meshedLeafIds.has(leaf.id)).map((leaf) => {
        const rect = leafRects.get(leaf.id);
        if (!rect) return null;
        return (
          <div
            key={leaf.id}
            ref={(node) => {
              if (node) leafNodesRef.current.set(leaf.id, node);
              else leafNodesRef.current.delete(leaf.id);
            }}
            style={{
              position: 'absolute',
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
              transformOrigin: 'top left',
            }}
          >
            {leaf.kind === 'chat' ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {chatSlot}
              </div>
            ) : leaf.kind === 'thread' && leaf.threadId ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  paddingTop: 8,
                  paddingRight: 8,
                  paddingBottom: 8,
                  paddingLeft: 8,
                }}
              >
                <ThreadChatPane
                  threadId={leaf.threadId}
                  title={leaf.title ?? 'Chat'}
                  mode={leaf.mode ?? 'orchestrator'}
                  // The dragged thread's ORIGIN repo wins — the rail lists
                  // history across repos, and a pane scoped to the host
                  // tab's repo would mis-attribute its sends/dispatch.
                  repoPath={leaf.repoPath ?? repoPath}
                  onClose={() => onCloseLeaf(leaf.id)}
                />
              </div>
            ) : leaf.kind === 'session' && leaf.sessionKey ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  paddingTop: 8,
                  paddingRight: 8,
                  paddingBottom: 8,
                  paddingLeft: 8,
                }}
              >
                <SessionTranscriptPane
                  sessionKey={leaf.sessionKey}
                  focused={focusedSessionKey === leaf.sessionKey}
                  onFocus={onFocusSession}
                  onClose={() => onCloseLeaf(leaf.id)}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      {meshFrames.map((mesh) => (
        <div
          key={`mesh-${mesh.id}`}
          data-live-session-mesh-region={mesh.id}
          style={{
            position: 'absolute',
            left: `${mesh.rect.left * 100}%`,
            top: `${mesh.rect.top * 100}%`,
            width: `${mesh.rect.width * 100}%`,
            height: `${mesh.rect.height * 100}%`,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          <ConnectedLiveSessionMesh
            leaves={mesh.leaves}
            focusedSessionKey={focusedSessionKey}
            onFocusSession={onFocusSession}
            onCloseLeaf={onCloseLeaf}
          />
        </div>
      ))}
      {splitFrames.map((frame) => (
        <SessionResizeHandle
          key={frame.id}
          frame={frame}
          onMouseDown={makeResizeStart(frame.id, frame.direction, frame.container)}
        />
      ))}
    </div>
  );
}

function SessionResizeHandle({
  frame,
  onMouseDown,
}: {
  frame: SessionTileSplitFrame;
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const isVertical = frame.direction === 'vertical';
  const style: CSSProperties = isVertical
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
      aria-orientation={isVertical ? 'vertical' : 'horizontal'}
      aria-label={`Resize ${isVertical ? 'columns' : 'rows'}`}
      data-session-resize-handle={frame.id}
      data-session-resize-direction={frame.direction}
      onMouseDown={onMouseDown}
      onMouseEnter={(event) => {
        const bar = event.currentTarget.firstElementChild as HTMLElement | null;
        if (bar) bar.style.opacity = '1';
      }}
      onMouseLeave={(event) => {
        const bar = event.currentTarget.firstElementChild as HTMLElement | null;
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
          backgroundColor: 'var(--t-drag-handle, var(--t-border))',
          opacity: 0,
          transition: 'opacity 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
    </div>
  );
}
