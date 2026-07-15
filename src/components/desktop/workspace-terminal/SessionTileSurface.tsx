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
import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { SessionTranscriptPane } from '@/components/desktop/SessionTranscriptPane';
import { ThreadChatPane } from '@/components/desktop/workspace-terminal/ThreadChatPane';
import {
  collectAllLeaves,
  computeSessionTileLayout,
  type SessionTileLayout,
  type SessionTileRect,
  type SessionTileSplitDirection,
  type SessionTileSplitFrame,
} from '@/lib/orchestrator/session-tiles';

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

  const { leaves, leafRects, splitFrames } = useMemo(() => {
    const { leafRects, splitFrames } = computeSessionTileLayout(layout.root);
    const leaves = collectAllLeaves(layout.root);
    return { leaves, leafRects, splitFrames };
  }, [layout.root]);

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
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        background: 'var(--t-chat-surface-bg, #ffffff)',
      }}
    >
      {leaves.map((leaf) => {
        const rect = leafRects.get(leaf.id);
        if (!rect) return null;
        return (
          <div
            key={leaf.id}
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
              transition: 'left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1), width 220ms cubic-bezier(0.22, 1, 0.36, 1), height 220ms cubic-bezier(0.22, 1, 0.36, 1)',
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
                  repoPath={repoPath}
                  onClose={() => onCloseLeaf(leaf.id)}
                />
              </div>
            ) : leaf.sessionKey ? (
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
