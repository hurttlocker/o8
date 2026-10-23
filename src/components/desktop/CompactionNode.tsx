'use client';

import { useId, useState } from 'react';
import type { CompactionTrigger } from '@/lib/runtimes/compaction-detector';

interface CompactionNodeProps {
  compactedCount?: number;
  summary?: string;
  trigger?: CompactionTrigger;
  tokensBefore?: number;
  tokensAfter?: number;
  timestampLabel?: string;
}

function readMeta(summary: string | undefined, field: string) {
  return summary?.match(new RegExp(`${field}="([^"]+)"`, 'i'))?.[1];
}

function formatTokens(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value));
}

export function CompactionNode({ compactedCount, summary, trigger, tokensBefore, tokensAfter, timestampLabel }: CompactionNodeProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const detailsId = useId();
  const turns = readMeta(summary, 'turns');
  const count = turns && /^\d+$/.test(turns) ? Number(turns) : compactedCount;
  const stamp = readMeta(summary, 'at') ?? timestampLabel;
  const time = stamp?.match(/\b\d{1,2}:\d{2}(?:\s*[ap]m)?\b/i)?.[0];
  const label = ['Context compacted', typeof count === 'number' && Number.isFinite(count) && count >= 0 ? `${count} turn${count === 1 ? '' : 's'}` : null, time].filter(Boolean).join(' · ');
  const displaySummary = (summary ?? '').replace(/<\/?compacted_context\b[^>]*>/gi, '').trim();
  const before = formatTokens(tokensBefore);
  const after = formatTokens(tokensAfter);
  const hasDetails = Boolean(displaySummary || before || after || timestampLabel || trigger);
  const metadata = [trigger ? `${trigger === 'manual' ? 'Manual' : trigger === 'auto' ? 'Automatic' : 'Detected'} compaction` : null,
    before || after ? `${before ?? '—'} → ${after ?? '—'} tokens` : null].filter(Boolean).join(' · ');

  return <div data-compaction-divider style={{ width: '100%', minWidth: 0, paddingTop: 8, paddingBottom: 8 }}>
    <button type="button" onClick={() => { if (hasDetails) setIsExpanded(value => !value); }}
      aria-expanded={hasDetails ? isExpanded : undefined} aria-controls={isExpanded && hasDetails ? detailsId : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 28, border: 0,
        paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
        background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 12,
        fontWeight: 300, lineHeight: 1.5, textAlign: 'left', cursor: hasDetails ? 'pointer' : 'default' }}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
      <span aria-hidden="true" style={{ height: 1, minWidth: 8, flex: 1, background: 'var(--t-divider-subtle)' }} />
      <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: hasDetails ? 1 : 0.45, transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
    {isExpanded && hasDetails ? <div id={detailsId} style={{ paddingTop: 8, paddingBottom: 8, color: 'var(--t-text-muted)',
      fontFamily: 'var(--font-sans-system)', fontSize: 13, fontWeight: 300, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
      {metadata ? <div style={{ marginBottom: displaySummary ? 8 : 0, fontSize: 11, color: 'var(--t-text-faint)' }}>{metadata}</div> : null}
      {displaySummary ? <div style={{ whiteSpace: 'pre-wrap' }}>{displaySummary}</div> : null}
    </div> : null}
  </div>;
}
