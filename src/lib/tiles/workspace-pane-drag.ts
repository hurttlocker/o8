'use client';

import type { WorkspaceTabDragKind } from './workspace-tab-drag';

export const WORKSPACE_PANE_DRAG_EVENT = 'o8:workspace-pane-drag';

export interface WorkspacePaneDrag {
  phase: 'move' | 'drop' | 'cancel';
  kind: WorkspaceTabDragKind;
  clientX: number;
  clientY: number;
}

let activeDrag: WorkspacePaneDrag | null = null;

export function getActiveWorkspacePaneDrag(): WorkspacePaneDrag | null {
  return activeDrag;
}

/** Pointer capture keeps rail drags continuous across embedded browser surfaces. */
export function trackWorkspacePaneDrag(
  source: HTMLElement,
  down: { clientX: number; clientY: number; pointerId: number },
  kind: WorkspaceTabDragKind,
  onActivate: () => void,
): () => void {
  if (activeDrag) return () => {};
  let active = false;
  let disposed = false;
  const previousCursor = document.body.style.cursor;
  const previousSelection = document.body.style.userSelect;
  const emit = (phase: WorkspacePaneDrag['phase'], clientX: number, clientY: number) => {
    const detail = { phase, kind, clientX, clientY };
    activeDrag = phase === 'move' ? detail : null;
    window.dispatchEvent(new CustomEvent(WORKSPACE_PANE_DRAG_EVENT, { detail }));
  };
  const move = (event: PointerEvent) => {
    if (disposed || event.pointerId !== down.pointerId) return;
    if (!active) {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < 6 || activeDrag) return;
      active = true;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      onActivate();
    }
    event.preventDefault();
    emit('move', event.clientX, event.clientY);
  };
  const finish = (event?: PointerEvent) => {
    if (disposed || event && event.pointerId !== down.pointerId) return;
    disposed = true;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancelPointer);
    document.removeEventListener('keydown', key, true);
    source.removeEventListener('lostpointercapture', cancelPointer);
    window.removeEventListener('blur', cancel);
    if (source.hasPointerCapture?.(down.pointerId)) source.releasePointerCapture(down.pointerId);
    if (!active) return;
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousSelection;
    emit(event ? 'drop' : 'cancel', event?.clientX ?? down.clientX, event?.clientY ?? down.clientY);
  };
  const up = (event: PointerEvent) => finish(event);
  const cancel = () => finish();
  const cancelPointer = (event: PointerEvent) => { if (event.pointerId === down.pointerId) finish(); };
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  };
  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancelPointer);
  document.addEventListener('keydown', key, true);
  source.addEventListener('lostpointercapture', cancelPointer);
  window.addEventListener('blur', cancel);
  source.setPointerCapture?.(down.pointerId);
  return cancel;
}
