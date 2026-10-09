'use client';
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useChromeTooltip } from '../title-bar/chrome-tooltip';

/** One hit area and state treatment for compact usage controls. */
export function UsageControl({ selected = false, children, style, description, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean; children: ReactNode; description?: string;
}) {
  const [hover, setHover] = useState(false); const [focus, setFocus] = useState(false); const [pressed, setPressed] = useState(false);
  const tip = useChromeTooltip({ label: description ?? '' });
  return <><button {...props} ref={description ? tip.ref : undefined}
    onMouseEnter={description ? tip.handlers.onMouseEnter : undefined} onMouseLeave={description ? tip.handlers.onMouseLeave : undefined} type="button" onPointerEnter={() => setHover(true)} onPointerLeave={() => { setHover(false); setPressed(false); }}
    onFocus={() => { setFocus(true); if (description) tip.handlers.onFocus(); }} onBlur={() => { setFocus(false); setPressed(false); tip.close(); }}
    onPointerDown={() => setPressed(true)} onPointerUp={() => setPressed(false)}
    style={{ border: 0, borderRadius: 7, height: 28, paddingLeft: 10, paddingRight: 10, display: 'inline-flex', gap: 6,
      alignItems: 'center', justifyContent: 'center', font: 'inherit', fontSize: 12, whiteSpace: 'nowrap',
      color: selected || hover ? 'var(--t-text)' : 'var(--t-text-secondary)',
      background: selected || (hover && !props.disabled) ? 'var(--t-input-bg)' : 'transparent',
      outline: focus ? '1px solid var(--t-accent)' : 'none', outlineOffset: 2,
      opacity: props.disabled ? 0.5 : 1, cursor: props.disabled ? 'wait' : 'pointer',
      transform: pressed && !props.disabled ? 'scale(0.97)' : undefined, ...style }}>{children}</button>{description ? tip.tooltip : null}</>;
}
