'use client';

/**
 * ThreadDropLayer — drop-target overlay for drag-to-split (Claude Code
 * split-screen parity). Lives inside OrchestratorTab's chat-body wrapper
 * (position:relative) and activates while a thread drag is in flight.
 *
 * Zone grammar (from the reference video):
 * - Pane HEADER band  → REPLACE that pane ("Open here"): whole-pane inset
 *   border + tint. Replacing the main chat pane routes to loadThread.
 * - Pane BODY, right half        → SPLIT RIGHT ("Add split"): right-50%
 *   preview overlay.
 * - Pane BODY, left-bottom       → SPLIT BELOW ("Add split"): bottom-50%
 *   preview overlay.
 * - Pane BODY, left-top          → defaults to SPLIT RIGHT.
 * All transitions are instant — no easing on the preview, per the video.
 *
 * Coordinate note: pointer clientX/Y and getBoundingClientRect() are in the
 * SAME (zoom-multiplied) space in WKWebView, so ratio math here is zoom-safe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeSessionTileLayout,
  isSessionTileLeaf,
  type SessionTileLayout,
  type SessionTileLeaf,
  type SessionTileRect,
  type SessionTileSplitDirection,
  type ThreadPanePayload,
} from '@/lib/orchestrator/session-tiles';
import {
  getActiveThreadDrag,
  THREAD_DRAG_CANCEL_EVENT,
  THREAD_DRAG_END_EVENT,
  THREAD_DRAG_MOVE_EVENT,
  THREAD_DRAG_START_EVENT,
  type ThreadDragEndDetail,
  type ThreadDragMoveDetail,
  type ThreadDragStartDetail,
  type ThreadDragPayload,
} from '@/lib/workspace-terminal/thread-drag';

/** Height (px, CSS space) of the header band that means "replace". */
const HEADER_BAND_PX = 40;

export interface ThreadDropAction {
  kind: 'split' | 'replace' | 'replace-chat';
  leafId: string;
  direction: SessionTileSplitDirection;
  thread: ThreadPanePayload;
}

interface ThreadDropLayerProps {
  /** Only the active workspace tab may accept drops. */
  active: boolean;
  layout: SessionTileLayout;
  onDrop: (action: ThreadDropAction) => void;
}

interface HoverTarget {
  leafId: string;
  leafKind: SessionTileLeaf['kind'];
  leafRect: SessionTileRect;
  zone: 'replace' | 'split-right' | 'split-below';
}

function toPayload(payload: ThreadDragPayload): ThreadPanePayload {
  return { threadId: payload.threadId, title: payload.title, mode: payload.mode };
}

