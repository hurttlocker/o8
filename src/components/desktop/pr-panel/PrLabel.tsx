import type { CSSProperties } from 'react';

export function PrLabel({ label }: { label: string }) {
  const size = /^size\/(XS|S|M|L|XL|XXL)$/i.exec(label)?.[1].toUpperCase();
  const tone = size === 'XS' || size === 'S' ? 'var(--t-success)' : size === 'M' ? 'var(--t-warning)' : size === 'L' ? 'var(--t-brand-orange, var(--t-warning))' : size ? 'var(--t-danger)' : null;
  const style: CSSProperties = {
    borderRadius: 5, fontSize: 11, lineHeight: '16px',
    paddingTop: 1, paddingRight: 6, paddingBottom: 1, paddingLeft: 6,
    background: tone ? `color-mix(in srgb, ${tone} 12%, transparent)` : 'var(--t-hover)',
    color: tone || 'var(--t-text-secondary)',
  };
  return <span style={style}>{label}</span>;
}
