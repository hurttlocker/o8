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
  findThreadLeafByThreadId,
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
  /** Worker panes can move inside their own scroll region at compact sizes. */
  useRenderedLeafRects?: boolean;
}

interface HoverTarget {
  leafId: string;
  leafKind: SessionTileLeaf['kind'];
  leafRect: SessionTileRect;
  zone: 'replace' | 'split-right' | 'split-below';
}

function toPayload(payload: ThreadDragPayload): ThreadPanePayload {
  return {
    threadId: payload.threadId,
    title: payload.title,
    mode: payload.mode,
    repoPath: payload.repoPath ?? null,
  };
}

export function ThreadDropLayer({ active, layout, onDrop, useRenderedLeafRects = false }: ThreadDropLayerProps) {
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
    const surface = useRenderedLeafRects
      ? host.parentElement?.querySelector<HTMLElement>('[data-session-tile-surface]')
      : null;
    const renderedLeaves = surface
      ? new Map(Array.from(surface.querySelectorAll<HTMLElement>('[data-session-tile-leaf-id]'))
        .map((node) => [node.dataset.sessionTileLeafId, node] as const))
      : null;
    for (const { leaf, rect: leafRect } of leavesRef.current) {
      const rendered = renderedLeaves?.get(leaf.id)?.getBoundingClientRect();
      if (useRenderedLeafRects && !rendered) continue;
      const left = rendered?.left ?? rect.left + leafRect.left * rect.width;
      const top = rendered?.top ?? rect.top + leafRect.top * rect.height;
      const width = rendered?.width ?? leafRect.width * rect.width;
      const height = rendered?.height ?? leafRect.height * rect.height;
      if (width <= 0 || height <= 0) continue;
      if (clientX >= left && clientX <= left + width && clientY >= top && clientY <= top + height) {
        const visibleLeft = Math.max(left, rect.left);
        const visibleTop = Math.max(top, rect.top);
        const visibleRight = Math.min(left + width, rect.right);
        const visibleBottom = Math.min(top + height, rect.bottom);
        const visibleRect: SessionTileRect = {
          left: (visibleLeft - rect.left) / rect.width,
          top: (visibleTop - rect.top) / rect.height,
          width: (visibleRight - visibleLeft) / rect.width,
          height: (visibleBottom - visibleTop) / rect.height,
        };
        if (leaf.threadId && leaf.threadId === payloadRef.current?.threadId) return null;
        const withinLeafYPx = clientY - top;
        if (withinLeafYPx <= HEADER_BAND_PX) {
          return { leafId: leaf.id, leafKind: leaf.kind, leafRect: visibleRect, zone: 'replace' };
        }
        const relX = (clientX - left) / width;
        const relY = (clientY - top) / height;
        if (relX >= 0.5) {
          return { leafId: leaf.id, leafKind: leaf.kind, leafRect: visibleRect, zone: 'split-right' };
        }
        if (relY >= 0.5) {
          return { leafId: leaf.id, leafKind: leaf.kind, leafRect: visibleRect, zone: 'split-below' };
        }
        return { leafId: leaf.id, leafKind: leaf.kind, leafRect: visibleRect, zone: 'split-right' };
      }
    }
    return null;
  }, [useRenderedLeafRects]);

  useEffect(() => {
    if (!active) return;

    const applyHover = (next: HoverTarget | null) => {
      const prev = hoverRef.current;
      if (
        prev?.leafId === next?.leafId
        && prev?.zone === next?.zone
        && prev?.leafRect.left === next?.leafRect.left
        && prev?.leafRect.top === next?.leafRect.top
        && prev?.leafRect.width === next?.leafRect.width
        && prev?.leafRect.height === next?.leafRect.height
      ) return;
      hoverRef.current = next;
      setHover(next);
    };

    let lastPoint: ThreadDragMoveDetail | null = null;
    let scrollFrame: number | null = null;
    const stopScrollRefresh = () => {
      lastPoint = null;
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    };
    const handleScroll = () => {
      if (!payloadRef.current || !lastPoint || scrollFrame !== null) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        if (payloadRef.current && lastPoint) applyHover(resolveTarget(lastPoint.clientX, lastPoint.clientY));
      });
    };

    const handleStart = (event: Event) => {
      const detail = (event as CustomEvent<ThreadDragStartDetail>).detail;
      if (!detail?.payload || detail.payload.navigationOnly) return;
      stopScrollRefresh();
      lastPoint = detail;
      payloadRef.current = detail.payload;
      setDragPayload(detail.payload);
      applyHover(resolveTarget(detail.clientX, detail.clientY));
    };
    const handleMove = (event: Event) => {
      if (!payloadRef.current) return;
      const detail = (event as CustomEvent<ThreadDragMoveDetail>).detail;
      if (!detail) return;
      lastPoint = detail;
      applyHover(resolveTarget(detail.clientX, detail.clientY));
    };
    const handleEnd = (event: Event) => {
      const payload = payloadRef.current;
      const detail = (event as CustomEvent<ThreadDragEndDetail>).detail;
      const target = payload && detail ? resolveTarget(detail.clientX, detail.clientY) : null;
      stopScrollRefresh();
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
      stopScrollRefresh();
      payloadRef.current = null;
      hoverRef.current = null;
      setDragPayload(null);
      setHover(null);
    };

    // A drag may already be in flight when this tab becomes active. Adopt it
    // on the next tick — a synchronous setState inside the effect body would
    // cascade a render before this commit settles. And when NO drag is in
    // flight, clear any stale state: a tab-switch mid-drag deactivates this
    // layer before the end event arrives, and without the clear the frozen
    // "Add split"/"Open here" overlay re-renders on switch-back.
    const inFlight = getActiveThreadDrag();
    let adoptTimer: number | null = null;
    if (inFlight && !inFlight.navigationOnly) {
      payloadRef.current = inFlight;
      adoptTimer = window.setTimeout(() => setDragPayload(inFlight), 0);
    } else {
      payloadRef.current = null;
      hoverRef.current = null;
      adoptTimer = window.setTimeout(() => {
        setDragPayload(null);
        setHover(null);
      }, 0);
    }

    window.addEventListener(THREAD_DRAG_START_EVENT, handleStart);
    window.addEventListener(THREAD_DRAG_MOVE_EVENT, handleMove);
    window.addEventListener(THREAD_DRAG_END_EVENT, handleEnd);
    window.addEventListener(THREAD_DRAG_CANCEL_EVENT, handleCancel);
    // Scroll does not bubble. Capture only this surface's nested scrolls and
    // re-hit-test the last pointer at most once per frame, without polling.
    const scrollHost = useRenderedLeafRects ? hostRef.current?.parentElement : null;
    scrollHost?.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      stopScrollRefresh();
      scrollHost?.removeEventListener('scroll', handleScroll, true);
      if (adoptTimer !== null) window.clearTimeout(adoptTimer);
      window.removeEventListener(THREAD_DRAG_START_EVENT, handleStart);
      window.removeEventListener(THREAD_DRAG_MOVE_EVENT, handleMove);
      window.removeEventListener(THREAD_DRAG_END_EVENT, handleEnd);
      window.removeEventListener(THREAD_DRAG_CANCEL_EVENT, handleCancel);
      payloadRef.current = null;
      hoverRef.current = null;
    };
  }, [active, onDrop, resolveTarget, useRenderedLeafRects]);

  // The host div stays mounted even when idle (display stays cheap — it's
  // one empty absolutely-positioned div): hit-testing needs its rect from
  // the very first pointermove of a drag, a commit BEFORE React re-renders
  // with dragPayload set. Children only paint during a drag.
  const dragging = active && dragPayload !== null;
  const preview = dragging && hover ? computePreviewRect(hover) : null;
  const moving = dragPayload ? Boolean(findThreadLeafByThreadId(layout.root, dragPayload.threadId)) : false;
  const pillLabel = dragging && hover ? hover.zone === 'replace' ? moving ? 'Swap panes' : 'Open here'
    : `${moving ? 'Move' : 'Open'} ${hover.zone === 'split-below' ? 'below' : 'beside'}` : null;

  return (
    <div
      ref={hostRef}
      data-thread-drop-layer="true"
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
            background: 'var(--t-accent-soft)',
            borderWidth: 1,
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
                background: 'var(--t-panel-solid)',
                border: '1px solid var(--t-border)',
                color: 'var(--t-text)',
                fontSize: 12,
                fontWeight: 300,
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
