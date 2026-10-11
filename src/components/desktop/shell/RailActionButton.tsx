'use client';

import { forwardRef, useState, type ButtonHTMLAttributes } from 'react';
import { useChromeTooltip } from '../title-bar/chrome-tooltip';

/** A steady target, a quiet icon glow and a readable label beside the rail. */
export const RailActionButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltipLabel?: string | null;
}>(function RailActionButton({ tooltipLabel, children, style, onMouseEnter, onMouseLeave, onFocus, onBlur, onClick, onDragStart, ...props }, forwardedRef) {
  const [highlighted, setHighlighted] = useState(false);
  const label = tooltipLabel === null ? '' : tooltipLabel ?? props['aria-label'] ?? '';
  const { ref, handlers, tooltip, close } = useChromeTooltip({ label, side: 'right' });
  return <>
    <button {...props} ref={node => {
      ref.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }} data-rail-action={props['aria-label']}
      onMouseEnter={event => { setHighlighted(true); if (label) handlers.onMouseEnter(); onMouseEnter?.(event); }}
      onMouseLeave={event => { setHighlighted(false); close(); onMouseLeave?.(event); }}
      onFocus={event => { setHighlighted(true); if (label) handlers.onFocus(); onFocus?.(event); }}
      onBlur={event => { setHighlighted(false); close(); onBlur?.(event); }}
      onClick={event => { close(); onClick?.(event); }}
      onDragStart={event => { setHighlighted(false); close(); onDragStart?.(event); }}
      style={{ ...style, background: highlighted ? 'var(--t-hover)' : style?.background,
        transition: 'background-color 160ms ease-out' }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        filter: highlighted ? 'drop-shadow(0 0 5px color-mix(in srgb, var(--t-accent) 55%, transparent))' : 'none',
        transition: 'filter 160ms ease-out' }}>{children}</span>
    </button>
    {tooltip}
  </>;
});
