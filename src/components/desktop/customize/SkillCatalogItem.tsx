'use client';

import type { ReactNode } from 'react';

export function SkillCatalogItem({ title, subtitle, pill, expanded, onClick, children }: {
  title: string; subtitle: string; pill: string; expanded: boolean; onClick: () => void; children: ReactNode;
}) {
  return <div style={{ minWidth: 0, gridColumn: expanded ? '1 / -1' : undefined }}>
    <div role="button" tabIndex={0} aria-expanded={expanded} onClick={onClick} onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); }
    }} style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 88, cursor: 'pointer', borderRadius: 10, paddingLeft: 12, paddingRight: 12, background: expanded ? 'var(--t-hover)' : 'transparent' }}>
      <svg aria-hidden="true" width="36" height="36" viewBox="0 0 36 36" style={{ flexShrink: 0, borderRadius: 9, background: 'var(--t-hover)', color: 'var(--t-accent)' }} fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m18 8 9 5v10l-9 5-9-5V13zM9 13l9 5 9-5M18 18v10" /></svg>
      <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 14, color: 'var(--t-text)' }}>{title}</span><span style={{ display: 'block', marginTop: 7, fontSize: 12, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span></span>
      <span style={{ fontSize: 11, color: 'var(--t-text-muted)', flexShrink: 0 }}>{pill}</span>
    </div>
    {expanded ? <div style={{ paddingTop: 18, paddingRight: 18, paddingBottom: 22, paddingLeft: 18, borderBottom: '1px solid var(--t-divider-subtle)', overflowWrap: 'anywhere' }}>{children}</div> : null}
  </div>;
}
