'use client';

import { trackPointerGesture } from '@/lib/ui/pointer-gesture';

/**
 * thread-drag — window-event bus for dragging a chat/thread row out of the
 * left rail and dropping it into the workspace as a split pane (Claude Code
 * split-screen parity). Pointer-event based on purpose: HTML5 drag-and-drop
 * is unreliable in the Tauri WKWebView (dragDropEnabled:false), so sources
 * run their own pointerdown → move-threshold → capture loop and publish
 * through these events. Consumers: ThreadDragGhost (cursor pill) and the
 * ThreadDropLayer inside OrchestratorTab (zone previews + drop action).
 */

export interface ThreadDragPayload {
  threadId: string;
  title: string;
  mode: 'orchestrator' | 'chat';
  repoPath?: string | null;
  sidebarItemId?: string;
  tabId?: string;
  workspaceId?: string | null;
  navigationOnly?: boolean;
}

export interface ThreadDragPoint {
  clientX: number;
  clientY: number;
}

export const THREAD_DRAG_START_EVENT = 'o8:thread-drag:start';
export const THREAD_DRAG_MOVE_EVENT = 'o8:thread-drag:move';
export const THREAD_DRAG_END_EVENT = 'o8:thread-drag:end';
export const THREAD_DRAG_CANCEL_EVENT = 'o8:thread-drag:cancel';

export interface ThreadDragStartDetail extends ThreadDragPoint {
  payload: ThreadDragPayload;
}

export type ThreadDragMoveDetail = ThreadDragPoint;

export type ThreadDragEndDetail = ThreadDragPoint;

let activePayload: ThreadDragPayload | null = null;

/** The payload of the drag currently in flight (null when idle). Lets a
 *  late-mounting drop layer sync without having seen the start event. */
export function getActiveThreadDrag(): ThreadDragPayload | null {
  return activePayload;
}

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Start tracking a potential drag from a row's pointerdown. Installs
 * document-level listeners; the drag only becomes real once the pointer
 * moves past `threshold` px (so plain clicks pass through untouched).
 * Returns a disposer the caller can invoke on unmount.
 *
 * The caller's click handler still fires on a plain click; once the drag
 * activates we call `preventClick` so the row's onClick can bail.
 */
export function trackThreadDrag(
  downEvent: { clientX: number; clientY: number; pointerId?: number },
  payload: ThreadDragPayload,
  options?: { threshold?: number; onActivate?: () => void; source?: HTMLElement },
): () => void {
  if (activePayload) return () => {};
  return trackPointerGesture(options?.source, downEvent, {
    threshold: options?.threshold,
    onStart: () => {
      activePayload = payload;
      options?.onActivate?.();
      emit(THREAD_DRAG_START_EVENT, { payload, clientX: downEvent.clientX, clientY: downEvent.clientY } satisfies ThreadDragStartDetail);
    },
    onMove: point => emit(THREAD_DRAG_MOVE_EVENT, { clientX: point.clientX, clientY: point.clientY } satisfies ThreadDragMoveDetail),
    onEnd: point => {
      activePayload = null;
      emit(THREAD_DRAG_END_EVENT, { clientX: point.clientX, clientY: point.clientY } satisfies ThreadDragEndDetail);
    },
    onCancel: () => { activePayload = null; emit(THREAD_DRAG_CANCEL_EVENT, null); },
  });
}
