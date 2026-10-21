'use client';

import { memo, useId } from 'react';
import { PrLabel } from './PrLabel';
import { PrMarkdown } from './PrMarkdown';
import { ChevronDown, ChevronRight, ExternalLink } from '../lucide-shims';
import type { PrDetail } from './types';

export const PrSummary = memo(function PrSummary({ detail, descriptionOpen, onToggleDescription, onOpenFile }: {
  detail: PrDetail; descriptionOpen: boolean; onToggleDescription: () => void; onOpenFile: (path: string) => void;
}) {
  const id = useId();
  return <div style={{ paddingTop: 18, paddingRight: 18, paddingBottom: 24, paddingLeft: 18, fontSize: 12 }}>
    <dl style={{ display: 'grid', gridTemplateColumns: '80px minmax(0, 1fr)', gap: 14, marginTop: 0, marginRight: 0, marginBottom: 22, marginLeft: 0 }}>
      <dt style={{ color: 'var(--t-text-muted)' }}>Reviewers</dt><dd style={{ margin: 0, color: 'var(--t-text-secondary)' }}>{detail.requestedReviewers === undefined ? 'Not available' : detail.requestedReviewers.join(', ') || 'None requested'}</dd>
      <dt style={{ color: 'var(--t-text-muted)' }}>Labels</dt><dd style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: 0 }}>{detail.labels?.length ? detail.labels.map((label) => <PrLabel key={label} label={label} />) : <span style={{ color: 'var(--t-text-muted)' }}>{detail.labels === undefined ? 'Not available' : 'None'}</span>}</dd>
    </dl>
    <button type="button" aria-expanded={descriptionOpen} aria-controls={id} onClick={onToggleDescription} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 28, padding: 0, border: 0, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', marginBottom: 12 }}>{descriptionOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}Description</button>
    <div id={id} hidden={!descriptionOpen} style={{ overflowWrap: 'anywhere' }}>
      {detail.body.trim() ? <PrMarkdown text={detail.body} detail={detail} onOpenFile={onOpenFile} /> : <p style={{ color: 'var(--t-text-muted)', lineHeight: 1.6 }}>No description provided.</p>}
    </div>
    <a href={`${detail.url}/commits`} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 16, color: 'var(--t-accent)', textDecoration: 'none', fontSize: 11 }}>View commits on GitHub <ExternalLink size={11} aria-hidden="true" /></a>
  </div>;
});
