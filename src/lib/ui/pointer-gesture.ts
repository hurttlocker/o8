'use client';

export interface GesturePoint { clientX: number; clientY: number; pointerId?: number }

/** One owned pointer gesture. Release outside the source still reaches its owner. */
export function trackPointerGesture(source: HTMLElement | undefined, down: GesturePoint, options: {
  threshold?: number;
  cursor?: string;
  onStart?: () => void;
  onMove: (point: GesturePoint) => void;
  onEnd: (point: GesturePoint) => void;
  onCancel?: () => void;
}): () => void {
  let active = false;
  let disposed = false;
  const cursor = document.body.style.cursor;
  const selection = document.body.style.userSelect;
  const owned = (event: PointerEvent) => down.pointerId === undefined || event.pointerId === down.pointerId;
  const move = (event: PointerEvent) => {
    if (disposed || !owned(event)) return;
    if (!active) {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < (options.threshold ?? 6)) return;
      active = true;
      document.body.style.cursor = options.cursor ?? 'grabbing';
      document.body.style.userSelect = 'none';
      options.onStart?.();
    }
    event.preventDefault();
    options.onMove(event);
  };
  const finish = (event?: PointerEvent) => {
    if (disposed || event && !owned(event)) return;
    disposed = true;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancelPointer);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
    source?.removeEventListener('lostpointercapture', cancelPointer);
    if (down.pointerId !== undefined && source?.hasPointerCapture?.(down.pointerId)) source.releasePointerCapture(down.pointerId);
    if (!active) return;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = selection;
    if (event) options.onEnd(event); else options.onCancel?.();
  };
  const up = (event: PointerEvent) => finish(event);
  const cancel = () => finish();
  const cancelPointer = (event: PointerEvent) => { if (owned(event)) finish(); };
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); finish();
  };
  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancelPointer);
  document.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
  source?.addEventListener('lostpointercapture', cancelPointer);
  if (down.pointerId !== undefined) source?.setPointerCapture?.(down.pointerId);
  return cancel;
}