export function ThreadDropLayer({ active, layout, onDrop }: ThreadDropLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [dragPayload, setDragPayload] = useState<ThreadDragPayload | null>(null);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const hoverRef = useRef<HoverTarget | null>(null);
  const payloadRef = useRef<ThreadDragPayload | null>(null);

  const leaves = useMemo(() => {
    const root = layout.root;
    const { leafRects } = computeSessionTileLayout(root);
    const list: Array<{ leaf: SessionTileLeaf; rect: SessionTileRect }> = [];
    const walk = (node: typeof root): void => {
      if (isSessionTileLeaf(node)) {
        const rect = leafRects.get(node.id);
        if (rect) list.push({ leaf: node, rect });
        return;
      }
      walk(node.children[0]);
      walk(node.children[1]);
    };
    walk(root);
    return list;
  }, [layout.root]);
  const leavesRef = useRef(leaves);
  useEffect(() => {
    leavesRef.current = leaves;
  }, [leaves]);

  const resolveTarget = useCallback((clientX: number, clientY: number): HoverTarget | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    for (const { leaf, rect: leafRect } of leavesRef.current) {
      if (
        nx >= leafRect.left && nx <= leafRect.left + leafRect.width
        && ny >= leafRect.top && ny <= leafRect.top + leafRect.height
      ) {
        const leafTopPx = leafRect.top * rect.height;
        const withinLeafYPx = ny * rect.height - leafTopPx;
        if (withinLeafYPx <= HEADER_BAND_PX) {
          return { leafId: leaf.id, leafKind: leaf.kind, leafRect, zone: 'replace' };
        }
        const relX = (nx - leafRect.left) / leafRect.width;
        const relY = (ny - leafRect.top) / leafRect.height;
        if (relX >= 0.5) {
          return { leafId: leaf.id, leafKind: leaf.kind, leafRect, zone: 'split-right' };
        }
        if (relY >= 0.5) {
          return { leafId: leaf.id, leafKind: leaf.kind, leafRect, zone: 'split-below' };
        }
        return { leafId: leaf.id, leafKind: leaf.kind, leafRect, zone: 'split-right' };
      }
    }
    return null;
  }, []);

  useEffect(() => {
    if (!active) return;

    const applyHover = (next: HoverTarget | null) => {
      const prev = hoverRef.current;
      if (
        prev?.leafId === next?.leafId
        && prev?.zone === next?.zone
      ) return;
      hoverRef.current = next;
      setHover(next);
    };

    const handleStart = (event: Event) => {
      const detail = (event as CustomEvent<ThreadDragStartDetail>).detail;
      if (!detail?.payload) return;
      payloadRef.current = detail.payload;
      setDragPayload(detail.payload);
      applyHover(resolveTarget(detail.clientX, detail.clientY));
    };
    const handleMove = (event: Event) => {
      if (!payloadRef.current) return;
      const detail = (event as CustomEvent<ThreadDragMoveDetail>).detail;
      if (!detail) return;
      applyHover(resolveTarget(detail.clientX, detail.clientY));
    };
    const handleEnd = (event: Event) => {
      const payload = payloadRef.current;
      const detail = (event as CustomEvent<ThreadDragEndDetail>).detail;
      const target = payload && detail ? resolveTarget(detail.clientX, detail.clientY) : null;
      payloadRef.current = null;
      hoverRef.current = null;
      setDragPayload(null);
      setHover(null);
      if (!payload || !target) return;
      if (target.zone === 'replace') {
        onDrop({
          kind: target.leafKind === 'chat' ? 'replace-chat' : 'replace',
          leafId: target.leafId,
          direction: 'vertical',
          thread: toPayload(payload),
        });
        return;
      }
      onDrop({
        kind: 'split',
        leafId: target.leafId,
        direction: target.zone === 'split-below' ? 'horizontal' : 'vertical',
        thread: toPayload(payload),
      });
    };
    const handleCancel = () => {
      payloadRef.current = null;
      hoverRef.current = null;
      setDragPayload(null);
      setHover(null);
    };

    // A drag may already be in flight when this tab becomes active. Adopt it
    // on the next tick — a synchronous setState inside the effect body would
    // cascade a render before this commit settles.
    const inFlight = getActiveThreadDrag();
    let adoptTimer: number | null = null;
    if (inFlight) {
      payloadRef.current = inFlight;
      adoptTimer = window.setTimeout(() => setDragPayload(inFlight), 0);
    }

    window.addEventListener(THREAD_DRAG_START_EVENT, handleStart);
    window.addEventListener(THREAD_DRAG_MOVE_EVENT, handleMove);
    window.addEventListener(THREAD_DRAG_END_EVENT, handleEnd);
    window.addEventListener(THREAD_DRAG_CANCEL_EVENT, handleCancel);
    return () => {
      if (adoptTimer !== null) window.clearTimeout(adoptTimer);
      window.removeEventListener(THREAD_DRAG_START_EVENT, handleStart);
      window.removeEventListener(THREAD_DRAG_MOVE_EVENT, handleMove);
      window.removeEventListener(THREAD_DRAG_END_EVENT, handleEnd);
      window.removeEventListener(THREAD_DRAG_CANCEL_EVENT, handleCancel);
      payloadRef.current = null;
      hoverRef.current = null;
    };
  }, [active, onDrop, resolveTarget]);

  // The host div stays mounted even when idle (display stays cheap — it's
  // one empty absolutely-positioned div): hit-testing needs its rect from
  // the very first pointermove of a drag, a commit BEFORE React re-renders
  // with dragPayload set. Children only paint during a drag.
  const dragging = active && dragPayload !== null;
  const preview = dragging && hover ? computePreviewRect(hover) : null;
  const pillLabel = dragging && hover
    ? hover.zone === 'replace' ? 'Open here' : 'Add split'
    : null;

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 60,
        // The layer only OBSERVES pointer position via window events; it
        // must never intercept them, or panes underneath lose hover state.
        // NOTE: no display:none when idle — a display:none host returns a
        // zero rect and the first pointermove of a drag would miss.
        pointerEvents: 'none',
      }}
    >
      {preview ? (
        <div
          style={{
            position: 'absolute',
            left: `${preview.left * 100}%`,
            top: `${preview.top * 100}%`,
            width: `${preview.width * 100}%`,
            height: `${preview.height * 100}%`,
            borderRadius: 10,
            background: 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.18))',
            borderWidth: 2,
            borderStyle: 'solid',
            borderColor: 'var(--t-accent, #2563eb)',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {pillLabel ? (
            <div
              style={{
                paddingTop: 5,
                paddingBottom: 5,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 999,
                background: 'var(--t-accent, #2563eb)',
                color: '#ffffff',
                fontSize: 12,
                fontWeight: 600,
                boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
                whiteSpace: 'nowrap',
              }}
            >
              {pillLabel}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function computePreviewRect(hover: HoverTarget): SessionTileRect {
  const { leafRect, zone } = hover;
  if (zone === 'replace') {
    return leafRect;
  }
  if (zone === 'split-below') {
    return {
      left: leafRect.left,
      top: leafRect.top + leafRect.height / 2,
      width: leafRect.width,
      height: leafRect.height / 2,
    };
  }
  return {
    left: leafRect.left + leafRect.width / 2,
    top: leafRect.top,
    width: leafRect.width / 2,
    height: leafRect.height,
  };
}
