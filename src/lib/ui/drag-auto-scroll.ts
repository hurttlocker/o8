import type { GesturePoint } from './pointer-gesture';

/** Scroll the hovered overflow surface while a captured pointer rests at its edge. */
export function createDragAutoScroll(axis: 'x' | 'y', onScroll: (point: GesturePoint) => void, host?: HTMLElement | null) {
  let point: GesturePoint | null = null;
  let frame = 0;
  const tick = () => {
    frame = 0;
    if (!point) return;
    let node = host ?? document.elementFromPoint?.(point.clientX, point.clientY) as HTMLElement | null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const overflow = axis === 'x' ? style.overflowX : style.overflowY;
      const limit = axis === 'x' ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
      if (limit > 0 && /auto|scroll/.test(overflow)) {
        const rect = node.getBoundingClientRect();
        if (point.clientX < rect.left || point.clientX > rect.right || point.clientY < rect.top || point.clientY > rect.bottom) break;
        const position = axis === 'x' ? point.clientX : point.clientY;
        const start = axis === 'x' ? rect.left : rect.top;
        const end = axis === 'x' ? rect.right : rect.bottom;
        const speed = position < start + 28 ? -Math.min(12, (start + 28 - position) / 2)
          : position > end - 28 ? Math.min(12, (position - end + 28) / 2) : 0;
        const before = axis === 'x' ? node.scrollLeft : node.scrollTop;
        const after = Math.max(0, Math.min(limit, before + speed));
        if (before !== after) {
          if (axis === 'x') node.scrollLeft = after; else node.scrollTop = after;
          onScroll(point); frame = requestAnimationFrame(tick);
        }
        break;
      }
      if (host) break;
      node = node.parentElement;
    }
  };
  return {
    update(next: GesturePoint) { point = next; if (!frame) frame = requestAnimationFrame(tick); },
    stop() { point = null; if (frame) cancelAnimationFrame(frame); frame = 0; },
  };
}
