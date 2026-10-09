'use client';

import type { ReactNode } from 'react';

export function FavoriteGlyph({ filled = false }: { filled?: boolean }) {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9L12 3Z" /></svg>;
}

export function ModelPickerRow({ label, detail, selected, disabled, highlighted, favorite, onFavorite, onSelect, testId, title, leading, badge }: {
  label: string;
  detail?: string;
  selected: boolean;
  disabled?: boolean;
  highlighted?: boolean;
  favorite?: boolean;
  onFavorite?: () => void;
  onSelect: () => void;
  testId?: string;
  title?: string;
  leading?: ReactNode;
  badge?: ReactNode;
}) {
  return <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, borderRadius: 8, background: selected || highlighted ? 'var(--t-hover)' : 'transparent' }}
    onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
    onMouseLeave={(event) => { event.currentTarget.style.background = selected || highlighted ? 'var(--t-hover)' : 'transparent'; }}>
    <button type="button" data-model-choice data-testid={testId} title={title} aria-pressed={selected} disabled={disabled} onClick={onSelect}
      style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 8, minWidth: 0, minHeight: detail ? 38 : 32, paddingTop: 6, paddingRight: 4, paddingBottom: 6, paddingLeft: 8, borderWidth: 0, borderRadius: 8, background: 'transparent', color: 'var(--t-text)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, fontFamily: 'var(--font-sans-system)', fontWeight: 300, textAlign: 'left' }}>
      {leading}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 12.5, lineHeight: 1.3 }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>{badge}</span>
        {detail ? <span style={{ display: 'block', fontSize: 10, lineHeight: 1.4, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span> : null}
      </span>
      {selected ? <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--t-accent)" strokeWidth={2} aria-hidden style={{ flexShrink: 0 }}><path d="m5 12 4 4L19 6" /></svg> : null}
    </button>
    {onFavorite ? <button type="button" aria-label={`${favorite ? 'Unfavorite' : 'Favorite'} ${label}`} aria-pressed={favorite} onClick={onFavorite}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 30, flexShrink: 0, padding: 0, borderWidth: 0, borderRadius: 7, background: 'transparent', color: favorite ? 'var(--t-accent)' : 'var(--t-text-muted)', cursor: 'pointer' }}><FavoriteGlyph filled={favorite} /></button> : null}
  </div>;
}
