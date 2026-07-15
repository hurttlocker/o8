'use client';

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
  options?: { threshold?: number; onActivate?: () => void },
): () => void {
  const threshold = options?.threshold ?? 6;
  const startX = downEvent.clientX;
  const startY = downEvent.clientY;
  let active = false;
  let disposed = false;

  const handleMove = (event: PointerEvent) => {
    if (disposed) return;
    if (!active) {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (dx * dx + dy * dy < threshold * threshold) return;
      active = true;
      activePayload = payload;
      options?.onActivate?.();
      emit(THREAD_DRAG_START_EVENT, {
        payload,
        clientX: event.clientX,
        clientY: event.clientY,
      } satisfies ThreadDragStartDetail);
      // Suppress text selection + show grab cursor for the drag's duration.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
    }
    emit(THREAD_DRAG_MOVE_EVENT, {
      clientX: event.clientX,
      clientY: event.clientY,
    } satisfies ThreadDragMoveDetail);
  };

  const finish = (event: PointerEvent | null, cancelled: boolean) => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('pointermove', handleMove);
    document.removeEventListener('pointerup', handleUp);
    document.removeEventListener('pointercancel', handleCancel);
    document.removeEventListener('keydown', handleKey, true);
    if (!active) return;
    activePayload = null;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (cancelled || !event) {
      emit(THREAD_DRAG_CANCEL_EVENT, null);
      return;
    }
    emit(THREAD_DRAG_END_EVENT, {
      clientX: event.clientX,
      clientY: event.clientY,
    } satisfies ThreadDragEndDetail);
  };

  const handleUp = (event: PointerEvent) => finish(event, false);
  const handleCancel = () => finish(null, true);
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      finish(null, true);
    }
  };

  document.addEventListener('pointermove', handleMove);
  document.addEventListener('pointerup', handleUp);
  document.addEventListener('pointercancel', handleCancel);
  document.addEventListener('keydown', handleKey, true);

  return () => finish(null, true);
}
