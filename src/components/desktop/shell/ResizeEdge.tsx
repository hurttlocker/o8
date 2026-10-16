'use client';

import { useEffect, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { useReducedMotion } from 'framer-motion';

/** A generous resize target with a quiet, one-pixel boundary at rest. */
export function ResizeEdge({ orientation = 'vertical', dragging: controlledDragging, glowStyle, hitSlop = 0, style, onMouseDown, onPointerDown, onMouseEnter, onMouseLeave, onFocus, onBlur, ...props }: HTMLAttributes<HTMLDivElement> & {
  orientation?: 'vertical' | 'horizontal';
  dragging?: boolean;
  glowStyle?: CSSProperties;
  hitSlop?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (!dragging) return;
    const finish = () => setDragging(false);
    document.addEventListener('mouseup', finish);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    return () => {
      document.removeEventListener('mouseup', finish);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
    };
  }, [dragging]);
  const vertical = orientation === 'vertical';
  return <div role="separator" tabIndex={0} aria-orientation={orientation} {...props}
    onMouseDown={(event) => { if (event.button === 0) setDragging(true); onMouseDown?.(event); }}
    onPointerDown={(event) => { if (event.button === 0) setDragging(true); onPointerDown?.(event); }}
    onMouseEnter={(event) => { setHovered(true); onMouseEnter?.(event); }}
    onMouseLeave={(event) => { setHovered(false); onMouseLeave?.(event); }}
    onFocus={(event) => { setFocused(true); onFocus?.(event); }}
    onBlur={(event) => { setFocused(false); onBlur?.(event); }}
    style={{ position: 'relative', flexShrink: 0, cursor: vertical ? 'col-resize' : 'row-resize', outline: 'none', touchAction: 'none', zIndex: 10, ...style }}>
    {hitSlop > 0 ? <span aria-hidden style={{ position: 'absolute', ...(vertical ? { top: 0, bottom: 0, left: -hitSlop, right: -hitSlop } : { left: 0, right: 0, top: -hitSlop, bottom: -hitSlop }), background: 'transparent' }} /> : null}
    <span aria-hidden data-resize-glow style={{ position: 'absolute', pointerEvents: 'none',
      ...(vertical ? { top: 0, bottom: 0, left: '50%', width: 1, transform: 'translateX(-0.5px)' } : { left: 0, right: 0, top: '50%', height: 1, transform: 'translateY(-0.5px)' }),
      ...glowStyle, background: 'var(--t-accent)', boxShadow: '0 0 8px var(--t-accent)',
      opacity: hovered || focused || (controlledDragging ?? dragging) ? 0.85 : 0,
      transition: reducedMotion ? 'none' : 'opacity 150ms ease',
    }} />
  </div>;
}
